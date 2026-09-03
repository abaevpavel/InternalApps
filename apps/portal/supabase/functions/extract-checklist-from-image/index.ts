import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CALLER_SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const CALLER_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

/** base64url → строка. */
function b64url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

/**
 * SEC-9: за запросом должен стоять залогиненный человек.
 *
 * Функция вставляет строки под service_role (в обход RLS) в тот checklist_id, который
 * пришёл в теле. Проверок каллера не было вовсе — то есть по публичному anon-ключу из
 * бандла портала можно было набивать любой чек-лист и жечь квоту AI-шлюза.
 * `verify_jwt` от этого не защищает: anon-ключ — валидный подписанный JWT проекта.
 *
 * Способ проверки — как в `set-team-password` и `list-schedule-projects` (единственный
 * рабочий на этом стеке): `sub` из payload (у anon-ключа его нет) + подтверждение
 * подлинности токена запросом на `/rest`, где подпись проверяет шлюз.
 * Токен принимаем и из тела: платформа умеет портить заголовок `Authorization`.
 */
async function callerUserId(req: Request, body: Record<string, unknown>): Promise<string | null> {
  const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const token = String(body.access_token ?? '') || headerToken;
  if (!token || !CALLER_SUPABASE_URL || !CALLER_ANON_KEY) return null;

  let sub = '';
  try {
    sub = JSON.parse(b64url(token.split('.')[1] ?? '')).sub ?? '';
  } catch {
    return null;
  }
  if (!sub) return null; // anon-ключ: подписан проектом, но пользователя за ним нет

  try {
    const r = await fetch(
      `${CALLER_SUPABASE_URL}/rest/v1/profiles?select=user_id&user_id=eq.${sub}&limit=1`,
      { headers: { Authorization: `Bearer ${token}`, apikey: CALLER_ANON_KEY } },
    );
    return r.ok ? sub : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    if (!(await callerUserId(req, body as Record<string, unknown>))) {
      console.warn('Rejected: no signed-in user behind the request');
      return new Response(JSON.stringify({ error: 'Sign in to import a checklist.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // `image` — псевдоним `imageBase64`: под этим именем поле шлёт Production Checklist.
    const { imageBase64: rawImage, image, checklistId, table } = body;
    const imageBase64 = rawImage ?? image;
    const targetTable = table === 'production_checklist_items' ? 'production_checklist_items' : 'checklist_items';

    if (!imageBase64) {
      return new Response(JSON.stringify({ error: 'Image is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!checklistId) {
      return new Response(JSON.stringify({ error: 'checklistId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase configuration is missing");
    }

    console.log('Processing checklist image with AI...');

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Extract ALL checklist items from this image preserving EVERY level of nesting and indentation.

CRITICAL REQUIREMENTS:
- Capture ALL hierarchy levels (parent, child, grandchild, great-grandchild, etc.)
- Each item must have a "label" (the text content)
- Each item can optionally have a "children" array containing nested items
- Children follow the exact same structure and can have their own children
- Preserve the exact indentation structure from the image
- DO NOT flatten the hierarchy - maintain all nesting levels

Example of what I need:
{
  "items": [
    {
      "label": "Top Level Item",
      "children": [
        {
          "label": "Level 2 Item",
          "children": [
            {
              "label": "Level 3 Item",
              "children": [
                {
                  "label": "Level 4 Item",
                  "children": [
                    {
                      "label": "Level 5 Item"
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}`
              },
              {
                type: "image_url",
                image_url: {
                  url: imageBase64
                }
              }
            ]
          }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_checklist",
              description: "Extract checklist items preserving unlimited nesting levels",
              parameters: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    description: "Array of top-level checklist items",
                    items: {
                      type: "object",
                      properties: {
                        label: {
                          type: "string",
                          description: "The text content of this item"
                        },
                        children: {
                          type: "array",
                          description: "Nested sub-items with the same structure (can nest infinitely deep)",
                          items: {
                            type: "object",
                            properties: {
                              label: { 
                                type: "string",
                                description: "The text content"
                              },
                              children: { 
                                type: "array",
                                description: "Further nested items",
                                items: {
                                  type: "object",
                                  properties: {
                                    label: { type: "string" },
                                    children: { type: "array" }
                                  },
                                  required: ["label"]
                                }
                              }
                            },
                            required: ["label"]
                          }
                        }
                      },
                      required: ["label"]
                    }
                  }
                },
                required: ["items"]
              }
            }
          }
        ],
        tool_choice: { type: "function", function: { name: "extract_checklist" } }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      return new Response(
        JSON.stringify({ error: "AI processing failed" }), 
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();
    console.log('AI response:', JSON.stringify(data));
    
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error("No tool call in AI response");
    }

    const extractedData = JSON.parse(toolCall.function.arguments);
    console.log('Extracted data structure:', JSON.stringify(extractedData, null, 2));
    
    // Use service role client to bypass RLS
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // Get existing items to calculate sort order
    const { data: existingItems } = await supabase
      .from(targetTable)
      .select('sort_order, parent_id')
      .eq('checklist_id', checklistId)
      .is('parent_id', null);
    
    const rootItems = existingItems || [];
    let sortOrder = rootItems.length > 0 ? Math.max(...rootItems.map((i: any) => i.sort_order)) + 1 : 0;
    
    // Recursive function to insert items at any depth
    const insertItemRecursively = async (
      item: any, 
      parentId: string | null, 
      itemSortOrder: number,
      depth: number = 0
    ): Promise<void> => {
      // Validate item has a label
      if (!item.label || typeof item.label !== 'string' || item.label.trim() === '') {
        console.warn(`Skipping item at depth ${depth} with invalid label:`, item);
        return;
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log(`Inserting item at depth ${depth}: "${item.label.substring(0, 50)}..." (parent: ${parentId || 'root'})`);

      const { data: insertedItem, error: insertError } = await supabase
        .from(targetTable)
        .insert({
          checklist_id: checklistId,
          task_id: taskId,
          label: item.label.trim(),
          sort_order: itemSortOrder,
          parent_id: parentId
        })
        .select()
        .single();

      if (insertError) {
        console.error(`Error inserting item at depth ${depth}:`, insertError);
        throw insertError;
      }

      // Recursively insert all children
      if (item.children && Array.isArray(item.children) && item.children.length > 0) {
        console.log(`Item "${item.label.substring(0, 30)}..." has ${item.children.length} children at depth ${depth + 1}`);
        for (let i = 0; i < item.children.length; i++) {
          await insertItemRecursively(item.children[i], insertedItem.id, i, depth + 1);
        }
      }
    };

    // Insert all top-level items recursively
    let totalInserted = 0;
    for (const item of extractedData.items) {
      await insertItemRecursively(item, null, sortOrder++, 0);
      totalInserted++;
    }
    
    console.log(`Successfully inserted ${totalInserted} top-level items with all nested children`);
    
    return new Response(
      JSON.stringify({ success: true, itemCount: extractedData.items.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
