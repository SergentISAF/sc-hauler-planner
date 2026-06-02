# SC Hauler Planner

Single-file web app that turns your Star Citizen hauling contract screenshots into an optimised transport plan. Drop in the screenshots, Claude vision reads pickup, delivery, commodity and SCU, and the app computes the route, the LIFO loading plan and an interactive checklist you tick off while flying.

**Live:** https://scrapwavesurvivors.com

## Three ways to use it

**1. Hosted with prepaid credits (nothing to set up)**
Go to [scrapwavesurvivors.com](https://scrapwavesurvivors.com), buy a credit pack and parse away. One credit is one screenshot. No subscription, no expiry. The API key lives on the server, so there is nothing to install and no account to make.
- 50 credits for €2 + VAT (try it)
- 200 credits for €5 + VAT (best value)

**2. Bring your own key (free)**
Open the app, switch to "Bring your own key" and paste your own Anthropic API key. It stays in your browser and you pay Anthropic directly, about $0.006 a screenshot. Unlimited.

**3. Self-host from this repo (free)**
Clone the repo or [download `index.html`](https://raw.githubusercontent.com/SergentISAF/sc-hauler-planner/main/index.html). That one file is the whole tool. Double-click it, paste your Anthropic key, done. No server, no build.

## How it works

1. Drop in screenshots of your contract screens, as many as you want.
2. Claude vision extracts every pickup, delivery, commodity and SCU. Covalex, Red Wind, Ling Family, all of it.
3. The route is ordered to cut backtracking, with a LIFO loading map so the first drop sits on top.
4. Fly the live checklist. Earned aUEC and closed contracts update as you go.

## Features

- **Drag and drop upload**: as many contract screenshots as you want.
- **Claude vision auto-parse**: station names, commodities, SCU and reward read from every contract, zero typing.
- **Auto route**: groups contracts by destination and orders pickup before delivery to minimise backtracking.
- **LIFO loading plan**: last destination packed first, first destination packed last so it comes off first.
- **Multi-grid ships**: the Hermes and Caterpillar use their separate cargo grids for local vs return cargo.
- **18 ships in the database**: from the Cutlass Black to the Hull C. Warns when peak load will not fit.
- **Live checklist**: tick off pickups and drops, earned aUEC updates live, contracts lock as CLOSED when done.
- **Local storage**: your checks survive a browser restart.
- **Smart error handling**: placeholder and template contracts (game bugs) are skipped automatically.

## Getting an Anthropic API key (for option 2 or 3)

1. Go to [console.anthropic.com](https://console.anthropic.com/) and sign up.
2. Add a payment method under Billing and top up $5 to $10.
3. Under API Keys, create a key (starts with `sk-ant-`) and copy it.
4. Paste it into the app. The key is stored only in your browser and sent directly to Anthropic.

## Tech

- Pure HTML, CSS and JS. No build step, no framework.
- Claude (Sonnet 4.6 with vision) for parsing.
- Hosted backend: a Cloudflare Worker plus KV for credits and Stripe for payment (with Stripe Tax for VAT).
- localStorage for state.

## Running your own hosted instance

Want your own paid instance with Stripe credits? See [DEPLOY.md](DEPLOY.md) for the full guide, and `deploy.sh` for the one-command build and deploy.

## Disclaimer

This is an unofficial fan tool. It is not affiliated with or endorsed by Cloud Imperium Games or Roberts Space Industries. Star Citizen® and Squadron 42® are registered trademarks of Cloud Imperium Rights LLC.

## License

MIT, see [LICENSE](LICENSE). Free to use, fork and build on.
