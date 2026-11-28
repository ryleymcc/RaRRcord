# Project rules

## Always start from the latest main

Before making any changes for a new prompt, pull the latest `main` from the repo first, so work never starts from an out-of-date copy:

1. `git fetch origin main`
2. Make sure your working copy matches it (check out or update `main`).
3. Create your branch from that up-to-date `main`.

Do this at the start of every new prompt from the user, not just once per session. If your branch is already open, bring `main` into it before continuing.
