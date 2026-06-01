#!/usr/bin/env bash
# Build the public site bundle and deploy worker + pages to Cloudflare.
# Layout: landing at /, tool at /app, feedback at /feedback.html, screenshots in /img.
# Requires CLOUDFLARE_API_TOKEN in the environment (or `wrangler login`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"

echo "==> Building site bundle"
rm -rf "$DIST"
mkdir -p "$DIST/app" "$DIST/img"
# landing: rewrite local-preview links (../index.html) to production /app
sed 's#\.\./index\.html#/app#g' "$ROOT/site/index.html" > "$DIST/index.html"
cp "$ROOT/site/feedback.html" "$DIST/feedback.html"
cp "$ROOT/index.html" "$DIST/app/index.html"
cp "$ROOT"/site/img/* "$DIST/img/" 2>/dev/null || true

echo "==> Deploying worker"
( cd "$ROOT/worker" && npx --yes wrangler@4 deploy )

echo "==> Deploying pages"
( cd "$ROOT" && npx --yes wrangler@4 pages deploy "$DIST" --project-name=sc-hauler-planner --commit-dirty=true )

echo "==> Done. https://scrapwavesurvivors.com"
