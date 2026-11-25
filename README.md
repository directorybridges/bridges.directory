# Bridges.directory: run guide

## What runs where
- **Website**: static files in this repo's root, served by GitHub Pages on `bridges.directory` (`CNAME`). `index.html` is the member site, `admin.html` the admin portal.
- **Backend**: one Supabase project (Mumbai). Members, certificates, rules and the admin all live in its database. The site talks to it through `bridges-backend.js` (member site) and `admin-*.js` (admin). `bridges-config.js` holds the project address and the public key (public by design).
- **Email**: Resend, called from the database (`send_email`). The Resend key is stored in Supabase Vault, not in the repo.
- **Certificates**: today stored in the database. The private Cloudflare R2 version is in `worker/` (see `worker/README.md`) and switches on by filling `certWorkerUrl` in `bridges-config.js`.
- **Home banner**: the animated globe (`hero-globe.js` and `fonts/`). It rebuilds itself from the home page, so a new design file does not remove it.
- **Sign-up pages**: `#join` is a chooser (student / alum / referral code). `#join/student` and `#join/alum` are separate pages with no "I am" switch; the choice is remembered through the Google redirect (`bridges-kind`). Built in `bridges-backend.js` (`kindPost`), from the designer's updated artifact.
- **Referral sign-up**: the emailed link opens `#join/referral/CODE` (code first, then Google, then profile, then listed). It lives in `bridges-backend.js` and the database function `check_referral` (`supabase/0007_referral_landing.sql`). Codes are 8 characters; the box accepts up to 15 and ignores spaces, dashes and case.
- **Contact limit**: set in the admin under Settings as a count per day or per week (1 to 500), with an optional own count for Volunteers, Students, Alumni and Faculty. A personal count on a member's profile beats the role, and the role beats the site. A day resets at midnight and a week on Monday, India time. Built in `supabase/0009_contact_limits.sql`; check with `node tests-limits.js ../.env`.
- **Contact counter on the member site**: `bridges-backend.js` ("contact limit" block) reads `my_contact_limit()`, so each member sees their own number, and the wording says "today" instead of "this week" for a daily limit.
- **More than one institute**: a verified member can add extra institutes (Master's, PhD) from My profile, each with its own status (student or alum) and its own verification (institute email, certificate, referral code). It is shown in the directory only once verified. Built in `bridges-backend.js` and `supabase/0008_multi_institute.sql`; checked by `supabase/tests-institutes.js`.
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
node tools/seo-speed.js .
node tools/extract-admin-data.js .
node tools/strip-demo.js .
```
(`wire-backend.js` also puts the globe script and `seo.js` back. `seo-speed.js` puts back the page title, canonical link, structured data, local fonts, admin noindex and the database preconnect. `seo.js` changes the tab title per page.)
Each can be run again safely. They re-attach the backend, the Admin link, the admin text defaults, and drop the prototype's demo passwords.

## Accounts that should all sit in the owner's name
GitHub (repo and Pages), GoDaddy (domain), Supabase, Resend, Cloudflare, and the Google sign-in project (Google Cloud). Nothing here depends on the developer's own logins.

## Not live yet
- Razorpay checkout (the Contribute page runs in test mode; no money moves).
