#!/bin/sh
set -eu
# Use only the generated configuration, the local emulator and its dedicated volume.
# Wrangler uses the .dev.vars file alongside its config for local secrets.
test -s dist/server/.dev.vars
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --config dist/server/wrangler.json --persist-to /data
exec node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev --config dist/server/wrangler.json --local --persist-to /data --ip 0.0.0.0 --port 3000 --inspector-port 0
