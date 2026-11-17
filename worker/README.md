# Certificate Worker (Cloudflare R2)

Certificates are stored in a **private** R2 bucket in Aman's Cloudflare account. The website never sees R2 keys. This Worker moves the bytes, but only after the Supabase database says the caller is allowed (the member's own sign-in is passed to the database). Deleting is automatic: the database queues expired files, and this Worker removes them from R2 every 6 hours.

## What decides who may do what
- Upload: only the applicant, only for their own pending request, only once, only a real JPEG/PNG/WebP up to the size limit in Settings (`max_certificate_bytes`).
- View: the applicant, a volunteer while the request is pending, or an admin with the "verify" permission.
- Delete: 15 days after approval, 30 days after rejection or if never reviewed (database settings), plus a 60-day hard limit on the bucket itself.

## One-time setup (in Aman's Cloudflare account)
1. Aman enables R2: Cloudflare dashboard, Storage & databases, R2 Object Storage, "Add R2 subscription". It is $0 now (10 GB, 1M writes and 10M reads free each month) and bills only past those limits. It needs a payment method on his account.
2. From this folder, signed in to Aman's account (`npx wrangler login`):
   ```
   npm install
   npx wrangler r2 bucket create bridges-certificates
   npx wrangler r2 bucket lifecycle add bridges-certificates safety-60d certs/ --expire-days 60
   npx wrangler secret put WORKER_SECRET      # paste the value of Supabase Vault secret "cert_worker_secret"
   npx wrangler deploy
   ```
3. Put the Worker address that `deploy` prints into `bridges-config.js` as `certWorkerUrl` (for example `https://bridges-certs.<account>.workers.dev`), commit and push. While it is empty the site keeps storing certificates in the database.

## Where it lives now (set up 18 November 2026)
- Cloudflare account: Aman's (`Directorybridges@gmail.com's Account`). The account ID is pinned in `wrangler.toml`, so a deploy cannot land in any other account.
- Bucket: `bridges-certificates` (private, no public access), rule `safety-60d` deletes anything under `certs/` after 60 days.
- Worker: `bridges-certs`, address `https://bridges-certs.directorybridges.workers.dev` (also set as `certWorkerUrl` in `bridges-config.js`). Preview URLs are off. The 6-hourly clean-up runs at minute 30 (00:30, 06:30, 12:30, 18:30 UTC).
- Secret `WORKER_SECRET` is set from the Supabase Vault value `cert_worker_secret`. To rotate: change it in Vault, then run `npx wrangler secret put WORKER_SECRET` with the same value.
- Checked live: 32 end-to-end checks (upload, read, refusals, CORS, deletion queue) and the real clean-up removing a file from R2.

## Test on your own computer (nothing is written to Cloudflare)
```
cd supabase && node apply.js ../.env
cd ../worker && node test-local.js ../.env
```
The test uses the real database with throwaway users and removes them at the end.

## Handover
Everything above lives in Aman's accounts: the bucket, the Worker and its secret. The shared secret also lives in his Supabase Vault. Nothing depends on Tejas's logins.
