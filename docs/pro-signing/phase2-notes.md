# Phase 2 — Invitation protection (Modes A & B): implementation notes

Status: **implemented and tested locally; not deployed.** Design: [phase1-assessment.md](phase1-assessment.md).

## What was built

| Area | Files |
|---|---|
| Database (tables, immutability and state-machine triggers, append-only hash-chained audit log, least-privilege `papirma_app` role, RLS, private bucket) | `supabase/migrations/0001_pro_signing.sql` |
| API (single Vercel Function + router) | `api/index.ts`, `server/router.ts`, `vercel.json` |
| Security primitives | `server/crypto.ts` (tokens, hashes), `server/passwords.ts` (Argon2id, generation, strength), `server/rateLimit.ts`, `server/http.ts` (cookies, Origin check, client info), `server/audit.ts`, `server/pdfValidate.ts` |
| Services | `server/services/{senders,documents,invitations,recipient,maintenance}.ts` |
| Integrations | `server/db.ts` (postgres.js → Supabase pooler), `server/storage.ts` (Supabase Storage signed URLs), `server/email.ts` (Resend + invitation template), `server/auth.ts` (Supabase JWT) |
| Sender UI | `/app` → `src/pro/SenderApp.tsx` (sign-in, library, upload, invite ≤ 5, one-time password display, revoke / new password / resend) |
| Recipient UI | `/s` → `src/pro/RecipientApp.tsx` (open link, password step with lockout messages, read-only document review with fingerprint check). Signing tools arrive in Phase 4. |
| Existing app | Unchanged except: pdf.js now loads with `isEvalSupported: false`; analytics never load on `/s`; `/app` and `/s` are lazy-loaded so the free editor's bundle barely changed (+~5 KB). |

**Email OTP (Mode C)** is intentionally rejected (`mode_not_available`) until Phase 3.

## Tests (`npm test`)

66 tests across 5 files, run against a real Postgres 16 engine in-process (PGlite) with the real migration applied, the app running as the restricted `papirma_app` role:

| File | Covers |
|---|---|
| `tests/server/database.test.ts` | T-21 (no document replacement / frozen invitations / state machine / 7-day cap), T-24 (anon & senders can't read secrets or others' rows; private bucket, no storage policies), T-25 (audit append-only even for the owner; server timestamps; hash chain detects out-of-band edits) |
| `tests/server/documents.test.ts` | Server-side SHA-256, versioning, Pro gate, sign-in required, T-11 cross-sender isolation, T-27 non-PDF / encrypted / corrupt / > 25 MiB / > 300 pages / missing upload |
| `tests/server/invitations.test.ts` | Unique hashed tokens, 7-day expiry, Mode A warning, generated & custom passwords (Argon2id, never emailed, never echoed), weak-password rejection, ≤ 5 / no duplicates / no unknown fields, email-failure handling, resend kills old link, revoke rules, cross-sender management blocked |
| `tests/server/recipient.test.ts` | T-01, T-02 (lockout + escalation + sender reset), T-03 (per-IP), T-08 (expired link and expired mid-session), T-09 (revoked, incl. mid-session), T-10 (session can't reach another document), T-12, T-13, T-22 (mode bypass), T-28 (Origin/CSRF), open throttling, cleanup job |
| `tests/server/secrets.test.ts` | T-23: no password, token or session value in any table, email, recipient response or log line |

Not testable locally (need a staging deploy with real Supabase/Resend/Vercel): T-24's storage half against real Supabase Storage, signed-URL expiry, cookie behaviour on the real domain, email deliverability.

## Try it locally (no cloud accounts needed)

```bash
npm run dev:api
```

```bash
npm run dev
```

Then open <http://localhost:5173/app>, sign in with any email (dev mode makes you Pro), upload a PDF and invite someone. Invitation emails appear at <http://localhost:5173/__dev/mail>; open a link there to act as the recipient. Data resets when `dev:api` restarts. `scripts/dev-api.ts` is development-only and is never deployed.

## Production setup checklist (owner)

1. **Domain** (needed for email): buy one and add it to Vercel.
2. **Supabase** — create a **dev** and a **prod** project in **Singapore**.
   * SQL editor → run `supabase/migrations/0001_pro_signing.sql`.
   * Enable the API role login with a long random password (store it in a password manager):
     `alter role papirma_app with login password '<random 32+ chars>';`
   * Auth → enable Email (magic link); set Site URL and redirect URL to `https://<domain>/app`. Optionally enable Google.
   * Mark test senders as Pro: `update public.profiles set plan = 'pro' where id = '<user id>';`
3. **Resend** — add and verify the domain (SPF, DKIM, DMARC); create an API key.
4. **Vercel env vars**
   * Server-only (type **Secret**): `DATABASE_URL` (Supabase *transaction pooler* URI, user `papirma_app.<project-ref>`, port 6543), `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `IP_HMAC_KEY` and `CRON_SECRET` (each 32+ random chars).
   * Server config: `APP_ORIGIN` (`https://<domain>`), `SUPABASE_URL`, `STORAGE_BUCKET=documents`, `EMAIL_FROM` (`Papirma <sign@<domain>>`).
   * Browser (type **Config**, public by design): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
   * Use the **dev** Supabase project for Preview deployments and **prod** for Production.
5. **Deploy to a Preview branch first** and check: upload → invite → open → password → view; signed URL CORS; the cron route; browser console for CSP reports. `vercel.json` ships CSP as **Report-Only**. Switch it to enforcing once no violations appear.

## Known limitations / follow-ups

* Payments aren't built; `plan` is set manually.
* `rate_limits` uses fixed windows in Postgres — fine at this scale, revisit if traffic grows.
* `npm audit` reports advisories in dev dependencies; review before launch.
