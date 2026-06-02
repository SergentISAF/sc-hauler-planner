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
      if (url.pathname === '/api/feedback' && request.method === 'POST') return cors(await handleFeedback(request, env), env);
      if (url.pathname === '/api/recover' && request.method === 'POST') return cors(await handleRecover(request, env), env);
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

  // Input validation — block junk and oversized payloads BEFORE spending a credit or calling Anthropic
  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!ALLOWED_TYPES.includes(body.mediaType)) return json({ error: 'unsupported image type' }, 400);
  if (typeof body.image !== 'string' || body.image.length > 12_000_000) return json({ error: 'image too large' }, 413);

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
    await notify(env, 'Hauler: Anthropic unreachable', 'A customer parse failed (upstream fetch threw). Credit refunded.');
    return json({ error: 'upstream unreachable' }, 502);
  }

  if (!claudeResp.ok) {
    // Refund on upstream error
    credit.credits += 1;
    await env.HAULER_KV.put(`token:${token}`, JSON.stringify(credit));
    const errText = await claudeResp.text();
    await notify(env, `Hauler: Anthropic ${claudeResp.status}`, `A customer parse failed (credit refunded). Likely funds/cap/key if 400/402/429. ${errText.slice(0, 300)}`);
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
  // Pick the pack: 'small' (50/€2) or 'large' (200/€5, default)
  const body = await request.json().catch(() => ({}));
  const small = body.pack === 'small';
  const credits = small ? (env.SMALL_CREDITS || '50') : (env.CREDITS_PER_PACK || '200');
  const priceCents = small ? (env.SMALL_PRICE_CENTS || '200') : (env.PACK_PRICE_CENTS || '500');
  const productName = `SC Hauler Planner — ${credits} credits`;

  // Create Stripe Checkout Session
  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('payment_method_types[]', 'card');
  form.append('line_items[0][price_data][currency]', env.PACK_CURRENCY);
  form.append('line_items[0][price_data][product_data][name]', productName);
  form.append('line_items[0][price_data][unit_amount]', priceCents);
  form.append('line_items[0][price_data][tax_behavior]', 'exclusive'); // price is net; VAT is added on top at checkout
  form.append('line_items[0][quantity]', '1');
  form.append('automatic_tax[enabled]', 'true'); // Stripe Tax computes VAT from customer location
  form.append('success_url', `${env.PUBLIC_URL}/app/?claim={CHECKOUT_SESSION_ID}`);
  form.append('cancel_url', `${env.PUBLIC_URL}/app/`);
  form.append('metadata[credits]', credits);

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
    await notify(env, `Hauler: Stripe ${stripeResp.status}`, `A customer checkout failed to create. ${errText.slice(0, 300)}`);
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

  const addCredits = parseInt(session.metadata?.credits || env.CREDITS_PER_PACK, 10);
  const email = session.customer_details?.email || null;
  const YEAR = 60 * 60 * 24 * 365;

  // Top-up: if this email already has a token, add credits to it instead of
  // issuing a new one (so a second pack accumulates rather than orphaning the rest)
  let token = null;
  let totalCredits = addCredits;
  if (email) {
    const existingToken = await env.HAULER_KV.get(`email:${email.toLowerCase()}`);
    if (existingToken) {
      const rec = await env.HAULER_KV.get(`token:${existingToken}`, { type: 'json' });
      if (rec) {
        rec.credits = (rec.credits || 0) + addCredits;
        rec.last_topup = Date.now();
        await env.HAULER_KV.put(`token:${existingToken}`, JSON.stringify(rec), { expirationTtl: YEAR });
        token = existingToken;
        totalCredits = rec.credits;
      }
    }
  }

  // First purchase for this email (or no email): issue a fresh token
  if (!token) {
    token = crypto.randomUUID();
    const record = { credits: addCredits, email, stripe_session: sessionId, created: Date.now() };
    await env.HAULER_KV.put(`token:${token}`, JSON.stringify(record), { expirationTtl: YEAR });
    if (email) await env.HAULER_KV.put(`email:${email.toLowerCase()}`, token, { expirationTtl: YEAR });
  }

  await env.HAULER_KV.put(`session:${sessionId}`, token, { expirationTtl: YEAR });

  return json({ token, credits: totalCredits });
}

async function handleCredits(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return json({ error: 'missing token' }, 400);
  const credit = await env.HAULER_KV.get(`token:${token}`, { type: 'json' });
  if (!credit) return json({ error: 'invalid token' }, 401);
  return json({ credits: credit.credits });
}

async function handleFeedback(request, env) {
  const body = await request.json().catch(() => ({}));
  const message = (body.message || '').toString().trim().slice(0, 4000);
  if (!message) return json({ error: 'empty message' }, 400);

  const type = (body.type || 'other').toString().slice(0, 24);
  const email = (body.email || '').toString().trim().slice(0, 200);
  const token = (body.token || '').toString().trim().slice(0, 80);

  // Priority flag if the sender pasted a valid credits token
  let priority = false;
  if (token) {
    const c = await env.HAULER_KV.get(`token:${token}`, { type: 'json' });
    if (c) priority = true;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { type, message, email, priority, ts: Date.now() };
  await env.HAULER_KV.put(`feedback:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 });

  // Optional push to ntfy if NTFY_URL is set as a Worker var/secret
  if (env.NTFY_URL) {
    try {
      await fetch(env.NTFY_URL, {
        method: 'POST',
        headers: { 'Title': `Hauler feedback: ${type}${priority ? ' (PRIORITY)' : ''}`, 'Tags': 'package' },
        body: `${message}\n\n— ${email || 'no email'}`
      });
    } catch (_) { /* best effort */ }
  }

  return json({ ok: true });
}

async function handleRecover(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = (body.email || '').toString().trim().toLowerCase().slice(0, 200);
  // Always return ok so we never reveal whether an email has credits (no enumeration)
  if (!email) return json({ ok: true });

  const token = await env.HAULER_KV.get(`email:${email}`);
  if (token && env.RESEND_API_KEY && env.EMAIL_FROM) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: email,
          reply_to: env.REPLY_TO || undefined,
          subject: 'Your SC Hauler Planner access token',
          text: `Here is your access token for SC Hauler Planner:\n\n${token}\n\nOpen the planner, go to the Credits tab, click "I already have a token" and paste it in to reach your credits.\n\nKeep this safe, it is the key to your credits.`
        })
      });
    } catch (_) { /* best effort */ }
  }
  return json({ ok: true });
}

// Best-effort push alert via ntfy (set NTFY_URL). Used for runtime failures.
async function notify(env, title, body) {
  if (!env.NTFY_URL) return;
  try {
    await fetch(env.NTFY_URL, { method: 'POST', headers: { 'Title': title, 'Priority': 'high', 'Tags': 'warning' }, body });
  } catch (_) { /* never let alerting break the request */ }
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
