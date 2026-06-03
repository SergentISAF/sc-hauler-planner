# CLAUDE.md , working guide for the SC Hauler Planner repo

Read this first. It tells you what this project is, how it's wired, the rules
you must not break (especially around git + secrets), and how to ship safely.

---

## 1. What this is

**SC Hauler Planner** , a tool for Star Citizen haulers. You drop in screenshots
of hauling contracts; Claude (vision) parses them; the app builds an optimized
run: a distance-aware route, a 3D view of how the cargo packs into the ship's
grids (LIFO), and a step-by-step checklist.

- **Live:** https://scrapwavesurvivors.com (landing at `/`, the tool at `/app`).
  This is where real people use it. Treat it like production.
- It is a **hobby / fan project**, not affiliated with CIG. The public GitHub
  repo is "just the engine" so anyone can run it with their own API key.

---

## 2. Layout

```
index.html            The tool, served at /app. ~1700 lines, TWO <script> blocks:
                        - an ES module (THREE.js 3D cargo viewer) near the top
                        - the main classic <script> (parsing, routing, UI, credits)
site/index.html       Marketing landing page (7 languages, i18n dictionary inline)
site/feedback.html    Feedback form
site/img/             Landing-page screenshots
worker/src/index.js   Cloudflare Worker , the /api/* backend (parse/buy/claim/
                        credits/feedback/recover)
worker/wrangler.toml  Worker config: KV binding, routes, vars (NO secrets here)
ship-grids.json       Per-ship cargo grid geometry (bundled into /app)
loc-map.json          Per-system body coords + station->body map (bundled into /app)
deploy.sh             Build dist/ and deploy Worker + Pages to Cloudflare
DEPLOY.md             Deploy/runbook details
```

The app is intentionally a **single self-contained HTML file** (no build step).
Match the surrounding style; don't introduce a framework or bundler.

---

## 3. Live infrastructure (Cloudflare)

- **Pages project:** `sc-hauler-planner` , serves the static site + /app.
- **Worker:** `sc-hauler-planner-api` , routes `scrapwavesurvivors.com/api/*`
  **and** `www.scrapwavesurvivors.com/api/*` (BOTH , see pitfalls).
- **KV namespace:** `HAULER_KV` (binding name), holds credit tokens
  (`token:<CODE>` -> `{credits,...}`), `email:<addr>`, `session:<id>`, `feedback:<id>`.
- Account/zone IDs and the namespace id live in `worker/wrangler.toml`.

---

## 4. ‼ CRITICAL: git + secrets discipline

This repo has **two remotes**:

- `github` (SergentISAF/sc-hauler-planner) , **PUBLIC**. "Just the engine."
  **No real keys, no credit/giveaway codes, ever.**
- `origin` = Gitea (private, on the NAS) , may carry internal notes (e.g. a
  `Claude-resume` handoff) and slightly different history.

Rules:
1. **Real secrets are NOT in git.** They are **Cloudflare Worker secrets** set via
   `wrangler secret put <NAME>` (ANTHROPIC_API_KEY, STRIPE_SECRET_KEY,
   RESEND_API_KEY, NTFY_URL). The owner keeps the raw key off-repo entirely. The
   `sk-ant-...` strings in `index.html` are placeholders in help text , harmless.
   (History note: a real key once lived in `screenshots/API` on Gitea; it has been
   **deleted** and moved off-repo. Never re-introduce a key file. If you ever see a
   key-shaped file, do NOT push it anywhere, least of all GitHub.)
2. **Prefer staging specific files** (`git add index.html`) over `git add -A`. It's
   habit from when a secret file lived here; keep it , it prevents accidents.
3. **Two-remote pushes:** the app tree is the same on both; Gitea just carries a few
   extra internal commits. Push GitHub, then bring the change onto `origin/main`
   (branch from the current `origin/main`, add your file, push to `origin`). Always
   `git fetch` first , Gitea can be ahead.
