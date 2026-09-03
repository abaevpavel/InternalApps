import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

/** base64url → строка. */
function b64url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

/**
 * SEC-9: за запросом должен стоять залогиненный человек.
 *
 * Раньше проверок не было вовсе, а функция проксирует запрос в AWS под общим токеном —
 * то есть кто угодно с публичным anon-ключом из бандла портала мог запускать привязку
 * Gmail для произвольного адреса. `verify_jwt` тут не спасает: anon-ключ — валидный
 * подписанный JWT проекта.
 *
 * Способ проверки — как в `set-team-password` и `list-schedule-projects` (единственный
 * рабочий на этом стеке): `sub` из payload (у anon-ключа его нет) + подтверждение
 * подлинности токена запросом на `/rest`, где подпись проверяет шлюз.
 * Токен принимаем и из тела: платформа умеет портить заголовок `Authorization`.
 */
async function callerUserId(req: Request, body: Record<string, unknown>): Promise<string | null> {
  const headerToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const token = String(body.access_token ?? '') || headerToken;
  if (!token || !SUPABASE_URL || !ANON_KEY) return null;

  let sub = '';
  try {
    sub = JSON.parse(b64url(token.split('.')[1] ?? '')).sub ?? '';
  } catch {
    return null;
  }
  if (!sub) return null; // anon-ключ: подписан проектом, но пользователя за ним нет

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=user_id&user_id=eq.${sub}&limit=1`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    });
    return r.ok ? sub : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Gmail auth request received');

    // Тело читаем один раз: из него берём и токен, и email.
    const body = await req.json().catch(() => ({}));

    if (!(await callerUserId(req, body as Record<string, unknown>))) {
      console.warn('Rejected: no signed-in user behind the request');
      return new Response(JSON.stringify({ error: 'Sign in to set up Gmail sending.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Email: сначала query-параметр, затем тело (как было).
    const url = new URL(req.url);
    const email = url.searchParams.get('email') ?? (body as { email?: string }).email;

    if (!email) {
      console.error('No email provided');
      return new Response(JSON.stringify({ error: 'Email is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('Forwarding request for email:', email);
    
    // Forward the request to the AWS API
    const awsResponse = await fetch(
      `https://3mb71kyw2k.execute-api.us-east-1.amazonaws.com/dev/gmail/auth?email=${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': 'bmasters2020',
        },
      }
    );

    console.log('AWS API response status:', awsResponse.status);
    
    if (awsResponse.ok) {
      const data = await awsResponse.text();
      console.log('AWS API response data:', data);
      
      return new Response(JSON.stringify({ success: true, message: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else {
      console.error('AWS API error. Status:', awsResponse.status);
      const errorText = await awsResponse.text();
      console.error('AWS API error response:', errorText);
      
      return new Response(JSON.stringify({ 
        error: `AWS API error: ${awsResponse.status}`,
        details: errorText 
      }), {
        status: awsResponse.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (error) {
    console.error('Error in gmail-auth function:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: error.message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});