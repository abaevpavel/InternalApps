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
    console.log('Starting Airtable sync...');
    
    // Get environment variables
    const airtableApiKey = Deno.env.get('AIRTABLE_API_KEY');
    const airtableBaseId = Deno.env.get('AIRTABLE_PROJECT_BASE_ID');
    const airtableTableName = Deno.env.get('AIRTABLE_PROJECT_TABLE');
    const airtableViewName = Deno.env.get('AIRTABLE_PROJECT_VIEW');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const googleApiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');

    if (!airtableApiKey) {
      throw new Error('AIRTABLE_API_KEY environment variable is required');
    }

    if (!airtableBaseId) {
      throw new Error('AIRTABLE_PROJECT_BASE_ID environment variable is required');
    }

    if (!airtableTableName) {
      throw new Error('AIRTABLE_PROJECT_TABLE environment variable is required');
    }

    if (!airtableViewName) {
      throw new Error('AIRTABLE_PROJECT_VIEW environment variable is required');
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
        sync_type: 'projects',
        started_at: startTime.toISOString(),
        status: 'in_progress'
      }])
      .select()
      .single();

    logId = logData?.id;

    // Airtable configuration from environment variables
    const airtableUrl = `https://api.airtable.com/v0/${airtableBaseId}/${encodeURIComponent(airtableTableName)}?view=${encodeURIComponent(airtableViewName)}`;

    console.log('Syncing projects from Airtable:');
    console.log('Base ID:', airtableBaseId);
    console.log('Table:', airtableTableName);
    console.log('View:', airtableViewName);

    // Fetch all projects from Airtable with pagination
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

    // Process and sync projects
    const syncedProjects = [];
    
    for (const record of allRecords) {
      const fields = record.fields;
      
      // Debug: Log all available field names
      console.log('Available Airtable fields:', Object.keys(fields).join(', '));
      
      // Map Airtable fields to our database schema
      const projectData = {
        airtable_id: record.id,
        name: (() => {
          const nameField = fields['Proj Name'] || fields.Name || fields.name || fields.Title || fields.title;
          if (Array.isArray(nameField)) {
            return nameField[0] || 'Unnamed Project';
          }
          return nameField || 'Unnamed Project';
        })(),
        address: fields['Full address'] || fields.Address || fields.address || fields.Location || fields.location || null,
        project_manager: fields['PM for Team management'] || fields['PM'] || fields['Project Manager'] || fields['project_manager'] || null,
        slack_id: fields['Slack id'] || fields['Slack Id'] || fields['slack id'] || fields['Slack ID'] || fields['Slack Channel ID'] || fields['SLACK_ID'] || fields.slack_id || null,
      };

      console.log('Project data with slack_id:', projectData.name, 'slack_id:', projectData.slack_id);

      // Geocode address if it exists and coordinates are not already set
      let coordinates = null;
      if (projectData.address) {
        try {
          const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(projectData.address)}&key=${googleApiKey}`;
          const geocodeResponse = await fetch(geocodeUrl);
          const geocodeData = await geocodeResponse.json();
          
          if (geocodeData.status === 'OK' && geocodeData.results && geocodeData.results.length > 0) {
            const location = geocodeData.results[0].geometry.location;
            coordinates = {
              lat: location.lat,
              lng: location.lng
            };
            console.log('Geocoded address for project:', projectData.name, coordinates);
          }
        } catch (geocodeError) {
          console.warn('Failed to geocode address for project:', projectData.name, geocodeError);
        }
      }

      console.log('Processing project:', projectData.name);

      // Check if project already exists
      const { data: existingProject } = await supabase
        .from('tp_projects')
        .select('id, coordinates, latitude, longitude')
        .eq('airtable_id', record.id)
        .single();

      if (existingProject) {
        // Update existing project
        // Only update coordinates if we got new ones or if project doesn't have coordinates yet
        const updateData = coordinates && (!existingProject.latitude || !existingProject.longitude)
          ? { 
              name: projectData.name,
              address: projectData.address,
              coordinates,
              latitude: coordinates.lat,
              longitude: coordinates.lng,
              project_manager: projectData.project_manager,
              slack_id: projectData.slack_id,
              is_active: true,
              updated_at: new Date().toISOString(),
            }
          : { 
              name: projectData.name,
              address: projectData.address,
              project_manager: projectData.project_manager,
              slack_id: projectData.slack_id,
              is_active: true,
              updated_at: new Date().toISOString(),
            };
            
        const { error: updateError } = await supabase
          .from('tp_projects')
          .update(updateData)
          .eq('airtable_id', record.id);

        if (updateError) {
          console.error('Error updating project:', updateError);
        } else {
          console.log('Updated project:', projectData.name);
          syncedProjects.push({ ...projectData, action: 'updated' });
        }
      } else {
        // Insert new project
        const insertData = coordinates
          ? { 
              ...projectData, 
              coordinates,
              latitude: coordinates.lat,
              longitude: coordinates.lng,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : { 
              ...projectData,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            
        const { error: insertError } = await supabase
          .from('tp_projects')
          .insert(insertData);

        if (insertError) {
          console.error('Error inserting project:', insertError);
        } else {
          console.log('Inserted project:', projectData.name);
          syncedProjects.push({ ...projectData, action: 'created' });
        }
      }
    }

    // Mark projects as inactive that are no longer in the Airtable view
    const syncedAirtableIds = allRecords.map(record => record.id);
    const { error: deactivateError } = await supabase
      .from('tp_projects')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .not('airtable_id', 'in', `(${syncedAirtableIds.map(id => `"${id}"`).join(',')})`)
      .eq('is_active', true);

    if (deactivateError) {
      console.error('Error deactivating old projects:', deactivateError);
    } else {
      console.log('Deactivated projects not in current Airtable view');
    }

    console.log('Sync completed. Projects processed:', syncedProjects.length);

    // Update sync log with success
    if (logId) {
      await supabase
        .from('tp_sync_logs')
        .update({
          completed_at: new Date().toISOString(),
          status: 'completed',
          records_synced: syncedProjects.length
        })
        .eq('id', logId);
    }

    return new Response(JSON.stringify({ 
      message: 'Airtable sync completed successfully',
      synced: syncedProjects.length,
      projects: syncedProjects
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in sync-airtable-projects function:', error);
    
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