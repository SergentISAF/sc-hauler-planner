# SC Hauler Planner API Worker

Cloudflare Worker that proxies Claude vision parses, handles Stripe checkout for credit packs, and tracks credit balances in Cloudflare KV.

See [`../DEPLOY.md`](../DEPLOY.md) for full deployment instructions.

## Quick reference

- Endpoints: `/api/parse`, `/api/buy`, `/api/claim`, `/api/credits`
- KV namespace binding: `HAULER_KV`
- Secrets: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`
- Vars: see `wrangler.toml`

## Local dev

```bash
cd worker
npm install -g wrangler
wrangler dev
```
