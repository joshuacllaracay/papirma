# Papirma Pro — Secure Recipient Signing: Phase 1 Assessment

| | |
|---|---|
| Status | **Draft for owner approval.** No code, infrastructure or production data has been changed. |
| Prepared | 14 November 2026 |
| Scope | Security architecture, auth flows, data model, API, integrity/evidence design, privacy, Philippine legal-readiness gap analysis, implementation and test plan |
| Not legal advice | Legal sections are an engineering reading of public sources, prepared **for review by a Philippine lawyer**. Nothing here certifies Papirma as compliant, binding or admissible. |

---

## 0. Executive summary

**Where Papirma is today.** Papirma is a **100 % client-side** single-page app (Vite + React + TypeScript, deployed on Vercel as static files). PDFs are opened, signed and exported entirely in the browser with pdf.js (render), perfect-freehand (ink) and pdf-lib (export). There is **no backend, database, user account, file storage, email sending or payment** of any kind. The only network calls are static assets and Google Analytics (production only, when `VITE_GA_MEASUREMENT_ID` is set). The current UI promises *"Your document stays on your device — nothing is uploaded."*

**What Pro recipient signing needs that doesn't exist yet:** sender accounts, private document storage, a database, server-side APIs, transactional email, scheduled cleanup, and an evidence store. All security decisions must move to that new backend; the browser only displays and collects.

**Recommended architecture (best balance of security, ease of use, cost):**

| Layer | Choice | Why |
|---|---|---|
| Frontend | Existing Vite/React app, plus a new `/s` recipient route reusing the editor | No rebuild; same editor for senders and recipients |
| API | **Vercel Functions** (Node.js runtime, region `sin1` Singapore), in `/api` of this repo | Same repo, same deploy, no new host |
| Database + auth + storage | **Supabase** (Postgres + Auth + private Storage), region **Singapore** | Relational integrity, transactions and row locks for completion, RLS, triggers for append-only evidence, signed URLs, managed backups (Pro plan) |
| Email | **Resend** (alternative: Postmark) on a Papirma-owned domain | Simple API, low cost, SPF/DKIM/DMARC |
| Password hashing | **Argon2id** (`@node-rs/argon2`) | OWASP-recommended; works on Vercel Node runtime |
| Rate limiting | Postgres counters (atomic `UPDATE … RETURNING`) | Avoids a paid Redis at this scale |

**The most important design decision:** recipients should **not upload a finished PDF**. The browser sends only the signature *annotations* (strokes and signature images with positions). The **server** loads the stored, hash-verified original and burns the signatures in with the same pdf-lib logic Papirma already uses. A recipient therefore **cannot substitute or alter document content**, which closes the "modified document submission" and "document replacement" risks at the root, and gives a clean chain: *original hash → server-generated completed hash*.