4. **Memory** (Claude's notes) lives in a **separate Gitea repo**
   (`Dan/claude-memory-hub-data`), never here, never on GitHub.

If unsure a push is safe, STOP and check
`git ls-tree -r --name-only github/main` for anything key-shaped first.

---

## 5. Credits / KV / money

- Credits are **prepaid** (Stripe Checkout). 50 credits / €2, 200 / €5. Revenue
  per pack > Anthropic cost per parse, so it's self-funding.
- **Hard money backstop:** a dedicated Anthropic workspace with a **$30/mo spend
  cap**. If exceeded, `/api/parse` fails, refunds the credit, and pings ntfy.
- Per-parse safety: input type allowlist + 12MB cap + credit reserved before the
  Anthropic call + refunded on any failure. `/api/buy` amounts are server-side
  (client can't tamper). `/api/claim` is idempotent and verifies `payment_status`.
- A Cloudflare **rate-limit rule** (`api-limit`) guards `/api/*`.

### ‼ `wrangler kv` writes LOCAL by default
`wrangler kv key put/get/list/delete` hit a **local miniflare store**, NOT
production, unless you pass **`--remote`**. Gift/trial codes minted without
`--remote` look fine via `wrangler kv key get` but are **dead live**. Always:
```bash
npx wrangler kv key put --remote --namespace-id=<HAULER_KV id> "token:HAULER-XXXXXX" \
  '{"credits":50,"kind":"gift"}'
```

---

## 6. Deploying

- `deploy.sh` builds `dist/` (landing -> /, tool -> /app/index.html, bundles
  `ship-grids.json` + `loc-map.json` into /app, img into /img) then deploys the
  **Worker** and **Pages**.
- **Frontend-only change (index.html / site / data files)? Deploy Pages ONLY** ,
  don't redeploy the Worker:
  ```bash
  # build dist as deploy.sh does, then:
  npx wrangler@4 pages deploy dist --project-name=sc-hauler-planner --commit-dirty=true
  ```
- Deploying needs **Cloudflare auth** (`wrangler login` or `CLOUDFLARE_API_TOKEN`).
  Not every machine has it (e.g. the Windows dev box doesn't; the Mac mini does).
- Pages deploys are **additive and reversible** (dashboard rollback). The owner is
  cautious about live , build, verify, and get a go before touching Worker/KV/
  secrets/DNS/Stripe.
- **Always verify after deploy:**
  ```bash
  curl -s https://scrapwavesurvivors.com/app/ | grep -o <a-marker-from-your-change>
  curl -s "https://scrapwavesurvivors.com/api/credits?token=<a test code>"   # expect JSON
  curl -s "https://www.scrapwavesurvivors.com/api/credits?token=<a test code>" # www too
  ```

---

## 7. Data sources (how to regenerate)

- **`ship-grids.json`** , per-ship grid geometry, extracted from the community
  tool **sc-cargo.space** (its JS bundle embeds `{capacity, groups:[{grids:[{width,
  height,length,...}]}]}`). Each ship's grid volumes sum to its SCU capacity.
- **`loc-map.json`** , two parts:
  - `bodies`: real positions from **CIG's official star map** API
    (`POST https://robertsspaceindustries.com/api/starmap/star-systems/{STANTON,PYRO}`;
    use `distance` + `longitude` + `parent_id`). CIG only has celestial bodies, NOT
    man-made stations.
  - `poi`: station -> parent body, extracted from **starmap.space** (its page embeds
    `{"item_id","System","Planet","PoiName","Type"}` records). Names are normalized
    (lowercase, strip " on/in/above X", alphanumeric).
- Container sizes (confirmed): 1=1x1x1, 2=1x1x2, 4=1x2x2, 8=2x2x2, 16=2x2x4,
  32=2x2x8. Boxes lie FLAT (smallest side = height); the packer only rotates about
  the vertical axis. **Box size comes from the contract** (`box_scu`), it is not
  guessed.

---

## 8. House style

- Verify JS before deploying: extract each `<script>` block and run `node --check`.
  For routing/packing logic, write a quick Node simulation against real contract
  data before shipping (the codebase has a history of this , do it).
- Marketing/community copy is written in the owner's voice: casual, lowercase,
  **no em-dashes** (use a comma), no "AI tells", a little intentional imperfection.
  It must not read as AI-made.
- Test new features in a sandbox/preview first; don't experiment on live.

---

## 9. Known pitfalls (learned the hard way)

- **`/api` on `www`**: the Worker route must cover BOTH apex and `www`. If only the
  apex is routed, `www/api/*` falls through to Pages and returns the static HTML
  (HTTP 200, not JSON) , the app then throws "Unexpected token '<'". The app's
  `apiJson()` helper degrades gracefully, but fix the route.
- **`wrangler kv` local-vs-remote** (see §5).
- **RSI Community Hub** is flaky: it can show "An error occurred" while actually
  creating the post (-> duplicates to delete). Title max 50 chars; it often rejects
  external links from new accounts (put links in a comment).
- **Cloudflare blocking your own IP**: heavy test/curl traffic from one IP can trip
  the rate-limit rule, giving you 403/HTML on `/api`. It's your test traffic, not a
  real outage , wait it out, or exempt your IP during testing.
- **`git add -A`** , see §4. Don't.

---

## 10. TL;DR for a new session

1. Don't `git add -A`; never push secrets/codes to GitHub.
2. `wrangler kv` needs `--remote` to touch production.
3. Frontend change -> Pages-only deploy; verify with curl on apex AND www.
4. Keep marketing copy in the owner's voice (no em-dash, casual, human).
5. Live is production , build, verify, confirm before risky changes.
