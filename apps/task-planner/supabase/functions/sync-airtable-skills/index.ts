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
    console.log('Starting Airtable skills sync...');
    
    // Get environment variables
    const airtableApiKey = Deno.env.get('AIRTABLE_API_KEY');
    const airtableBaseId = Deno.env.get('AIRTABLE_SKILLS_BASE_ID');
    const airtableTableName = Deno.env.get('AIRTABLE_SKILLS_TABLE');
    const airtableViewName = Deno.env.get('AIRTABLE_SKILLS_VIEW');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!airtableApiKey) {
      throw new Error('AIRTABLE_API_KEY environment variable is required');
    }

    if (!airtableBaseId) {
      throw new Error('AIRTABLE_SKILLS_BASE_ID environment variable is required');
    }

    if (!airtableTableName) {
      throw new Error('AIRTABLE_SKILLS_TABLE environment variable is required');
    }

    if (!airtableViewName) {
      throw new Error('AIRTABLE_SKILLS_VIEW environment variable is required');
    }

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables are required');
    }

    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Airtable configuration from environment variables - using Skills with Rating table
    const skillsWithRatingTable = 'Skills with Rating';
    const airtableUrl = `https://api.airtable.com/v0/${airtableBaseId}/${encodeURIComponent(skillsWithRatingTable)}`;

    console.log('Syncing skills from Airtable:');
    console.log('Base ID:', airtableBaseId);
    console.log('Table:', skillsWithRatingTable);
    console.log('Using Skills with Rating table');

    // Fetch all skills from Airtable with pagination
    let allRecords = [];
    let offset = null;
    
    do {
      const paginatedUrl = offset ? `${airtableUrl}?pageSize=100&offset=${offset}` : `${airtableUrl}?pageSize=100`;
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

    // Process and sync skills
    const syncedSkills = [];
    
    for (const record of allRecords) {
      const fields = record.fields;
      
      // Map Airtable fields from "Skills with Rating" table to our database schema
      const skillData = {
        name: (() => {
          // In "Skills with Rating" table, the main field is "Skill"
          const skillName = fields['Skill'] || fields['Skill Name'] || fields['Name'] || fields.name;
          if (skillName) {
            if (Array.isArray(skillName)) {
              return skillName[0] || 'Unnamed Skill';
            }
            return skillName;
          }
          
          return 'Unnamed Skill';
        })(),
        description: (() => {
          // Get crews information as description
          const crews = fields['Crews'] || fields['crews'];
          if (crews && Array.isArray(crews) && crews.length > 0) {
            return `Available teams: ${crews.join(', ')}`;
          }
          return null;
        })(),
        category: (() => {
          // Get skill category/rating
          const skillCategory = fields['Skill Category'] || fields['Category'] || fields['Rating'];
          if (skillCategory) {
            if (Array.isArray(skillCategory)) {
              return skillCategory[0]?.toString() || null;
            }
            return skillCategory?.toString() || null;
          }
          return null;
        })(),
      };

      console.log('Processing skill:', skillData.name);

      // Check if skill already exists by name (no airtable_id for skills table)
      const { data: existingSkill } = await supabase
        .from('skills')
        .select('id')
        .eq('name', skillData.name)
        .maybeSingle();

      if (existingSkill) {
        // Update existing skill with ALL fields to ensure changes from Airtable are reflected
        const { error: updateError } = await supabase
          .from('skills')
          .update({
            name: skillData.name,
            description: skillData.description,
            category: skillData.category,
          })
          .eq('id', existingSkill.id);

        if (updateError) {
          console.error('Error updating skill:', updateError);
        } else {
          console.log('Updated skill:', skillData.name);
          const crewsVal = fields['Crews'] ?? fields['crews'] ?? [];
          syncedSkills.push({
            airtable_id: record.id,
            name: skillData.name,
            raw_fields: { Crews: Array.isArray(crewsVal) ? crewsVal : (crewsVal ? [crewsVal] : []) }
          });
        }
      } else {
        // Insert new skill
        const { error: insertError } = await supabase
          .from('skills')
          .insert(skillData);

        if (insertError) {
          console.error('Error inserting skill:', insertError);
        } else {
          console.log('Inserted skill:', skillData.name);
          const crewsVal = fields['Crews'] ?? fields['crews'] ?? [];
          syncedSkills.push({
            airtable_id: record.id,
            name: skillData.name,
            raw_fields: { Crews: Array.isArray(crewsVal) ? crewsVal : (crewsVal ? [crewsVal] : []) }
          });
        }
      }
    }

    console.log('Sync completed. Skills processed:', syncedSkills.length);

    return new Response(JSON.stringify({ 
      message: 'Airtable skills sync completed successfully',
      synced: syncedSkills.length,
      skills: syncedSkills
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in sync-airtable-skills function:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: 'Check the function logs for more information'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});