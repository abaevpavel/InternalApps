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

  try {
    console.log('Starting auto-sync for Projects and Teams...');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables are required');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const results = {
      projects: { success: false, synced: 0, error: null },
      teams: { success: false, synced: 0, error: null }
    };

    // Sync Projects
    try {
      console.log('Syncing projects...');
      const projectsResponse = await supabase.functions.invoke('sync-airtable-projects');
      
      if (projectsResponse.error) {
        throw projectsResponse.error;
      }
      
      results.projects.success = true;
      results.projects.synced = projectsResponse.data?.synced || 0;
      console.log(`Projects synced successfully: ${results.projects.synced}`);
    } catch (error) {
      console.error('Error syncing projects:', error);
      results.projects.error = error.message;
    }

    // Sync Teams
    try {
      console.log('Syncing teams...');
      const teamsResponse = await supabase.functions.invoke('sync-airtable-teams');
      
      if (teamsResponse.error) {
        throw teamsResponse.error;
      }
      
      results.teams.success = true;
      results.teams.synced = teamsResponse.data?.synced || 0;
      console.log(`Teams synced successfully: ${results.teams.synced}`);
    } catch (error) {
      console.error('Error syncing teams:', error);
      results.teams.error = error.message;
    }

    return new Response(
      JSON.stringify({
        message: 'Auto-sync completed',
        results
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Auto-sync error:', error);
    return new Response(
      JSON.stringify({
        error: error.message
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