**Estimated running cost** (list prices as last known, **verify before purchase**): Vercel Pro ≈ US$20/mo (Vercel's free Hobby plan is for non-commercial use, so a paid SaaS needs Pro), Supabase Pro ≈ US$25/mo (the free tier pauses idle projects and lacks the backups an evidence store needs), Resend free tier (≈3,000 emails/mo) then ≈ US$20/mo, plus a domain ≈ US$10–15/yr. **≈ US$45–65/month** to start.

**Decisions needed before Phase 2** are listed in §16.

---

## 1. Repository inspection findings

| Area | Finding |
|---|---|
| Framework | Vite 6, React 19, TypeScript 5.8, Tailwind 4 |
| PDF pipeline | `src/lib/pdf.ts` (pdf.js 4.10.38 load/render), `src/components/PageView.tsx` (render + ink + eraser), `src/lib/ink.ts` (stroke geometry), `src/lib/exportPdf.ts` (pdf-lib burn-in; uses pdf.js `viewport.convertToPdfPoint` for rotated/cropped pages) |
| Annotation model | `src/types.ts`: `StrokeAnn` (points in page units, size, colour) and `ImageAnn` (PNG data URL + box). Page-unit coordinates at scale 1, top-left origin. **This model is already suitable as the signing payload.** |
| History/undo | `src/lib/history.ts` (reducer) |
| Signatures library | `localStorage` key `papirma.signatures` (browser only) |
| Analytics | `src/lib/analytics.ts` (GA4, prod only, no file names) and a rating prompt (`src/components/RatingDialog.tsx`, `src/lib/rating.ts`) |
| Backend / API | **None** (no `/api`, no server) |
| Database / migrations | **None** |
| Auth / accounts | **None** |
| Storage | **None** (files never leave the browser) |
| Email | **None** |
| Tests | **None** (no test runner configured) |
| Deployment | Vercel static build from GitHub `main`; one env var (`VITE_GA_MEASUREMENT_ID`) |
| Security headers | Vercel defaults only (HTTPS); no CSP or `vercel.json` |
| Notable | pdf.js 4.10.38 is past the CVE-2024-4367 fix (4.2.67), but `isEvalSupported: false` is not set explicitly |

**Implication:** "extend existing tables" doesn't apply yet, because no database exists. The proposed schema (§5) is new, but deliberately minimal: one table per concept, no duplicates.

---

## 2. Threat model (what we defend against)

| # | Threat | Primary control |
|---|---|---|
| T1 | Link forwarded or leaked (email compromise, forwarding, shoulder-surfing) | Mode B/C second factor; 7-day expiry; revocation; token kept out of URLs sent to servers (fragment) |
| T2 | Password brute force / credential stuffing | Argon2id, per-invitation lockout, per-IP throttle, generic errors |
| T3 | OTP guessing / replay | 6 digits, 10 min, 5 attempts, single-use, HMAC-stored, resend limits |
| T4 | Recipient accesses another recipient's or sender's document (IDOR) | All recipient access is derived from a server session bound to **one** invitation; IDs from the client are never trusted |
| T5 | Frontend tampering (switch mode, skip verification, skip consent) | Mode, status and consent enforced in API handlers and DB constraints |
| T6 | Modified or substituted document at completion | Server-side burn-in from the stored original; hash checks |
| T7 | Sender swaps the document after invitations go out | Immutable document versions; invitations pinned to a version; storage objects never overwritten |
| T8 | Duplicate or concurrent completion | Row lock + state machine + unique constraint + idempotency key |
| T9 | Evidence altered or deleted | Append-only tables (triggers), hash chain, no update/delete grants, external anchoring of chain heads |
| T10 | Public exposure of stored PDFs | Private bucket, no public URLs, 60-second signed URLs issued only after authorization |
| T11 | Malicious PDF (parser exploits, huge files) | Size/page limits, server-side parse validation, pdf.js hardening, no inline serving |
| T12 | Secrets or tokens in logs, analytics or referrers | Fragment tokens, `Referrer-Policy: no-referrer`, no body logging, GA disabled on recipient pages |
| T13 | Email spoofing or phishing using Papirma's name | SPF/DKIM/DMARC, consistent email template, no passwords or attachments in mail |
| T14 | Insider / operator misuse | Least-privilege keys, audit of admin actions, tamper-evident chain, documented access policy |

---

## 3. Architecture

### 3.1 Component view

```
 Sender browser (existing editor + new Library/Invite screens)
   │  Supabase Auth session (JWT)          ┌──────────────────────────────┐
   ├────────────── HTTPS ─────────────────▶│ Vercel Functions  /api/*     │
   │                                       │  • authz checks (all of them)│
 Recipient browser (/s#t=<token>)         │  • Argon2id / OTP / tokens   │
   │  HttpOnly session cookie (scoped)     │  • pdf-lib burn-in + SHA-256 │
   ├────────────── HTTPS ─────────────────▶│  • audit events              │
   │                                       └──────┬──────────────┬────────┘
   │   60-second signed URL (GET original) │ service role  │ API key
   ▼                                              ▼              ▼
 Supabase Storage (private bucket) ◀──── Supabase Postgres    Resend (email)
                                          (RLS on, triggers,
                                           append-only evidence)
                Vercel Cron → /api/cron/cleanup (daily retention jobs)
```

* The browser **never** talks to Postgres directly for Pro data. Every read and write goes through `/api`, where authorization is explicit and tested. RLS stays **enabled with deny-by-default** as defence in depth, so a leaked anon key exposes nothing.
* The Supabase **service-role key lives only in Vercel server env vars**; it is never `VITE_`-prefixed and never sent to the browser.
* The **free mode is unchanged**: opening and signing your own PDF stays 100 % local, and the "nothing is uploaded" promise remains true for it. Pro library screens must clearly say documents *are* stored.

### 3.2 How it fits the existing app

| Existing piece | Reuse in Pro |
|---|---|
| `PageView`, `ImageBox`, `SignaturePad`, `SignaturePanel`, `Toolbar`, `history.ts`, `ink.ts` | Used unchanged by the recipient signing screen |
| `types.ts` annotation model | Becomes the `/api/r/complete` payload (validated server-side) |
| `exportPdf.ts` | **Refactored into an isomorphic `burnIn()` module** shared by browser export and server completion. Rotation/crop conversion is reimplemented from pdf-lib page geometry so the server doesn't need pdf.js. Guarded by parity tests (same output as today on rotated and offset-crop PDFs). |
| `App.tsx` | Gains simple routing: `/` (free editor, unchanged), `/app/*` (sender library and invitations), `/s` (recipient signing) |
| `analytics.ts` | Not loaded on `/s` (recipients didn't sign up for Papirma; data minimization) |

Routing needs a `vercel.json` SPA rewrite (`/s`, `/app/*` → `index.html`) alongside the `/api` functions.

### 3.3 Why this stack (alternatives considered)

| Option | Verdict |
|---|---|
| **Vercel Functions + Supabase (recommended)** | One repo and deploy pipeline. Postgres gives transactions, row locks, FKs, CHECK constraints and triggers, which matter for evidence. Singapore region is close to PH users. Lowest learning curve from today's code. |
| Firebase (Firestore + Storage + Functions) | Weaker relational guarantees; append-only evidence and unique-completion constraints are harder; security rules are less testable for this workflow. |
| Cloudflare Workers + D1 + R2 | Cheapest at scale, but a second platform; D1/SQLite has fewer integrity features; Argon2 needs WASM and has tighter CPU limits. Reasonable later, not now. |
| Self-hosted VPS + Postgres | Most control, but you'd own patching, backups, TLS and uptime, which is the wrong trade-off for a solo early SaaS. |

---

## 4. Authentication & authorization flows

### 4.1 Sender (Pro user)

* **Supabase Auth**: email magic link and/or Google sign-in. No passwords stored by Papirma for senders.
* API calls carry the Supabase access token (`Authorization: Bearer …`). Each handler verifies the JWT with Supabase, loads the profile, checks `plan = 'pro'` for Pro actions, and checks **ownership** of every referenced document/version/invitation (`owner_id = user.id`).
* Payment is out of scope; for now `plan` is set manually by an admin. A PH payment provider (e.g. PayMongo) is a separate project.

### 4.2 Invitation creation (all modes)

1. Sender picks a **ready** document version and enters ≤ 5 recipient emails (validated, de-duplicated, lower-cased), with a mode per recipient.
2. For each recipient the server:
   * generates a **32-byte CSPRNG token** (`crypto.randomBytes(32)`, base64url ≈ 43 chars) and stores only **`SHA-256(token)`** (a high-entropy token doesn't need a slow hash);
   * sets `expires_at = now() + 7 days` (server time) and `workflow_version`;
   * **Mode B:** generates a password (default: 16 characters from a 32-symbol unambiguous alphabet ≈ 80 bits, shown as `K7QF-M2XR-…` for reading over the phone), or accepts a sender-chosen one only if it is ≥ 12 characters, scores ≥ 3 on zxcvbn and doesn't contain the recipient's email or name; stores **Argon2id** (`m = 19 MiB, t = 2, p = 1` minimum per OWASP, tuned to ~100–250 ms on Vercel);
   * returns the plaintext password **once** in the API response for the sender to copy. It is never stored, logged or emailed. Losing it means "Reset password" (which generates a new one and audits the reset).
3. Invitation email (Resend) goes to the recipient: sender display name, document title (sender can choose to hide it), link `https://<domain>/s#t=<token>`, expiry date, and for Mode B: *"<Sender> will send you a password separately."* No attachment, no password, no OTP.
4. Audit: `invitation_created`, `invitation_email_sent` (or `…_failed`).

**Why the token goes in the `#fragment`:** fragments are never sent to servers, so the token stays out of Vercel/CDN access logs, proxy logs and `Referer` headers. The recipient page reads it with JS and POSTs it once.

### 4.3 Recipient verification

```
open /s#t=TOKEN ──POST /api/r/open {token}──▶ lookup SHA-256(token)
     │                                        • not found / revoked / expired / completed → generic state, no doc data
     │                                        • returns {mode, senderName, expiresAt, state}
     ├─ Mode A: open itself creates a recipient session ─────────────────┐
     ├─ Mode B: POST /api/r/verify-password {token, password}            │
     │          lockout check → Argon2id verify → success/failure audit  │
     └─ Mode C: POST /api/r/otp/send {token}  → code emailed to the      │
                stored recipient_email (never an address from the client)│
                POST /api/r/otp/verify {token, code}                     │
                                                                         ▼
                         recipient_sessions row (hash only) + Set-Cookie:
                         __Host-papirma_rs=<random>; HttpOnly; Secure;
                         SameSite=Strict; Path=/; Max-Age=1800
```

* **Mode enforcement is server-side.** `security_mode` is written at creation and made **immutable** by a DB trigger. A session can be created only by the verification path that matches the stored mode. Mode A is the only path that creates a session from the token alone. No request parameter can change the mode.
* **Session scope:** a recipient session references exactly one invitation. Every `/api/r/*` handler loads the session, joins the invitation, re-checks `status ∉ {revoked, expired}` and `expires_at > now()`, and only ever uses `invitation.document_version_id`. Cross-recipient access is structurally impossible.
* **Session lifetime:** 30 minutes, with sliding renewal while active up to 2 hours max. Revoking an invitation revokes its sessions immediately.
* **Mode A warning** (sender UI and recipient email): *"Anyone who has this link can open and sign the document until it expires or you revoke it. Use password or email code for sensitive documents."*

**Throttling (Mode B):**

| Limit | Value |
|---|---|
| Per invitation | 5 failures → locked 15 min; lockout doubles each time; 15 total failures → locked until the sender resets the password |
| Per client IP (HMAC'd) | 30 failed verifications/hour across all invitations |
| Response | Identical generic message and similar timing for "wrong password", "locked" and "unknown" |

**OTP (Mode C):**

| Property | Value |
|---|---|
| Code | 6 digits via `crypto.randomInt` |
| Storage | `HMAC-SHA256(OTP_PEPPER, invitation_id ‖ code)`; the pepper is a server-only secret, so a DB leak can't be brute-forced offline |
| Expiry | 10 minutes (server time) |
| Attempts | 5 per code; then the code is burned |
| Single use | `consumed_at` set atomically on success; any reuse fails |
| New code | supersedes all previous codes for that invitation |
| Resend | ≥ 60 s cooldown; ≤ 5 codes/hour; ≤ 10/day per invitation |
| Email | Code only, no link to the document; *"If you didn't request this, ignore it."* |

### 4.4 Sender access to results

The sender sees invitation status, the audit timeline and the completed PDF via **60-second signed URLs** issued after an ownership check. The sender can revoke, reset a password, resend (which issues a **new** token and invalidates the old one) and download evidence JSON.

---

## 5. Database design (Postgres / Supabase)

Proposed migration `0001_pro_signing.sql` (draft, not applied):

```sql
create extension if not exists pgcrypto;
create extension if not exists citext;

-- Sender profile (1:1 with Supabase auth.users)
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  plan          text not null default 'free' check (plan in ('free','pro')),
  created_at    timestamptz not null default now()
);

-- Reusable library item
create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete restrict,
  title       text not null check (char_length(title) between 1 and 200),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index documents_owner_idx on public.documents(owner_id) where deleted_at is null;

-- Immutable file versions; invitations pin to one
create table public.document_versions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents(id) on delete restrict,
  version       int  not null check (version > 0),
  storage_path  text not null unique,                       -- orig/{owner}/{doc}/{version_id}.pdf
  status        text not null default 'pending' check (status in ('pending','ready','rejected')),
  sha256        bytea check (sha256 is null or octet_length(sha256) = 32),
  byte_size     int   check (byte_size is null or byte_size between 1 and 26214400),  -- 25 MiB
  page_count    int   check (page_count is null or page_count between 1 and 300),
  created_at    timestamptz not null default now(),
  unique (document_id, version),
  check (status <> 'ready' or (sha256 is not null and byte_size is not null and page_count is not null))
);
-- trigger dv_freeze: once status = 'ready', storage_path/sha256/byte_size/page_count can never change

create type public.invitation_mode   as enum ('link','password','email_otp');
create type public.invitation_status as enum ('pending','opened','completing','completed','revoked','expired');

create table public.invitations (
  id                   uuid primary key default gen_random_uuid(),
  document_version_id  uuid not null references public.document_versions(id) on delete restrict,
  sender_id            uuid not null references public.profiles(id) on delete restrict,
  recipient_email      citext not null check (char_length(recipient_email::text) <= 254),
  security_mode        public.invitation_mode not null,
  token_hash           bytea not null unique check (octet_length(token_hash) = 32),
  password_hash        text,                                   -- Argon2id PHC string, Mode B only
  password_set_at      timestamptz,
  failed_attempts      int  not null default 0,
  total_failed         int  not null default 0,
  locked_until         timestamptz,
  status               public.invitation_status not null default 'pending',
  workflow_version     text not null,                          -- e.g. 'pro-sign/1'
  expires_at           timestamptz not null,
  first_opened_at      timestamptz,
  revoked_at           timestamptz,
  revoked_reason       text check (revoked_reason is null or char_length(revoked_reason) <= 200),
  created_at           timestamptz not null default now(),
  check ((security_mode = 'password') = (password_hash is not null)),
  check (expires_at <= created_at + interval '7 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index invitations_sender_idx  on public.invitations(sender_id, created_at desc);
create index invitations_version_idx on public.invitations(document_version_id);
create index invitations_expiry_idx  on public.invitations(expires_at) where status in ('pending','opened');
-- trigger inv_freeze: document_version_id, sender_id, recipient_email, security_mode, token_hash immutable
-- trigger inv_status: only allowed transitions (pending→opened→completing→completed; *→revoked; *→expired;
--                     completing→opened on failed completion); completed/revoked/expired are terminal

create table public.otp_challenges (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid not null references public.invitations(id) on delete cascade,
  code_hmac      bytea not null check (octet_length(code_hmac) = 32),
  attempts       int  not null default 0 check (attempts between 0 and 5),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  superseded_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index otp_inv_idx on public.otp_challenges(invitation_id, created_at desc);

create table public.recipient_sessions (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid not null references public.invitations(id) on delete cascade,
  token_hash     bytea not null unique check (octet_length(token_hash) = 32),
  verified_via   public.invitation_mode not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at     timestamptz
);
create index rs_inv_idx on public.recipient_sessions(invitation_id);

-- One completion per invitation, ever
create table public.signing_completions (
  id                      uuid primary key default gen_random_uuid(),
  invitation_id           uuid not null unique references public.invitations(id) on delete restrict,
  document_version_id     uuid not null references public.document_versions(id) on delete restrict,
  original_sha256         bytea not null check (octet_length(original_sha256) = 32),
  completed_sha256        bytea not null check (octet_length(completed_sha256) = 32),
  completed_storage_path  text  not null unique,             -- done/{invitation_id}/{uuid}.pdf
  verification_method     public.invitation_mode not null,
  consent_text_version    text  not null,                    -- e.g. 'consent/2026-11-v1'
  consent_accepted_at     timestamptz not null,
  completed_at            timestamptz not null default now(),
  workflow_version        text  not null,
  annotation_summary      jsonb not null,                    -- counts + bounding boxes per page; no image bytes
  idempotency_key         uuid  not null unique
);

-- Append-only, hash-chained audit log
create table public.audit_events (
  id             bigint generated always as identity primary key,
  invitation_id  uuid references public.invitations(id) on delete restrict,
  document_id    uuid references public.documents(id)   on delete restrict,
  actor_type     text not null check (actor_type in ('sender','recipient','system','admin')),
  actor_id       uuid,
  event_type     text not null,           -- see §7.2 catalogue
  occurred_at    timestamptz not null default now(),
  details        jsonb not null default '{}'::jsonb,  -- never secrets, tokens, codes, passwords
  ip_address     inet,                    -- only if approved (§16 decision D4)
  user_agent     text check (user_agent is null or char_length(user_agent) <= 300),
  prev_hash      bytea,
  event_hash     bytea not null
);
create index audit_inv_idx on public.audit_events(invitation_id, id);
create index audit_doc_idx on public.audit_events(document_id, id);
-- BEFORE INSERT trigger: takes pg_advisory_xact_lock(hash(invitation_id)), reads the previous event_hash
--   for that invitation, sets prev_hash and event_hash = sha256(prev_hash ‖ canonical(row)); forces occurred_at = now()
-- BEFORE UPDATE / DELETE / TRUNCATE triggers on audit_events and signing_completions: raise exception

-- Throttling counters (no Redis needed)
create table public.rate_limits (
  key           text primary key,         -- e.g. 'pwfail:ip:<hmac>', 'otp:send:<invitation_id>'
  window_start  timestamptz not null,
  count         int not null
);
```

**Authorization policies:**

* RLS **enabled on every table**. The browser never queries these tables, so `anon` gets **no policies at all** (deny all).
* `authenticated` (senders), as a backstop: `select` on `profiles` (own row), `documents` (own), `document_versions`/`invitations`/`signing_completions`/`audit_events` (via ownership join). **No insert/update/delete policies.** All writes go through the API. `invitations` is exposed through a `security_invoker` view that omits `token_hash`, `password_hash` and counters.
* `otp_challenges`, `recipient_sessions`, `rate_limits`: no policies (server only).
* **Storage:** one private bucket `documents`, `public = false`, no policies for anon/authenticated. Only the server (service role) reads and writes; clients receive **60-second signed URLs** (GET original after authorization; PUT for sender uploads). Object paths contain random UUIDs, and objects are **never overwritten** (`upsert: false`).
* Revoke `UPDATE, DELETE, TRUNCATE` on `audit_events` and `signing_completions` from `anon`, `authenticated` **and the app's service role**. Triggers also block them. Only a separately held migration/owner role could change them, and that is itself detectable via the hash chain (§7.3).

---

## 6. API design (Vercel Functions)

All endpoints are JSON over HTTPS, reject unknown fields (zod schemas), cap body sizes, return generic errors, and never echo secrets. State-changing sender endpoints require `Authorization: Bearer <supabase jwt>` and an `Origin` check. Recipient endpoints use the `__Host-` cookie plus an `Origin` check (CSRF defence on top of `SameSite=Strict`).

### Sender

| Method & path | Purpose | Key checks |
|---|---|---|
| `POST /api/documents` | Create library item + v1; returns 60 s **signed upload URL** | pro plan; title length |
| `POST /api/documents/:id/versions` | New version (never replaces old) | owner |
| `POST /api/document-versions/:id/finalize` | Server downloads upload, validates PDF, computes SHA-256, sets `ready` | owner; size ≤ 25 MiB; `%PDF-` magic; parses with pdf-lib; not encrypted; ≤ 300 pages |
| `GET /api/documents` · `DELETE /api/documents/:id` | List / soft-delete | owner; delete blocked while open invitations exist (revoke first) |
| `POST /api/invitations` | ≤ 5 recipients, per-recipient mode, optional sender password | owner; version `ready`; email syntax; password strength; returns generated passwords **once** |
| `GET /api/invitations?documentId=` | Status list (no secrets) | owner |
| `POST /api/invitations/:id/revoke` | Revoke + kill sessions | owner; not completed |
| `POST /api/invitations/:id/reset-password` | New generated password (shown once), counters reset | owner; Mode B |
| `POST /api/invitations/:id/resend` | New token (old hash replaced → old link dead), new email | owner; not completed/revoked; rate-limited |
| `GET /api/invitations/:id/completed-pdf` | 60 s signed URL | owner; completed |
| `GET /api/invitations/:id/evidence` | Evidence JSON (completion record + audit chain + verification result) | owner |

### Recipient

| Method & path | Purpose | Key checks |
|---|---|---|
| `POST /api/r/open` `{token}` | State + mode; Mode A issues session | token hash lookup; status/expiry; per-IP rate limit |
| `POST /api/r/verify-password` `{token,password}` | Mode B → session | lockouts; Argon2id |
| `POST /api/r/otp/send` `{token}` | Mode C → email code to the stored address | cooldowns; quotas |
| `POST /api/r/otp/verify` `{token,code}` | Mode C → session | attempts; expiry; single use |
| `GET /api/r/document` | Title, page count, original SHA-256, 60 s signed GET URL | session; invitation not terminal |
| `POST /api/r/complete` | Consent + annotations → server burn-in | see §7.1 |
| `GET /api/r/completed-pdf` | Recipient's copy (signed URL) | session; completed |

### System

| `GET /api/cron/cleanup` | Daily retention job (Vercel Cron) | `CRON_SECRET` header |
|---|---|---|

Secrets (Vercel env, **server only**): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `OTP_PEPPER`, `IP_HMAC_KEY`, `CRON_SECRET`. A separate dev Supabase project means test runs never touch production.

---

## 7. Document integrity & signing evidence

### 7.1 Completion algorithm (`POST /api/r/complete`)

Payload: `{ idempotencyKey, expectedOriginalSha256, consent: { accepted: true, textVersion }, annotations: [...] }`

1. **Authorize:** valid recipient session → invitation.
2. **Validate input** (before any work): `consent.accepted === true` and `textVersion` is the current one, otherwise `400 consent_required`. Annotations: ≥ 1 signature-like item; ≤ 200 strokes; ≤ 10 images; each PNG ≤ 1 MiB decoded with valid PNG magic; coordinates within page bounds; total body ≤ 4 MB (fits the Vercel request limit).
3. **Lock & transition:** in a transaction, `SELECT … FOR UPDATE` the invitation. If `completed`, return the existing completion when the idempotency key matches, otherwise `409 already_completed`. Require `opened`, then set `completing`, write audit `consent_accepted` (server timestamp) and `completion_started`, and commit. *(A concurrent second request blocks on the lock, then sees `completing`/`completed` and gets `409`.)*
4. **Load original** from storage with the service role, recompute SHA-256, and require it to equal `document_versions.sha256` (detects storage tampering) **and** `expectedOriginalSha256` (the recipient saw exactly this version).
5. **Burn in** with the shared `burnIn()` (same pdf-lib logic as today's download).
6. **Hash** the result (`completed_sha256`), upload to `done/{invitation_id}/{uuid}.pdf` with `upsert:false`, and read back the size to confirm.
7. **Finalize** in a transaction: insert `signing_completions` (unique per invitation), set invitation `completed`, revoke other sessions except the current one (needed for the download), audit `completion_succeeded`, commit.
8. **On any failure in 4–7:** delete any partial object, set status back to `opened`, audit `completion_failed {stage}`, and return `503 retry`. The recipient keeps their annotations in the browser and can retry with the **same idempotency key**.
9. Notify sender (and recipient) by email that signing is complete. The email contains no PDF attachment, just a link to sign in or re-verify.

### 7.2 Evidence captured

Per the requirements, all timestamps are **Postgres `now()` (UTC)**, never client clocks.

| Evidence | Where |
|---|---|
| Invitation ID, document ID + version, workflow version | `signing_completions`, `invitations` |
| Verification method (+ success event and time) | `signing_completions.verification_method`, `audit_events` |
| Consent text version + acceptance time | `signing_completions` + `consent_accepted` event |
| Signing completion time | `signing_completions.completed_at` |
| Original SHA-256 / completed SHA-256 | `signing_completions` (+ `document_versions.sha256`) |
| Annotation summary (what was placed where, not the image bytes) | `signing_completions.annotation_summary` |
| Audit events | `invitation_created`, `invitation_email_sent`, `invitation_opened`, `password_failed`, `password_locked`, `password_verified`, `password_reset`, `otp_sent`, `otp_failed`, `otp_verified`, `document_viewed`, `consent_accepted`, `completion_started`, `completion_failed`, `completion_succeeded`, `completed_pdf_downloaded`, `invitation_revoked`, `invitation_expired`, `invitation_resent` |

**Consent UI:** an unticked checkbox with the wording *"I intend to sign this document electronically, and I confirm that the signature I have placed represents my approval of the document."* The **Complete Signing** button stays disabled until the box is ticked **and** at least one signature is placed. The server enforces both again.

**Optional (recommended):** an appended **"Signing summary" page** in the completed PDF (invitation ID, signer email, verification method, UTC times, original SHA-256). This helps anyone holding just the PDF; the completed hash is computed after it is appended.

### 7.3 Tamper-evidence (honest limits)

* App roles can't update or delete evidence (grants + triggers).
* Every audit row is hash-chained per invitation. `GET …/evidence` re-verifies the chain and reports *intact / broken at event N*.
* **Limit:** a database owner/superuser could disable triggers and rewrite the chain. To make that detectable, the daily cron publishes the latest chain heads to a separate append-only location (e.g. an object-locked S3/R2 bucket, or a daily digest emailed to a Papirma admin inbox). Describe this as **tamper-evident**, never "tamper-proof".
* **No trusted timestamping** (RFC 3161) or **certificate-based PDF signature** (PAdES) in this phase. Papirma places **electronic signatures** (visual marks plus an evidence record). It does **not** create cryptographic digital signatures, and the UI and PDF must never call the result "digitally signed". A future option is a Papirma platform seal (PAdES) on completed PDFs for tamper detection; that is still Papirma's seal, not the signer's digital signature. Another is integration with certificate-based signing such as DICT PNPKI (§8).

### 7.4 Document replacement & versioning

* Invitations reference `document_version_id`, which is immutable (trigger).
* Versions are immutable once `ready`; storage objects are never overwritten.
* Uploading a "new" file creates version N+1. Existing invitations keep pointing at version N. To make recipients sign N+1, the sender must revoke and reissue, which is audited.
* Multi-recipient (≤ 5): each recipient signs the same original **independently**, producing up to five separate completed PDFs. A combined, sequential "all signatures on one PDF" flow is a later feature (§16, D3).

---

## 8. Philippine legal-readiness — compliance gap analysis

> Prepared from public sources on 14 Nov 2026 (links in §15). Items marked **⚠ verify** relied on secondary sources because the official site couldn't be reached during research. **Every row needs Philippine counsel's review.**

### 8.1 Key legal points (engineering reading)

* **RA 8792 (E-Commerce Act, 2000)**
  * **§5(e)** defines an *electronic signature* broadly: a distinctive mark or method in electronic form, attached to or logically associated with a document, adopted with intent to authenticate or approve it. Papirma's placed signatures plausibly fall within this; the legal effect depends on **§8**.
  * **§7:** electronic documents have legal effect, and a writing requirement is met if **integrity and reliability** are maintained and the document can be authenticated. §7 **does not vary formalities** other laws require (e.g. notarization, public instruments).
  * **§8:** an e-signature is equivalent to a handwritten one if a **prescribed procedure, not alterable by the parties interested**, shows that:
    * (a) the method **identifies the party** and indicates their **access to the document** and consent;
    * (b) the method is **reliable and appropriate** for the purpose;
    * (c) signing was **necessary to proceed** with the transaction;
    * (d) the other party is **authorized and enabled to verify** the signature and decide to proceed.
  * **§9:** presumptions that the signature belongs to the correlated person and was affixed with intent to sign, unless the relying party knew of defects or reliance was unreasonable.
  * **§11:** authentication via proof of an electronic symbol adopted with intent, and/or a security procedure that verifies the originator or detects alteration.
  * **§13:** retention must be accessible, in its original or an accurately representative format, and identify originator, addressee and date/time.
  * **§31–32:** lawful access and confidentiality.
* **Rules on Electronic Evidence (A.M. No. 01-7-01-SC, 2001)** ⚠ verify numbering against the official text
  * The proponent must **authenticate** a private electronic document or signature, by digital signature, appropriate security procedures, or other evidence of integrity and reliability satisfactory to the court.
  * Evidentiary **weight** considers the reliability of how the record was generated, stored and communicated, how the originator was identified, the integrity of the information system, and similar factors.
  * In practice: Papirma's evidence record (verification method, server timestamps, hashes, audit chain, system documentation) is what a party would use to authenticate; it **supports** but does not **guarantee** admissibility or weight.
* **Electronic notarization:** the Supreme Court approved the **Rules on Electronic Notarization (A.M. No. 24-10-14-SC)** in early 2025. They cover PDF/PDF-A documents, in-person or remote e-notarization by **Electronic Notaries Public** through **accredited electronic notarization facilities**. ⚠ verify effectivity and rollout dates on sc.judiciary.gov.ph; sources conflict. **Papirma is not an e-notarization facility.** Documents that legally need notarization or a public instrument (e.g. many real-property conveyances and affidavits; wills have their own formal requirements) are **not** completed by a Papirma signature.
* **Digital certificates:** DICT runs the **Philippine National PKI (PNPKI)**, which issues certificate-backed digital signatures, including to private individuals (⚠ verify current eligibility). This is distinct from Papirma's electronic-signature placement.
* **RA 10173 (Data Privacy Act, 2012) + IRR (as amended)**
  * Lawful basis, transparency, proportionality and data minimization; data-subject rights; security measures; **accountability** for processors and transfers abroad (Supabase/Vercel/Resend infrastructure outside the PH ⇒ cross-border processing; NPC model contractual clauses exist, ⚠ verify Advisory 2024-01).
  * **NPC Circular 2023-06** (security of personal data, government *and* private sector; in force 2024; repealed 16-01): organizational, physical and technical measures, access control, encryption, etc.
  * **NPC Circular 16-03:** breach notification to NPC and affected data subjects **within 72 hours** of knowledge or reasonable belief of a notifiable breach. ⚠ check NPC Advisory 2026-02 on the online breach-notification system.
  * **NPC Circular 2022-04:** DPO and data-processing-system **registration** is mandatory at ≥ 250 employees, **or processing sensitive personal information of ≥ 1,000 individuals**, or processing likely to pose risk (incl. automated decisions). **Uploaded documents may contain sensitive PI** (IDs, health, financial), so this needs counsel's view early.
  * **NPC Circular 2023-04** (Guidelines on Consent; obligations from May 2024): relevant to marketing/analytics consent and the recipient notice. Signing itself likely rests on contract/legitimate-interest bases rather than consent (counsel to confirm).

### 8.2 Gap table

| # | Legal requirement / expectation | Papirma today | Technical control (planned) | Missing | Operational policy needed | Lawyer review |
|---|---|---|---|---|---|---|
| L1 | RA 8792 §8(a): identify signer; show access to document | None (anyone can sign anything locally) | Unique per-recipient invitation; Mode B/C verification; audit of verification; session bound to one invitation | Identity proofing beyond email/password possession (no ID check) | Guidance on choosing mode by risk | Is email OTP or password sufficient "identification" for the intended document types? |
| L2 | §8(b): reliable and appropriate method | n/a | Documented workflow version, hashing, server burn-in, audit chain, tests | Independent security review / pen test | System description document; change control for workflow versions | What documentation best supports "reliable and appropriate"? |
| L3 | §8 "prescribed procedure not alterable by the parties" | n/a | Workflow enforced server-side; senders/recipients cannot edit evidence; immutable versions | External anchoring of evidence (planned) | Admin access policy; separation of duties | Does operator access undermine "not alterable"? |
| L4 | §8(c): signing necessary to proceed | n/a | Complete Signing requires ≥ 1 signature + consent | None | — | Confirm |
| L5 | §8(d): other party can verify | n/a | Sender evidence view + JSON export; hash verification; signing summary page | Public "verify a document by hash" page (optional) | — | Is sender-side verification enough? |
| L6 | §7/§10: integrity of document | Local export only | SHA-256 original + completed; immutable storage paths; chain | Platform PDF seal (PAdES) optional | Retention policy | Is SHA-256 + audit adequate, or is a PDF seal advisable? |
| L7 | §13: retention (accessible, original format, originator/addressee/time) | None | Stored completed PDF + evidence record with emails and server timestamps | Long-term format (PDF/A) not guaranteed | Retention schedule (§10) | Required retention periods per document type |
| L8 | REE: authentication and evidentiary weight | None | Evidence package; system documentation; logs | Affidavit/testimony template for custodian | Records-custodian procedure; how to respond to subpoenas | Admissibility strategy |
| L9 | Formalities: notarization / public instruments | Not addressed | Product copy + ToS disclaimers; optional "this document needs notarization?" warning | No e-notarization (out of scope) | User guidance | List of document types users must not rely on Papirma for |
| L10 | DPA: transparency & privacy notice | Basic UI line ("nothing is uploaded"); GA without notice | Privacy Policy; recipient signing notice shown before verification; GA disabled on `/s` | Notices don't exist yet | Privacy Policy, notices (§12) | PIC vs PIP roles; lawful bases |
| L11 | DPA: data minimization & proportionality | Local-only (good) | Store only email, verification metadata, hashes; IP/UA only if approved; no tracking on recipient pages | Decision on IP/UA (D4) | Data inventory / RoPA | Is IP/UA justified as evidence? |
| L12 | DPA / NPC 2023-06: security measures | HTTPS only | §9 controls | Pen test, security policies, staff (owner) training | Information security policy; access reviews | Adequacy |
| L13 | DPA: cross-border processing accountability | GA (US) already | DPAs with Supabase, Vercel, Resend; Singapore regions where possible | Signed processor terms; transfer assessment | Vendor management register | Model clauses / disclosures |
| L14 | NPC 16-03: breach notification in 72 h | None | Logs, alerting, evidence of access | Incident runbook | Incident Response Policy (§12) | Notification templates |
| L15 | NPC 2022-04: DPO & registration | None | — | DPO designation; registration assessment | DPO appointment; registration if thresholds met | Whether thresholds are met (sensitive PI in documents) |
| L16 | Data-subject rights (access, erasure, etc.) vs evidence retention | n/a | Sender delete; account deletion; evidence retained per policy | Rights-request workflow | DSAR procedure | Balancing erasure vs legal-claims retention |
| L17 | Consent for analytics/marketing (NPC 2023-04) | GA loads without a banner | Consent banner or switch to cookieless analytics; none on `/s` | Banner | Cookie policy | Is GA lawful without consent? |

### 8.3 Claims Papirma must **not** make

* "Legally binding" (for all documents), "guaranteed enforceable", "court-admissible", or "equivalent to a wet signature for every document".
* "Compliant with RA 8792 / Data Privacy Act / NPC" or "NPC registered", until a lawyer-reviewed assessment and registration (if required) are done.
* "Certified", "accredited", "DICT/NPC/Supreme Court approved", "e-notarized" or "notarized".
* "Digitally signed", "PKI", "certificate-based" or "qualified signature" for Papirma's electronic signatures.
* "Tamper-proof", "unhackable", "bank-grade" or "military-grade". Use "tamper-evident" and describe specific controls.
* "End-to-end encrypted" (the server can read stored PDFs to burn in signatures; say "encrypted in transit and at rest").
* "Nothing is uploaded" anywhere on Pro features (it stays true **only** for the free local editor).

Safe phrasing example: *"Papirma records an audit trail and document fingerprints (SHA-256) to help you show who signed, when, and that the document hasn't changed. Whether an electronic signature is appropriate for a particular document depends on the law that applies to it; some documents require notarization or other formalities. Consult a lawyer if unsure."*

---

## 9. Privacy & data-security controls checklist

| Requirement | Control |
|---|---|
| HTTPS | Vercel TLS; HSTS header (`max-age=63072000; includeSubDomains; preload` after domain setup) |
| Private PDF storage | Private Supabase bucket; no anon/authenticated policies |
| No permanent public URLs | Only 60-second signed URLs, issued per authorized request |
| Sender/recipient access control | §4–§6; ownership checks + invitation-scoped sessions |
| Secure token generation | 32 bytes CSPRNG; base64url |
| Token hashing | SHA-256 for invitation and session tokens (high entropy) |
| Expiry & revocation | 7-day invitations (DB CHECK); 30-minute sessions; revoke kills sessions; daily expiry job |
| Password hashing & throttling | Argon2id; lockouts; per-IP limits; generic errors |
| OTP expiry & throttling | §4.3 table |
| Direct object-storage transfers | Signed upload/download URLs (bypass the function body limit; no file bytes through logs) |
| PDF validation & safe rendering | Server: size/page limits, magic bytes, pdf-lib parse, reject encrypted/XFA. Client: pdf.js with `isEvalSupported: false`, fetch as ArrayBuffer (never open the PDF URL directly), `Content-Disposition: attachment` on signed URLs |
| Upload limits | 25 MiB, 300 pages (configurable) |
| Cross-user isolation | Server-side ownership joins; RLS backstop; tests T-05..T-08 |
| Data minimization | Recipient: email + verification metadata only. No GA on `/s`. Annotation images stored only inside the completed PDF |
| Retention cleanup | Daily cron (§10) |
| Privacy-conscious logs | No request bodies on auth/complete endpoints; tokens only in fragments; redact `password`, `code`, `token` keys; IPs only as HMAC in rate limits |
| Security headers | `vercel.json`: CSP (`default-src 'self'`; GA hosts only on non-`/s` routes; `frame-ancestors 'none'`), `Referrer-Policy: no-referrer` (at least on `/s`), `X-Content-Type-Options: nosniff`, `Permissions-Policy` |
| Email security | SPF, DKIM, DMARC (`p=quarantine`→`reject`) on the sending domain; no attachments; consistent template |
| Breach response | Incident Response Policy (§12); audit and logs support investigation; 72-hour NPC clock |
| Secrets | Server-only env vars; separate dev/prod projects; key rotation procedure; secret scanning in CI (gitleaks) |

---

## 10. Retention recommendations (draft for counsel)

| Data | Proposed retention | Mechanism |
|---|---|---|
| OTP challenges | Delete 24 h after creation | cron |
| Recipient sessions | Delete 24 h after expiry | cron |
| Rate-limit counters | Delete after window (≤ 24 h) | cron |
| Invitations never completed | Mark `expired` at 7 days; delete row + audit 90 days after expiry (or keep minimal audit, counsel to decide) | cron |
| Original PDFs | While the sender keeps them in the library; deleted ≤ 30 days after sender deletes or closes the account | soft-delete + cron purge from storage |
| Completed PDFs | Same as originals by default; sender-configurable | cron |
| Signing evidence (completions + audit chain) | **Proposal: 10 years** after completion (aligned with long contract prescriptive periods, ⚠ counsel to confirm), retained even if the PDFs are deleted, but only hashes, emails, timestamps and method, not document content | protected tables; separate purge after period |
| Backups | Supabase PITR/backups per plan (e.g. 7–14 days); deleted data ages out of backups | provider |
| Application logs | 30 days max, no secrets | Vercel log retention / drain config |

---

## 11. Security test plan

**Tooling:** Vitest (unit + API handler integration), a **local Supabase stack** (Supabase CLI; needs Docker Desktop on Windows) with migrations applied fresh per run, and Playwright for end-to-end recipient flows. Run in GitHub Actions on every PR; never against production.

| ID | Test | Expected |
|---|---|---|
| T-01 | Invalid password | 401 generic; `failed_attempts+1`; audit `password_failed` (no password in details) |
| T-02 | Brute force: 6 rapid wrong passwords | 6th → locked; correct password during lockout still rejected; lock expiry respected; 15 total → sender reset required |
| T-03 | Per-IP throttle across many invitations | 429 after threshold |
| T-04 | Expired OTP (clock advanced 11 min) | rejected; audit `otp_failed{reason:expired}` |
| T-05 | OTP replay (reuse a consumed code) | rejected |
| T-06 | OTP after resend (old code) | rejected (superseded) |
| T-07 | OTP send cooldown and quotas | 429 |
| T-08 | Expired signing link (8 days) | `open` returns expired state; no session; no document data |
| T-09 | Revoked link, and revoke mid-session | open → revoked; existing session's `/api/r/document` → 401 |
| T-10 | Cross-recipient access: session for A requesting B's document/complete | impossible by construction; test forged IDs in body/query are ignored or rejected |
| T-11 | Sender X accessing sender Y's documents/invitations/evidence | 404 |
| T-12 | Unauthorized PDF download (no session, wrong session, guessed storage path, expired signed URL) | 401/403; storage returns 400/403 |
| T-13 | Reused token after completion | `open` → completed state; no new session for signing; `complete` → 409 |
| T-14 | Concurrent completion (two parallel requests) | exactly one `signing_completions` row; other 409 |
| T-15 | Idempotent retry with same key after success | same result, no duplicate |
| T-16 | Modified document: `expectedOriginalSha256` mismatch | 409; nothing written |
| T-17 | Storage tamper: original object changed behind the DB | completion refuses (hash mismatch), audit `completion_failed{stage:integrity}` |
| T-18 | Failed upload of completed PDF (storage error injected) | status back to `opened`; no partial object; retry succeeds |
| T-19 | Missing consent / `accepted:false` / stale consent version | 400; nothing written |
| T-20 | No signature in annotations; oversized image; out-of-bounds coordinates | 400 |
| T-21 | Document replacement after invitations issued: attempt to update version row / overwrite object | DB trigger error / storage refuses; invitations still point to original version |
| T-22 | Mode bypass: password-mode invitation calling `open` expecting a session, or OTP-mode calling `verify-password` | no session |
| T-23 | Secret exposure: scan API responses, audit `details`, logs and emails for passwords, codes and tokens | none present (automated assertions + gitleaks on repo) |
| T-24 | Unauthenticated private storage access with anon key (list/get/put) | denied |
| T-25 | Audit tampering: UPDATE/DELETE/TRUNCATE audit_events and signing_completions as app roles | denied; hash-chain verification detects a manual row edit made by the owner role |
| T-26 | `burnIn()` parity: server output vs current browser export on normal, rotated (90/180/270) and offset-cropbox PDFs | identical placement (pixel/geometry tolerance) |
| T-27 | Malicious/invalid PDFs: non-PDF with .pdf name, encrypted PDF, 26 MiB file, 301 pages, truncated file | rejected at finalize |
| T-28 | CSRF: cross-origin POST to recipient endpoints | rejected (Origin check + SameSite) |
| T-29 | Free mode regression: open, draw, erase, undo, place, download still work with no network calls to `/api` | pass |

---

## 12. Policy document outlines (drafts for legal review)

**Privacy Policy:** who we are and contact/DPO; what we collect (sender account, documents and their content, recipient emails, verification and audit metadata, optional IP/UA, analytics); purposes and lawful bases; free-mode local processing vs Pro storage; sharing and processors (Supabase, Vercel, Resend, Google Analytics) and cross-border transfers; retention (§10); security summary; data-subject rights and how to exercise them; children; changes; NPC complaint route.

**Signing privacy notice** (shown to recipients before verification): who is asking you to sign (sender); Papirma's role; what is collected during signing and why (evidence of signing); who receives the result (sender, you); retention; rights and contact; a link to the full policy.

**Terms of Service:** service description; electronic signature vs digital signature disclaimer; user responsibility for choosing appropriate documents and verification modes; **no notarization**; prohibited uses; sender warranties (authority to share documents and recipient emails); availability, fees and plan; limitation of liability; evidence and records requests; termination and data export; governing law (Philippines) and venue.

**Document retention policy:** categories (§10); legal-hold process; deletion methods (storage purge, backup ageing); evidence retention justification; review cadence.

**Incident response policy:** roles (owner as incident lead, DPO); detection sources; severity matrix; containment (key rotation, session revocation, invitation revocation); evidence preservation; **72-hour NPC and data-subject notification** decision tree and templates; post-incident review.

**Data processing agreement considerations:** Papirma as **processor** for senders' document content (counsel to confirm role split; Papirma is likely the **controller** for account data and audit evidence); instructions; confidentiality; sub-processor list and notice of changes; security measures annex; breach notice to customer within X hours; assistance with data-subject requests; deletion/return at end; audit rights; cross-border transfer clauses (NPC model clauses).

---

## 13. Implementation plan (after approval)

**Phase 2 — Foundation + invitation protection (Modes A & B)**
1. Prerequisites (owner): custom domain; Supabase **dev** and **prod** projects (Singapore); Vercel Pro (when going commercial); Resend account + domain DNS.
2. Repo: `/api` functions skeleton, zod, shared `src/shared/` (types, burnIn), Vitest, local Supabase, CI; `vercel.json` (rewrites, headers, cron).
3. Migration `0001` (tables, triggers, RLS, grants) + migration tests (T-21, T-24, T-25).
4. Sender auth (Supabase magic link), `profiles`, manual `plan`.
5. Library: upload via signed URL → finalize (validation + SHA-256).
6. Invitations: create (Mode A/B), list, revoke, reset password, resend; invitation emails.
7. Recipient `/s` route: open, password verify, session cookie, view document (read-only), lockouts.
8. Tests T-01..T-03, T-08..T-13, T-22..T-24, T-27..T-29.

**Phase 3 — Email OTP (Mode C):** `otp_challenges`, send/verify, quotas, email template; tests T-04..T-07.

**Phase 4 — Signing evidence & completion:** refactor `exportPdf` → shared `burnIn()` with parity tests (T-26); consent UI; `/api/r/complete` per §7.1; hash chain trigger; sender evidence view/export; completion emails; recipient download; tests T-14..T-21, T-25.

**Phase 5 — Validation & documentation:** full security test pass, dependency audit, header and CSP verification, threat-model review, system description for evidence, legal-review pack (this gap analysis, policies, data inventory, sub-processor list), optional third-party pen test before launch.

Each phase ends with its tests green, a demo on the dev environment, and your approval before anything touches production.

---

## 14. Risks & open questions

* **Identity strength:** Mode A proves only link possession; Mode B proves link + a shared secret; Mode C proves control of the email inbox. None proves legal identity (no ID verification). Communicate this clearly.
* **Vercel function limits:** a 4.5 MB request cap (fine for annotations) and execution time limits; very large PDFs (> ~25 MiB) may need a background job later.
* **Supabase free vs Pro:** use free tiers for dev only; production evidence needs backups (Pro).
* **Windows dev:** the local Supabase test stack needs Docker Desktop.
* **GA in free mode:** analytics consent (NPC 2023-04) is a pre-existing gap unrelated to Pro, but worth fixing alongside the privacy policy.

---

## 15. Sources (accessed 14 November 2026)

* RA 8792 full text, ChanRobles: <https://chanrobles.com/republicactno8792.htm> · GPPB PDF: <https://www.gppb.gov.ph/wp-content/uploads/2023/06/Republic-Act-No.-8792.pdf> · DICT PDF: <https://cms-cdn.e.gov.ph/DICT/pdf/images_ipenforcement_RA8792-E-Commerce_Act.pdf>
* Rules on Electronic Evidence (A.M. No. 01-7-01-SC), Lawphil: <https://lawphil.net/courts/supreme/am/am_01-7-01_2001.html> *(connection refused during research; ⚠ verify)*
* Rules on Electronic Notarization (A.M. No. 24-10-14-SC), SC announcement: <https://sc.judiciary.gov.ph/sc-approves-rules-on-electronic-notarization-advancing-digital-innovation-and-access-to-justice/> · rules page: <https://sc.judiciary.gov.ph/enotarization/enotarization-rules/> *(TLS error during research; ⚠ verify)* · secondary: <https://www.lexology.com/library/detail.aspx?g=0f567e83-ae10-4a2a-b317-ea73dd0c11dd>
* RA 10173 IRR (as amended), NPC: <https://privacy.gov.ph/wp-content/uploads/2023/06/IRR_RA-10173-as-amended.pdf>
* NPC Circular 16-03 (breach management): <https://privacy.gov.ph/?p=553>
* NPC Circular 2022-04 (registration): <https://privacy.gov.ph/wp-content/uploads/2023/05/Circular-2022-04.pdf>
* NPC Circular 2023-06 FAQ (security of personal data): <https://privacy.gov.ph/wp-content/uploads/2024/12/v12-19-2024_FAQ-NPC-Circular-2023-06_NNJ_JDN.pdf>
* NPC Circular 2023-04 (consent), secondary: <https://digitalpolicyalert.org/event/18937-implemented-national-privacy-commissions-guidelines-on-consent-circular-no-2023-04>
* Cross-border transfers / model clauses, secondary: <https://ndvlaw.com/how-do-philippine-companies-comply-with-cross-border-data-transfers/>
* DICT PNPKI: <https://sites.google.com/dict.gov.ph/pnpki/ors> · secondary: <https://yugatech.com/news/dict-now-provides-digital-certificates-to-the-private-sector>

---

## 16. Decisions needed before Phase 2

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Stack: Vercel Functions + Supabase (Singapore) + Resend | **Approve** |
| D2 | Completed PDF generated **server-side** from annotations (vs recipient uploads a finished PDF) | **Server-side** (eliminates content substitution) |
| D3 | Multi-recipient: separate signed copy per recipient (v1) vs one combined document | **Separate copies in v1**; combined sequential signing later |
| D4 | Record IP address + user agent on verification/completion events (evidence), retained with evidence | Recommend **yes, with documented purpose**; counsel to confirm |
| D5 | Custom domain for app and email (required for reliable email) | **Yes, before Phase 2 emails** |
| D6 | Sender sign-in method | **Email magic link + Google** |
| D7 | Signing-summary page appended to completed PDFs | **Yes** |
