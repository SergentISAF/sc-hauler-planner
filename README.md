# SC Hauler Planner

Single-file web app that automatically generates optimized transport plans for Star Citizen hauler contracts. Drop in screenshots of your contract screens and the app uses Claude vision API to read pickup, delivery, commodity and SCU, then computes the route, the LIFO loading plan and an interactive checklist you can tick off while flying.

> **Status:** Public alpha. Open for testing and feedback from the SC hauler community.

## Demo

A 9-contract Hurston run with the RSI Hermes, starting at Everus Harbor.

**1. Drop in your contract screenshots and let Claude parse them:**

![Upload contract screenshots and parse with Claude](screenshots/01-upload-and-parse.png)

**2. Get the generated plan with station overview and cargo loading map (Port Grid for local Hurston deliveries, Starboard Grid for Everus-bound return cargo loaded en-route):**

![Generated transport plan with station overview and cargo loading map](screenshots/02-generated-plan.png)

## Features

- **Drag/drop image upload** — as many contract screenshots as you want
- **Claude vision auto-parse** — extracts station names, commodities, SCU and reward from every contract
- **Auto route** — groups contracts by destination, computes pickup→delivery order to minimize backtracking
- **LIFO loading plan** — last destination packed first; first destination packed last (= first out)
- **Multi-grid ships** — if you fly the Hermes or Caterpillar, the app uses the separate cargo grids to keep local deliveries apart from return cargo
- **17 ships in the database** — from Cutlass Black (46 SCU) to Hull C (4608 SCU). Warns if peak load exceeds capacity
- **Live checklist** — tick off pickups and drops; earned aUEC updates live; contracts lock as "CLOSED" once both pickup and delivery are done
- **Local storage** — checks survive a browser restart
- **Smart error handling** — placeholder/template contracts (game bugs) are skipped automatically

## Run it

**Right now:** clone the repo (or download `index.html` directly) and double-click it. Toggle the **🔑 Bring your own key** tab, enter your Anthropic API key (stored locally in your browser, see guide below). Cost: ~$0.01–0.02 per screenshot.

**Coming soon — hosted version:** A no-setup hosted version is on the way at [scrapwavesurvivor.com](https://scrapwavesurvivor.com). Buy a pack of 200 credits for €5 (one credit = one contract screenshot parsed, no subscription, no expiry) and skip the Anthropic signup entirely. Useful if you want to use the tool on a phone, on a shared machine, or just want one less account to set up. BYOK remains free forever for power users who already have an Anthropic key.

![Hosted version Credits tab preview](screenshots/03-hosted-credits.png)

For deploying your own hosted instance with Stripe credits, see [DEPLOY.md](DEPLOY.md).

## Getting an Anthropic API key (3 minutes)

If you go the BYOK route, you'll need a Claude API key from Anthropic. Here's how:

1. Go to [console.anthropic.com](https://console.anthropic.com/) and sign up with email, Google, or GitHub.
2. Verify your email.
3. Click **Billing** in the left sidebar → add a payment method.
4. Top up with **$5–10** in credits (roughly 500–1000 parses).
5. Click **API Keys** in the sidebar → **Create Key**. Name it something like "hauler".
6. Copy the key (starts with `sk-ant-`) — you can only see it once, so save it somewhere safe like a password manager.
7. Paste it into the **Claude API Key** field in the app.

The key is stored only in your browser's localStorage and sent directly to Anthropic — never to any third party server.

> **Security tip:** if you ever paste the key on a shared or public machine, revoke it from the Anthropic console afterwards. The hosted version at scrapwavesurvivor.com avoids this entirely by handling the key server-side.

## Roadmap

- [ ] Persistent contract library (keep parsed contracts across sessions)
- [ ] Ship-grid visualizations for C2, Caterpillar and Hull series
- [ ] Geographic route optimization (distance between stations)
- [ ] Multi-player crew mode (shared cargo, task assignment)
- [ ] Reward/SCU ratio statistics (is this run worth taking?)
- [ ] Mobile-responsive layout
- [ ] Cloudflare Pages deployment under its own subdomain
- [ ] Backend proxy so users don't need their own API key

## Tech

- Pure HTML/CSS/JS — no build step, no framework
- Claude API (Sonnet 4.6 with vision) called directly from the browser
- localStorage for state persistence
- SVG for cargo-grid illustrations

## Contributing

Issues and pull requests welcome. This is a hobby project built around my own SC hauling, so I'm happy to take suggestions and ship-database fixes from the community.

## License

MIT — see [LICENSE](LICENSE). Free to use, fork and build on. If you build something commercial on top, a friendly hello would be appreciated.
