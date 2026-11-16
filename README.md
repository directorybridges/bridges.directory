# Bridges.directory: run guide

## What runs where
- **Website**: static files in this repo's root, served by GitHub Pages on `bridges.directory` (`CNAME`). `index.html` is the member site, `admin.html` the admin portal.
- **Backend**: one Supabase project (Mumbai). Members, certificates, rules and the admin all live in its database. The site talks to it through `bridges-backend.js` (member site) and `admin-*.js` (admin). `bridges-config.js` holds the project address and the public key (public by design).
- **Email**: Resend, called from the database (`send_email`). The Resend key is stored in Supabase Vault, not in the repo.
- **Certificates**: today stored in the database. The private Cloudflare R2 version is in `worker/` (see `worker/README.md`) and switches on by filling `certWorkerUrl` in `bridges-config.js`.
- **Home banner**: the animated globe (`hero-globe.js` and `fonts/`). It rebuilds itself from the home page, so a new design file does not remove it.
- **Daily clean-up**: a database job (`bridges-daily-cleanup`, 02:00 IST) deletes expired certificates, old codes and expired invites.

## Everyday jobs
- **Change page text, the site notice, settings, roles, faculty accounts, invites**: use the admin portal (`/admin.html`). No code needed.
- **Add or change a rule in the database**: add a new numbered file in `supabase/`, then run `cd supabase && npm i pg && node apply.js ../.env`. `.env` is not in the repo; it needs the database host, user and password from Supabase (Project Settings, Database).
- **Check the database rules still hold**: `cd supabase && node tests.js ../.env`, and the other `tests-*.js` files (they run inside a transaction or use throwaway accounts, and leave nothing behind).

## When the designer sends a new version
Replace `index.html` / `admin.html` (and any new images), then run, from the repo root:
```
node tools/wire-backend.js .
node tools/link-admin.js .
node tools/extract-admin-data.js .
node tools/strip-demo.js .
```
(`wire-backend.js` also puts the globe script back.)
Each can be run again safely. They re-attach the backend, the Admin link, the admin text defaults, and drop the prototype's demo passwords.

## Accounts that should all sit in the owner's name
GitHub (repo and Pages), GoDaddy (domain), Supabase, Resend, Cloudflare, and the Google sign-in project (Google Cloud). Nothing here depends on the developer's own logins.

## Not live yet
- Razorpay checkout (the Contribute page runs in test mode; no money moves).
