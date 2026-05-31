// SC Hauler Planner API Worker
//
// Endpoints:
//   POST /api/parse          { token, image, mediaType } -> Anthropic JSON (decrements 1 credit)
//   POST /api/buy            {}                          -> { url } (Stripe Checkout URL)
//   GET  /api/claim?session_id=X                         -> { token, credits } (idempotent)
//   GET  /api/credits?token=X                            -> { credits }

const CONTRACT_PROMPT = `You are a Star Citizen contract parser. Read this contract screen and return ONLY valid JSON (no markdown, no explanation) in exactly this format:

{
  "valid": true/false,
  "reason": "short reason if valid=false (e.g. 'placeholder text', 'not a contract screen')",
  "title": "the contract's title",
  "reward_auec": <integer, e.g. 53750>,
  "contractor": "e.g. Covalex or Red Wind Linehaul",
  "deliveries": [
    {
      "commodity": "e.g. Tungsten",
      "scu": <integer>,
      "pickup": "pickup station name (shown in blue text in the contract)",
      "delivery": "delivery station name (also blue)"
    }
  ]
}

RULES:
- One entry in "deliveries" per unique delivery destination. If the contract splits the same commodity across 2 stations (e.g. 3 SCU to station A + 3 SCU to station B), return 2 entries.
- Pickup and delivery are stations written in blue text in the objectives.
- Read SCU numbers from Primary Objectives: "Deliver 0/X SCU of [commodity] to [station]" -> scu=X.
- If Primary Objectives contains template text like "amount/total SCU of item" or "[item]", the contract is invalid: valid=false, reason="placeholder text".
- If the image is not a contract screen: valid=false, reason="not a contract screen".
- Station names MUST be precise (e.g. "HDPC-Farneseway", "Everus Harbor", "Sakura Sun Magnolia Workcenter").`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);

    try {
      if (url.pathname === '/api/parse' && request.method === 'POST') return cors(await handleParse(request, env), env);
      if (url.pathname === '/api/buy' && request.method === 'POST') return cors(await handleBuy(request, env), env);
      if (url.pathname === '/api/claim' && request.method === 'GET') return cors(await handleClaim(url, env), env);
      if (url.pathname === '/api/credits' && request.method === 'GET') return cors(await handleCredits(url, env), env);
      return cors(json({ error: 'not found' }, 404), env);
    } catch (err) {
      return cors(json({ error: err.message || 'internal error' }, 500), env);
    }
  }
};

// ============ HANDLERS ============

async function handleParse(request, env) {
  const body = await request.json();
  const token = (body.token || '').trim();
  if (!token) return json({ error: 'missing token' }, 401);

  const credit = await env.HAULER_KV.get(`token:${token}`, { type: 'json' });
  if (!credit) return json({ error: 'invalid token' }, 401);
  if (!credit.credits || credit.credits <= 0) return json({ error: 'no credits left' }, 402);

  if (!body.image || !body.mediaType) return json({ error: 'missing image' }, 400);

  // Reserve credit before calling Anthropic so we don't double-spend on retries
  credit.credits -= 1;
  credit.last_used = Date.now();
  await env.HAULER_KV.put(`token:${token}`, JSON.stringify(credit));

  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: body.mediaType, data: body.image } },
            { type: 'text', text: CONTRACT_PROMPT }
          ]
        }]
      })
    });
  } catch (e) {
    // Refund on network failure
    credit.credits += 1;
    await env.HAULER_KV.put(`token:${token}`, JSON.stringify(credit));
    return json({ error: 'upstream unreachable' }, 502);
  }

  if (!claudeResp.ok) {
    // Refund on upstream error
    credit.credits += 1;
    await env.HAULER_KV.put(`token:${token}`, JSON.stringify(credit));
    const errText = await claudeResp.text();
    return json({ error: `claude api ${claudeResp.status}: ${errText.slice(0, 200)}` }, 502);
  }

  const data = await claudeResp.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (match) {
    try { parsed = JSON.parse(match[0]); } catch {}
  }
  if (!parsed) {
    // Refund on parse failure
    credit.credits += 1;
    await env.HAULER_KV.put(`token:${token}`, JSON.stringify(credit));
    return json({ error: 'could not parse claude response' }, 502);
  }

  return json({ parsed, credits_left: credit.credits });
}

async function handleBuy(request, env) {
  // Create Stripe Checkout Session
  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('payment_method_types[]', 'card');
  form.append('line_items[0][price_data][currency]', env.PACK_CURRENCY);
  form.append('line_items[0][price_data][product_data][name]', env.PACK_PRODUCT_NAME);
  form.append('line_items[0][price_data][unit_amount]', env.PACK_PRICE_CENTS);
  form.append('line_items[0][quantity]', '1');
  form.append('success_url', `${env.PUBLIC_URL}/?claim={CHECKOUT_SESSION_ID}`);
  form.append('cancel_url', env.PUBLIC_URL);
  form.append('metadata[credits]', env.CREDITS_PER_PACK);

  const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  if (!stripeResp.ok) {
    const errText = await stripeResp.text();
    return json({ error: `stripe ${stripeResp.status}: ${errText.slice(0, 200)}` }, 502);
  }

  const session = await stripeResp.json();
  return json({ url: session.url });
}

async function handleClaim(url, env) {
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return json({ error: 'missing session_id' }, 400);

  // Idempotency: if we already issued a token for this session, return it
  const existing = await env.HAULER_KV.get(`session:${sessionId}`);
  if (existing) {
    const credit = await env.HAULER_KV.get(`token:${existing}`, { type: 'json' });
    return json({ token: existing, credits: credit?.credits ?? 0 });
  }

  // Verify session is actually paid
  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  if (!stripeResp.ok) return json({ error: 'session not found' }, 404);

  const session = await stripeResp.json();
  if (session.payment_status !== 'paid') return json({ error: 'session not paid' }, 402);

  // Issue token
  const token = crypto.randomUUID();
  const credits = parseInt(session.metadata?.credits || env.CREDITS_PER_PACK, 10);
  const record = {
    credits,
    email: session.customer_details?.email || null,
    stripe_session: sessionId,
    created: Date.now()
  };

  // 365-day TTL
  await env.HAULER_KV.put(`token:${token}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 });
  await env.HAULER_KV.put(`session:${sessionId}`, token, { expirationTtl: 60 * 60 * 24 * 365 });

  return json({ token, credits });
}

async function handleCredits(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return json({ error: 'missing token' }, 400);
  const credit = await env.HAULER_KV.get(`token:${token}`, { type: 'json' });
  if (!credit) return json({ error: 'invalid token' }, 401);
  return json({ credits: credit.credits });
}

// ============ HELPERS ============

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function cors(resp, env) {
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'content-type');
  return new Response(resp.body, { status: resp.status, headers });
}
