import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Значение из Airtable совпадает с тем, что лежит в базе (пустое = null). */
function sameValue(stored: unknown, incoming: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v : JSON.stringify(v));
  return norm(stored) === norm(incoming);
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Create sync log entry
  let logId: string | null = null;
  const startTime = new Date();

  try {
    console.log('Starting Airtable teams sync...');
    
    // Get environment variables
    const airtableApiKey = Deno.env.get('AIRTABLE_API_KEY');
    const airtableBaseId = Deno.env.get('AIRTABLE_TEAM_BASE_ID');
    const airtableTableName = Deno.env.get('AIRTABLE_TEAMS_TABLE');
    const airtableViewName = Deno.env.get('AIRTABLE_TEAMS_VIEW');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    // Раньше ключ не объявлялся: геокодинг падал в catch, и координаты бригад синк не обновлял.
    const googleApiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');

    if (!airtableApiKey) {
      throw new Error('AIRTABLE_API_KEY environment variable is required');
    }

    if (!airtableBaseId) {
      throw new Error('AIRTABLE_TEAM_BASE_ID environment variable is required');
    }

    if (!airtableTableName) {
      throw new Error('AIRTABLE_TEAMS_TABLE environment variable is required');
    }

    if (!airtableViewName) {
      throw new Error('AIRTABLE_TEAMS_VIEW environment variable is required');
    }

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables are required');
    }

    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Create initial sync log
    const { data: logData } = await supabase
      .from('tp_sync_logs')
      .insert([{
        sync_type: 'teams',
        started_at: startTime.toISOString(),
        status: 'in_progress'
      }])
      .select()
      .single();

    logId = logData?.id;

    // Airtable configuration from environment variables
    const airtableUrl = `https://api.airtable.com/v0/${airtableBaseId}/${encodeURIComponent(airtableTableName)}?view=${encodeURIComponent(airtableViewName)}`;

    console.log('Syncing teams from Airtable:');
    console.log('Base ID:', airtableBaseId);
    console.log('Table:', airtableTableName);
    console.log('View:', airtableViewName);

    // Fetch all teams from Airtable with pagination
    let allRecords = [];
    let offset = null;
    
    do {
      const paginatedUrl = offset ? `${airtableUrl}&offset=${offset}` : airtableUrl;
      console.log('Fetching page:', paginatedUrl);
      
      const airtableResponse = await fetch(paginatedUrl, {
        headers: {
          'Authorization': `Bearer ${airtableApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!airtableResponse.ok) {
        const errorText = await airtableResponse.text();
        console.error('Airtable API error:', errorText);
        throw new Error(`Airtable API error: ${airtableResponse.status} - ${errorText}`);
      }

      const airtableData = await airtableResponse.json();
      console.log('Fetched records from page:', airtableData.records?.length || 0);
      
      if (airtableData.records && airtableData.records.length > 0) {
        allRecords = allRecords.concat(airtableData.records);
      }
      
      offset = airtableData.offset;
    } while (offset);

    console.log('Total records fetched from Airtable:', allRecords.length);

    if (allRecords.length === 0) {
      return new Response(JSON.stringify({ 
        message: 'No records found in Airtable view',
        synced: 0 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Пишем только разницу (как в sync-airtable-projects): текущие бригады — одним запросом,
    // запись трогаем, только если поле поменялось, геокодим только новый/изменённый адрес
    // или бригаду без координат.
    const { data: existingRows, error: existingError } = await supabase
      .from('tp_teams')
      .select('id, airtable_id, name, email, address, slack_id, latitude, longitude, is_active');
    if (existingError) throw existingError;
    const byAirtableId = new Map((existingRows ?? []).filter((r) => r.airtable_id).map((r) => [r.airtable_id, r]));

    const geocode = async (address: string, label: string) => {
      try {
        const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${googleApiKey}`;
        const geocodeData = await (await fetch(geocodeUrl)).json();
        if (geocodeData.status === 'OK' && geocodeData.results?.length > 0) {
          const { lat, lng } = geocodeData.results[0].geometry.location;
          return { lat, lng };
        }
        console.warn('Geocoding returned no result for team:', label, geocodeData.status);
      } catch (geocodeError) {
        console.warn('Failed to geocode address for team:', label, geocodeError);
      }
      return null;
    };

    const syncedTeams = [];
    let unchanged = 0;

    for (const record of allRecords) {
      const fields = record.fields;

      // Map Airtable fields to our database schema
      const teamData = {
        airtable_id: record.id,
        name: (() => {
          // Try single name fields first
          const singleNameField = fields['Team Name'] || fields['Full Name'] || fields.name || fields.Title || fields.title;
          if (singleNameField) {
            if (Array.isArray(singleNameField)) {
              return singleNameField[0] || 'Unnamed Team';
            }
            return singleNameField;
          }

          // Try combining two fields (F_name + L_name, etc.)
          const firstName = fields['F_name'] || fields['First Name'] || fields.firstName || fields['first_name'];
          const lastName = fields['L_name'] || fields['Last Name'] || fields.lastName || fields['last_name'];

          if (firstName || lastName) {
            const combinedName = [firstName, lastName].filter(Boolean).join(' ').trim();
            return combinedName || 'Unnamed Team';
          }

          return 'Unnamed Team';
        })(),
        email: fields['Email'] || fields.email || fields['Team Email'] || null,
        address: fields['Address'] || fields.address || fields['Team Address'] || fields['Location'] || fields.location || null,
        slack_id: fields['Slack user ID'] || fields['Slack ID'] || fields.slack_id || null,
      };

      const existing = byAirtableId.get(record.id);

      if (!existing) {
        const coordinates = teamData.address ? await geocode(teamData.address, teamData.name) : null;
        const now = new Date().toISOString();
        const { error: insertError } = await supabase
          .from('tp_teams')
          .insert({
            ...teamData,
            ...(coordinates ? { coordinates, latitude: coordinates.lat, longitude: coordinates.lng } : {}),
            created_at: now,
            updated_at: now,
          });

        if (insertError) {
          console.error('Error inserting team:', teamData.name, insertError);
        } else {
          console.log('Inserted team:', teamData.name);
          syncedTeams.push({ ...teamData, latitude: coordinates?.lat, longitude: coordinates?.lng, action: 'created' });
        }
        continue;
      }

      const changes: Record<string, unknown> = {};
      for (const key of ['name', 'email', 'address', 'slack_id'] as const) {
        if (sameValue(existing[key], teamData[key])) continue;
        changes[key] = teamData[key];
      }
      // Вернулась в представление Airtable — снова активна.
      if (existing.is_active === false) changes.is_active = true;

      if (teamData.address && ('address' in changes || existing.latitude == null || existing.longitude == null)) {
        const coordinates = await geocode(teamData.address, teamData.name);
        if (coordinates) Object.assign(changes, { coordinates, latitude: coordinates.lat, longitude: coordinates.lng });
      }

      if (Object.keys(changes).length === 0) {
        unchanged++;
        continue;
      }

      const { error: updateError } = await supabase
        .from('tp_teams')
        .update({ ...changes, updated_at: new Date().toISOString() })
        .eq('id', existing.id);

      if (updateError) {
        console.error('Error updating team:', teamData.name, updateError);
      } else {
        console.log('Updated team:', teamData.name, Object.keys(changes).join(', '));
        syncedTeams.push({
          ...teamData,
          latitude: (changes.latitude as number | undefined) ?? existing.latitude,
          longitude: (changes.longitude as number | undefined) ?? existing.longitude,
          action: 'updated',
          changed: Object.keys(changes),
        });
      }
    }

    // Бригады, которых больше нет в представлении Airtable, — неактивны (миграция 0037).
    // Раньше удалялись: задачи оставались со ссылкой в никуда, доступность пропадала.
    const syncedAirtableIds = allRecords.map(record => record.id);
    const { data: deactivated, error: deactivateError } = await supabase
      .from('tp_teams')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .not('airtable_id', 'in', `(${syncedAirtableIds.map(id => `"${id}"`).join(',')})`)
      .eq('is_active', true)
      .select('id');

    if (deactivateError) {
      console.error('Error deactivating old teams:', deactivateError);
    } else {
      console.log('Deactivated teams not in current Airtable view:', deactivated?.length ?? 0);
    }

    console.log('Sync completed. Written:', syncedTeams.length, 'unchanged:', unchanged);

    // Update sync log with success
    if (logId) {
      await supabase
        .from('tp_sync_logs')
        .update({
          completed_at: new Date().toISOString(),
          status: 'completed',
          records_synced: syncedTeams.length
        })
        .eq('id', logId);
    }

    return new Response(JSON.stringify({ 
      message: 'Airtable teams sync completed successfully',
      synced: syncedTeams.length,
      fetched: allRecords.length,
      unchanged,
      deactivated: deactivated?.length ?? 0,
      teams: syncedTeams
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in sync-airtable-teams function:', error);
    
    // Update sync log with error
    if (logId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (supabaseUrl && supabaseKey) {
          const supabase = createClient(supabaseUrl, supabaseKey);
          await supabase
            .from('tp_sync_logs')
            .update({
              completed_at: new Date().toISOString(),
              status: 'failed',
              error_message: error.message
            })
            .eq('id', logId);
        }
      } catch (logError) {
        console.error('Error updating sync log:', logError);
      }
    }
    
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Check the function logs for more information'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});