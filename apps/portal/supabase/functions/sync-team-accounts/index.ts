import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const AIRTABLE_API_KEY = Deno.env.get('AIRTABLE_API_KEY');
    const AIRTABLE_BASE_ID = Deno.env.get('AIRTABLE_TEAMS_BASE_ID') || Deno.env.get('AIRTABLE_BASE_ID');
    const AIRTABLE_TABLE = Deno.env.get('AIRTABLE_TEAMS_TABLE');
    const AIRTABLE_VIEW = Deno.env.get('AIRTABLE_TEAMS_VIEW');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE || !AIRTABLE_VIEW) {
      throw new Error('Missing Airtable configuration');
    }

    // Initialize Supabase client with service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log('Starting team accounts sync...');

    // Create sync log
    const { data: syncLog, error: syncLogError } = await supabase
      .from('tp_sync_logs')
      .insert({
        sync_type: 'team_accounts',
        status: 'in_progress',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (syncLogError) {
      console.error('Error creating sync log:', syncLogError);
    }

    const syncLogId = syncLog?.id;

    // Fetch teams from Airtable
    console.log('Fetching teams from Airtable...');
    const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?view=${encodeURIComponent(AIRTABLE_VIEW)}`;
    const airtableResponse = await fetch(airtableUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      },
    });

    if (!airtableResponse.ok) {
      throw new Error(`Airtable API error: ${airtableResponse.status}`);
    }

    const airtableData = await airtableResponse.json();
    const airtableTeams = airtableData.records;

    console.log(`Found ${airtableTeams.length} teams in Airtable`);

    // Fetch existing team leads from Supabase
    const { data: existingProfiles } = await supabase
      .from('tp_profiles')
      .select('id, user_id, email, team_id, initial_password')
      .not('email', 'is', null);

    const { data: existingRoles } = await supabase
      .from('tp_user_roles')
      .select('user_id, role')
      .eq('role', 'team_lead');

    const existingTeamLeadEmails = new Set(
      existingProfiles
        ?.filter(p => existingRoles?.some(r => r.user_id === p.user_id))
        ?.map(p => p.email?.toLowerCase()) || []
    );

    console.log(`Found ${existingTeamLeadEmails.size} existing team leads`);

    const airtableTeamEmails = new Set<string>();
    const results = {
      created: 0,
      errors: 0,
      no_email: 0,
      already_exists: 0,
    };

    // Process each Airtable team
    for (const record of airtableTeams) {
      const fields = record.fields;
      // Use the same email field logic as sync-airtable-teams
      const emailRaw = fields['Email'] || fields.email || fields['Team Email'] || null;
      const email = emailRaw?.trim().toLowerCase();
      const airtableId = record.id;
      
      // Use the same name field logic as sync-airtable-teams
      const teamName = fields['Team Name'] || fields['Full Name'] || fields.name || fields.Title || fields.title || 'Unnamed Team';

      if (!email) {
        console.log(`Team ${teamName} has no email, skipping account creation`);
        // Update team status in Supabase
        await supabase
          .from('tp_teams')
          .update({
            account_status: 'no_email',
            account_error: 'No email address provided',
          })
          .eq('airtable_id', airtableId);
        results.no_email++;
        continue;
      }

      airtableTeamEmails.add(email);

      if (existingTeamLeadEmails.has(email)) {
        console.log(`Team lead account already exists for ${email}`);
        results.already_exists++;
        continue;
      }

      try {
        console.log(`Creating account for team lead: ${email}`);

        // Generate password
        const password = generatePassword();

        // Create auth user
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            first_name: teamName.split(' ')[0] || 'Team',
            last_name: teamName.split(' ').slice(1).join(' ') || 'Lead',
          },
        });

        if (authError) {
          throw authError;
        }

        const userId = authData.user.id;
        console.log(`Created auth user for ${email}: ${userId}`);

        // Get team_id from teams table
        const { data: teamData } = await supabase
          .from('tp_teams')
          .select('id')
          .eq('airtable_id', airtableId)
          .single();

        // Профиль СОЗДАЁМ здесь (upsert), а не рассчитываем на триггер auth.users →
        // tp_handle_new_user: на общем портальном auth.users он намеренно не навешен.
        // Раньше был .update() — на отсутствующей строке это тихий no-op, из-за чего
        // терялся initial_password (пароль бригадира больше негде взять).
        const { error: profileError } = await supabase
          .from('tp_profiles')
          .upsert({
            user_id: userId,
            email,
            first_name: teamName.split(' ')[0] || 'Team',
            last_name: teamName.split(' ').slice(1).join(' ') || 'Lead',
            team_id: teamData?.id ?? null,
            initial_password: password,
          }, { onConflict: 'user_id' });

        if (profileError) {
          console.error(`Failed to upsert profile for ${email}:`, profileError);
          throw profileError;
        }

        // Assign team_lead role
        const { error: roleError } = await supabase
          .from('tp_user_roles')
          .insert({
            user_id: userId,
            role: 'team_lead',
          });

        if (roleError) {
          console.error(`Failed to assign role for ${email}:`, roleError);
          // Delete user if role assignment fails
          await supabase.auth.admin.deleteUser(userId);
          throw roleError;
        }

        // Update team status
        await supabase
          .from('tp_teams')
          .update({
            account_status: 'synced',
            account_error: null,
            account_synced_at: new Date().toISOString(),
          })
          .eq('airtable_id', airtableId);

        results.created++;
        console.log(`Successfully created account for ${email}`);
      } catch (error: any) {
        console.error(`Failed to create account for ${email}:`, error);

        // Update team status with error
        await supabase
          .from('tp_teams')
          .update({
            account_status: 'error',
            account_error: error.message || 'Failed to create account',
          })
          .eq('airtable_id', airtableId);

        results.errors++;
      }
    }

    // Delete accounts for teams no longer in Airtable
    const teamsToDelete = Array.from(existingTeamLeadEmails).filter(
      email => !airtableTeamEmails.has(email)
    );

    console.log(`Found ${teamsToDelete.length} team leads to delete`);

    for (const email of teamsToDelete) {
      try {
        const profile = existingProfiles?.find(p => p.email?.toLowerCase() === email);
        if (profile?.user_id) {
          console.log(`Deleting team lead account: ${email}`);
          await supabase.auth.admin.deleteUser(profile.user_id);
        }
      } catch (error: any) {
        console.error(`Failed to delete account for ${email}:`, error);
      }
    }

    console.log('Sync completed:', results);

    // Update sync log
    if (syncLogId) {
      await supabase
        .from('tp_sync_logs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          records_synced: results.created
        })
        .eq('id', syncLogId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        results,
        deleted: teamsToDelete.length,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Sync error:', error);
    
    // Update sync log with error
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // Try to update sync log if we have the ID
    try {
      const { data: latestLog } = await supabase
        .from('tp_sync_logs')
        .select('id')
        .eq('sync_type', 'team_accounts')
        .eq('status', 'in_progress')
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      if (latestLog) {
        await supabase
          .from('tp_sync_logs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: error.message
          })
          .eq('id', latestLog.id);
      }
    } catch (logError) {
      console.error('Failed to update sync log:', logError);
    }
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
