# Deployment guide

End-to-end checklist for putting SC Hauler Planner live at **scrapwavesurvivor.com** with paid Stripe credits.

Estimated time: 30-45 minutes once you have Stripe + Anthropic accounts.

---

## Prerequisites

You need accounts/keys for:
- **Cloudflare** — for DNS, Pages (static hosting), Worker (API proxy) and KV (credit storage). You already have this.
- **Anthropic** — get an API key at https://console.anthropic.com/. Top up at least $20 to start.
- **Stripe** — sign up at https://stripe.com (KYC takes 1-2 days if new). Start in **test mode**, switch to live when ready.
- **Node.js + npm** — to run Wrangler (Cloudflare's CLI).

Domain `scrapwavesurvivor.com` should already be on Cloudflare (transfer it if it's not).

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

A browser will open. Authorize Wrangler to access your Cloudflare account.

---

## Step 2 — Create the KV namespace

From inside the `worker/` directory:

```bash
cd worker
wrangler kv namespace create HAULER_KV
```

You'll get output like:

```
🌀 Creating namespace with title "sc-hauler-planner-api-HAULER_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "HAULER_KV"
id = "abc123def456..."
```

Copy the `id` value. Open `worker/wrangler.toml` and replace `REPLACE_AFTER_KV_CREATE` with that id.

---

## Step 3 — Set Worker secrets

Still in `worker/`:

```bash
wrangler secret put ANTHROPIC_API_KEY
# paste your sk-ant-... key when prompted

wrangler secret put STRIPE_SECRET_KEY
# paste your Stripe secret key (sk_test_... for testing, sk_live_... for production)
```

Secrets are encrypted and never exposed in logs or the dashboard.

---

## Step 4 — Deploy the Worker

```bash
wrangler deploy
```

You'll see something like:

```
Published sc-hauler-planner-api (1.23 sec)
  https://sc-hauler-planner-api.<your-subdomain>.workers.dev
```

The Worker is now live on a workers.dev URL. Next step ties it to your domain.

---

## Step 5 — Deploy the frontend to Cloudflare Pages

From the **repo root** (one level up from `worker/`):

```bash
wrangler pages deploy . --project-name=sc-hauler-planner --commit-dirty=true
```

This uploads `index.html`, `LICENSE`, `README.md` and the `screenshots/` folder as a static site. (The `worker/` folder is uploaded but never served — Pages only renders static files.)

You'll get a URL like `https://sc-hauler-planner.pages.dev`. Confirm it works.

For ongoing updates, you can either re-run this command or connect the Pages project to the GitHub repo for auto-deploy on push (Pages dashboard → Settings → Builds & deployments → Connect to Git).

---

## Step 6 — Custom domain for Pages

In the Cloudflare dashboard:

1. Open the `sc-hauler-planner` Pages project
2. **Custom domains** → **Set up a custom domain** → enter `scrapwavesurvivor.com`
3. Cloudflare creates the DNS record automatically (CNAME / Pages)
4. Wait 1-2 minutes for SSL certificate to provision

Your static site is now at `https://scrapwavesurvivor.com`.

---

## Step 7 — Route /api/* to the Worker

The `wrangler.toml` already declares the route:

```toml
routes = [
  { pattern = "scrapwavesurvivor.com/api/*", zone_name = "scrapwavesurvivor.com" }
]
```

Re-deploy the Worker to register the route:

```bash
cd worker
wrangler deploy
```

Now `https://scrapwavesurvivor.com/api/credits?token=foo` hits the Worker, while everything else hits the Pages static site.

Test it:

```bash
curl https://scrapwavesurvivor.com/api/credits?token=invalid
# should return: {"error":"invalid token"}
```

---

## Step 8 — Switch Stripe to live mode

While testing, use `sk_test_...` keys and Stripe's test card numbers (e.g. `4242 4242 4242 4242`, any future date, any CVC).

When you're ready to take real money:

1. Stripe dashboard → toggle from **Test mode** to **Live mode** (top right)
2. Get your live secret key from **Developers → API keys**
3. Update the secret:

```bash
cd worker
wrangler secret put STRIPE_SECRET_KEY
# paste your sk_live_... key
```

4. Redeploy: `wrangler deploy`

---

## Step 9 — Optional: configure Stripe branding

In Stripe dashboard → **Settings → Branding**:
- Upload your logo (will show on Stripe Checkout page)
- Set brand color to `#4FC3F7` (matches the app)
- Add support email so customers can reach you

This is what users see when they're paying. A bit of polish here significantly reduces "is this legit?" abandonment.

---

## Step 10 — Smoke test the live flow

1. Open `https://scrapwavesurvivor.com` in incognito
2. Click **Buy 200 credits**
3. Pay with a test card (or your own card in live mode — you'll get the money back minus Stripe fee)
4. After redirect, the page should show `200 credits left`
5. Drop a contract screenshot in, click **Parse images with Claude**
6. Credits should decrement to 199 and you should see the parsed contract

If anything fails, check Worker logs: `wrangler tail` (inside `worker/`) shows live requests/errors.

---

## Ongoing operations

### Update prices

Edit `worker/wrangler.toml` → `PACK_PRICE_CENTS` (or `CREDITS_PER_PACK`), then `wrangler deploy`. Stripe Checkout sessions are created fresh each click, so the new price takes effect immediately.

### Refund a customer or grant free credits

Edit KV directly via the Cloudflare dashboard or:

```bash
wrangler kv key put --binding=HAULER_KV "token:USER_TOKEN" '{"credits": 500, "email": "...", "created": 1234567890}'
```

### Monitor spend

Anthropic dashboard → Usage shows daily spend. Cloudflare KV reads/writes are well within free tier (100k/day reads, 1k/day writes) at any realistic traffic level.

### Costs at various traffic levels

| Active users/day | Parses/day | Anthropic cost/day | Stripe fee | Your net/day |
|---|---|---|---|---|
| 10 | 50  | ~$0.75 | depends | depends |
| 100 | 500 | ~$7.50 | ~€0.30/sale | (revenue – costs) |
| 1000 | 5000 | ~$75 | scales | scales |

Worker + Pages + KV are free at all these levels.

---

## Troubleshooting

**"invalid token" after paying:**
The Stripe webhook isn't needed (we use the `?claim=session_id` URL flow), but if the user landed back on the page without the `claim` query parameter — they can paste their session_id manually via `/api/claim?session_id=cs_...` in the URL.

**CORS errors:**
Make sure `ALLOWED_ORIGIN` in `wrangler.toml` matches your actual domain. Redeploy after changing.

**Worker hits Stripe rate limit:**
Unlikely at small scale. If it happens, switch to Stripe SDK or implement exponential backoff in `handleBuy`.

**KV namespace ID is wrong:**
You'll see `KVError: namespace not found`. Re-check the id you pasted into `wrangler.toml`, redeploy.
