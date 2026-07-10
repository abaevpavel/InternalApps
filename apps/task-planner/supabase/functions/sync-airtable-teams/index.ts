import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
      .from('sync_logs')
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

    // Process and sync teams
    const syncedTeams = [];
    
    for (const record of allRecords) {
      const fields = record.fields;
      
      // Log all available fields from the first record to help identify Slack ID field
      if (allRecords.indexOf(record) === 0) {
        console.log('First record fields:', JSON.stringify(fields, null, 2));
        console.log('Available field names:', Object.keys(fields));
      }
      
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

        console.log('Team data with slack_id:', teamData.name, 'slack_id:', teamData.slack_id);

        // Geocode address if it exists and coordinates are not already set
        let coordinates = null;
        if (teamData.address) {
          try {
            const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(teamData.address)}&key=${googleApiKey}`;
            const geocodeResponse = await fetch(geocodeUrl);
            const geocodeData = await geocodeResponse.json();
            
            if (geocodeData.status === 'OK' && geocodeData.results && geocodeData.results.length > 0) {
              const location = geocodeData.results[0].geometry.location;
              coordinates = {
                lat: location.lat,
                lng: location.lng
              };
              console.log('Geocoded address for team:', teamData.name, coordinates);
            }
          } catch (geocodeError) {
            console.warn('Failed to geocode address for team:', teamData.name, geocodeError);
          }
        }

      console.log('Processing team:', teamData.name);

      // Check if team already exists
      const { data: existingTeam } = await supabase
        .from('teams')
        .select('id, coordinates, latitude, longitude')
        .eq('airtable_id', record.id)
        .single();

      if (existingTeam) {
        // Update existing team
        // Only update coordinates if we got new ones or if team doesn't have coordinates yet
        const updateData = coordinates && (!existingTeam.latitude || !existingTeam.longitude)
          ? { 
              name: teamData.name,
              email: teamData.email,
              address: teamData.address,
              slack_id: teamData.slack_id,
              coordinates,
              latitude: coordinates.lat,
              longitude: coordinates.lng,
              updated_at: new Date().toISOString(),
            }
          : { 
              name: teamData.name,
              email: teamData.email,
              address: teamData.address,
              slack_id: teamData.slack_id,
              updated_at: new Date().toISOString(),
            };
            
        const { error: updateError } = await supabase
          .from('teams')
          .update(updateData)
          .eq('airtable_id', record.id);

        if (updateError) {
          console.error('Error updating team:', updateError);
        } else {
          console.log('Updated team:', teamData.name);
          syncedTeams.push({ 
            ...teamData, 
            latitude: coordinates?.lat || existingTeam.latitude,
            longitude: coordinates?.lng || existingTeam.longitude,
            action: 'updated' 
          });
        }
      } else {
        // Insert new team
        const insertData = coordinates
          ? { 
              ...teamData,
              slack_id: teamData.slack_id,
              coordinates,
              latitude: coordinates.lat,
              longitude: coordinates.lng,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : { 
              ...teamData,
              slack_id: teamData.slack_id,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            
        const { error: insertError } = await supabase
          .from('teams')
          .insert(insertData);

        if (insertError) {
          console.error('Error inserting team:', insertError);
        } else {
          console.log('Inserted team:', teamData.name);
          syncedTeams.push({ 
            ...teamData, 
            latitude: coordinates?.lat,
            longitude: coordinates?.lng,
            action: 'created' 
          });
        }
      }
    }

    // Clean up teams that are no longer in the Airtable view
    const syncedAirtableIds = allRecords.map(record => record.id);
    const { error: cleanupError } = await supabase
      .from('teams')
      .delete()
      .not('airtable_id', 'in', `(${syncedAirtableIds.map(id => `"${id}"`).join(',')})`);

    if (cleanupError) {
      console.error('Error cleaning up old teams:', cleanupError);
    } else {
      console.log('Cleaned up teams not in current Airtable view');
    }

    console.log('Sync completed. Teams processed:', syncedTeams.length);

    // Update sync log with success
    if (logId) {
      await supabase
        .from('sync_logs')
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
            .from('sync_logs')
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