-- Papirma Pro recipient signing — schema, integrity triggers, grants and RLS.
-- Design: docs/pro-signing/phase1-assessment.md §5.
--
-- Access model
--   * The API connects as the dedicated login role `papirma_app` (least privilege,
--     owns nothing, cannot UPDATE/DELETE evidence, cannot disable triggers).
--   * Browsers never query these tables. `anon` gets nothing; `authenticated`
--     (Supabase-signed-in senders) gets read-only, owner-scoped RLS as a backstop.
--   * Storage bucket `documents` is private with no client policies; the server
--     hands out short-lived signed URLs after its own authorization checks.
--
-- No extensions required: sha256() and gen_random_uuid() are core in PG 13+.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'papirma_app') then
    -- NOLOGIN here; the project owner enables login with a strong password
    -- out-of-band:  alter role papirma_app with login password '<secret>';
    create role papirma_app nologin;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.invitation_mode   as enum ('link', 'password', 'email_otp');
create type public.invitation_status as enum ('pending', 'opened', 'completing', 'completed', 'revoked', 'expired');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  plan          text not null default 'free' check (plan in ('free', 'pro')),
  created_at    timestamptz not null default now()
);

create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete restrict,
  title       text not null check (char_length(title) between 1 and 200),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index documents_owner_idx on public.documents (owner_id, created_at desc) where deleted_at is null;

create table public.document_versions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents(id) on delete restrict,
  version       int  not null check (version > 0),
  storage_path  text not null unique,
  status        text not null default 'pending' check (status in ('pending', 'ready', 'rejected')),
  sha256        bytea check (sha256 is null or octet_length(sha256) = 32),
  byte_size     int   check (byte_size is null or byte_size between 1 and 26214400),
  page_count    int   check (page_count is null or page_count between 1 and 300),
  created_at    timestamptz not null default now(),
  ready_at      timestamptz,
  unique (document_id, version),
  check (status <> 'ready' or (sha256 is not null and byte_size is not null and page_count is not null and ready_at is not null))
);

create table public.invitations (
  id                   uuid primary key default gen_random_uuid(),
  document_version_id  uuid not null references public.document_versions(id) on delete restrict,
  sender_id            uuid not null references public.profiles(id) on delete restrict,
  recipient_email      text not null check (
                         char_length(recipient_email) between 3 and 254
                         and recipient_email = lower(recipient_email)
                         and recipient_email like '%_@_%'),
  security_mode        public.invitation_mode not null,
  token_hash           bytea not null unique check (octet_length(token_hash) = 32),
  password_hash        text check (password_hash is null or password_hash like '$argon2id$%'),
  password_set_at      timestamptz,
  failed_attempts      int not null default 0 check (failed_attempts >= 0),
  total_failed         int not null default 0 check (total_failed >= 0),
  locked_until         timestamptz,
  status               public.invitation_status not null default 'pending',
  workflow_version     text not null,
  hide_title           boolean not null default false,
  expires_at           timestamptz not null,
  first_opened_at      timestamptz,
  revoked_at           timestamptz,
  revoked_reason       text check (revoked_reason is null or char_length(revoked_reason) <= 200),
  replaces_id          uuid references public.invitations(id),
  created_at           timestamptz not null default now(),
  check ((security_mode = 'password') = (password_hash is not null)),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index invitations_sender_idx  on public.invitations (sender_id, created_at desc);
create index invitations_version_idx on public.invitations (document_version_id);
create index invitations_expiry_idx  on public.invitations (expires_at) where status in ('pending', 'opened');

create table public.otp_challenges (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid not null references public.invitations(id) on delete cascade,
  code_hmac      bytea not null check (octet_length(code_hmac) = 32),
  attempts       int not null default 0 check (attempts between 0 and 5),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  superseded_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index otp_inv_idx on public.otp_challenges (invitation_id, created_at desc);

create table public.recipient_sessions (
  id                   uuid primary key default gen_random_uuid(),
  invitation_id        uuid not null references public.invitations(id) on delete cascade,
  token_hash           bytea not null unique check (octet_length(token_hash) = 32),
  verified_via         public.invitation_mode not null,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  absolute_expires_at  timestamptz not null,
  revoked_at           timestamptz,
  check (expires_at <= absolute_expires_at)
);
create index rs_inv_idx on public.recipient_sessions (invitation_id);

create table public.signing_completions (
  id                      uuid primary key default gen_random_uuid(),
  invitation_id           uuid not null unique references public.invitations(id) on delete restrict,
  document_version_id     uuid not null references public.document_versions(id) on delete restrict,
  original_sha256         bytea not null check (octet_length(original_sha256) = 32),
  completed_sha256        bytea not null check (octet_length(completed_sha256) = 32),
  completed_storage_path  text  not null unique,
  verification_method     public.invitation_mode not null,
  consent_text_version    text  not null,
  consent_accepted_at     timestamptz not null,
  completed_at            timestamptz not null default now(),
  workflow_version        text  not null,
  annotation_summary      jsonb not null,
  idempotency_key         uuid  not null unique
);

create table public.audit_events (
  id             bigint generated always as identity primary key,
  invitation_id  uuid references public.invitations(id) on delete restrict,
  document_id    uuid references public.documents(id) on delete restrict,
  actor_type     text not null check (actor_type in ('sender', 'recipient', 'system', 'admin')),
  actor_id       uuid,
  event_type     text not null check (event_type ~ '^[a-z][a-z_]{2,63}$'),
  occurred_at    timestamptz not null default now(),
  details        jsonb not null default '{}'::jsonb,
  ip_address     inet,
  user_agent     text check (user_agent is null or char_length(user_agent) <= 300),
  prev_hash      bytea,
  event_hash     bytea not null
);
create index audit_inv_idx on public.audit_events (invitation_id, id);
create index audit_doc_idx on public.audit_events (document_id, id);

create table public.rate_limits (
  key           text primary key check (char_length(key) <= 200),
  window_start  timestamptz not null,
  count         int not null check (count >= 0)
);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- A ready document version is frozen forever: invitations rely on its hash.
create function public.document_versions_guard() returns trigger language plpgsql as $$
begin
  if new.document_id is distinct from old.document_id
     or new.version is distinct from old.version
     or new.storage_path is distinct from old.storage_path then
    raise exception 'document version identity is immutable' using errcode = 'P0001';
  end if;
  if old.status in ('ready', 'rejected') and (
       new.status is distinct from old.status
       or new.sha256 is distinct from old.sha256
       or new.byte_size is distinct from old.byte_size
       or new.page_count is distinct from old.page_count
       or new.ready_at is distinct from old.ready_at) then
    raise exception 'finalized document version is immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger document_versions_guard before update on public.document_versions
  for each row execute function public.document_versions_guard();

create function public.forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name using errcode = 'P0001';
end $$;
create trigger document_versions_no_delete before delete on public.document_versions
  for each row execute function public.forbid_delete();

-- Invitation identity, mode and target document are fixed at creation, and
-- status may only move along the allowed state machine.
create function public.invitations_guard() returns trigger language plpgsql as $$
begin
  if new.document_version_id is distinct from old.document_version_id
     or new.sender_id        is distinct from old.sender_id
     or new.recipient_email  is distinct from old.recipient_email
     or new.security_mode    is distinct from old.security_mode
     or new.token_hash       is distinct from old.token_hash
     or new.workflow_version is distinct from old.workflow_version
     or new.expires_at       is distinct from old.expires_at
     or new.created_at       is distinct from old.created_at
     or new.replaces_id      is distinct from old.replaces_id then
    raise exception 'invitation identity, mode and document are immutable' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending'    and new.status in ('opened', 'revoked', 'expired')) or
       (old.status = 'opened'     and new.status in ('completing', 'revoked', 'expired')) or
       (old.status = 'completing' and new.status in ('completed', 'opened'))) then
    raise exception 'invalid invitation status transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status in ('completed', 'revoked', 'expired') and new.password_hash is distinct from old.password_hash then
    raise exception 'cannot change password of a closed invitation' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger invitations_guard before update on public.invitations
  for each row execute function public.invitations_guard();
create trigger invitations_no_delete before delete on public.invitations
  for each row execute function public.forbid_delete();

-- New invitations must target a ready version owned by the sender.
create function public.invitations_check_insert() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from public.document_versions v
    join public.documents d on d.id = v.document_id
    where v.id = new.document_version_id and v.status = 'ready'
      and d.owner_id = new.sender_id and d.deleted_at is null) then
    raise exception 'invitation must target a ready document version owned by the sender' using errcode = 'P0001';
  end if;
  if new.status <> 'pending' or new.revoked_at is not null or new.first_opened_at is not null then
    raise exception 'new invitations start pending' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger invitations_check_insert before insert on public.invitations
  for each row execute function public.invitations_check_insert();

-- Evidence is append-only.
create function public.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end $$;
create trigger signing_completions_append_only before update or delete on public.signing_completions
  for each row execute function public.forbid_change();
create trigger signing_completions_no_truncate before truncate on public.signing_completions
  for each statement execute function public.forbid_change();
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.forbid_change();
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function public.forbid_change();

-- Hash chain: each event commits to the previous event in the same scope
-- (per invitation; per document for document-only events).
create function public.audit_event_digest(
  prev bytea, p_id bigint, p_invitation uuid, p_document uuid, p_actor_type text, p_actor uuid,
  p_event text, p_at timestamptz, p_details jsonb, p_ip inet, p_ua text
) returns bytea language sql immutable as $$
  select sha256(coalesce(prev, '\x'::bytea) || convert_to(concat_ws('|',
    p_id::text,
    coalesce(p_invitation::text, ''),
    coalesce(p_document::text, ''),
    p_actor_type,
    coalesce(p_actor::text, ''),
    p_event,
    to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_details::text,
    coalesce(host(p_ip), ''),
    coalesce(p_ua, '')
  ), 'UTF8'))
$$;

create function public.audit_events_chain() returns trigger language plpgsql as $$
declare
  prev bytea;
begin
  new.occurred_at := now();  -- authoritative server time, never caller-supplied
  if new.invitation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('audit:inv:' || new.invitation_id::text, 0));
    select event_hash into prev from public.audit_events
      where invitation_id = new.invitation_id order by id desc limit 1;
  elsif new.document_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('audit:doc:' || new.document_id::text, 0));
    select event_hash into prev from public.audit_events
      where invitation_id is null and document_id = new.document_id order by id desc limit 1;
  else
    perform pg_advisory_xact_lock(hashtextextended('audit:global', 0));
    select event_hash into prev from public.audit_events
      where invitation_id is null and document_id is null order by id desc limit 1;
  end if;
  new.prev_hash := prev;
  new.event_hash := public.audit_event_digest(prev, new.id, new.invitation_id, new.document_id,
    new.actor_type, new.actor_id, new.event_type, new.occurred_at, new.details, new.ip_address, new.user_agent);
  return new;
end $$;
create trigger audit_events_chain before insert on public.audit_events
  for each row execute function public.audit_events_chain();

-- Recompute an invitation's chain; returns the first broken event id, or null if intact.
create function public.verify_audit_chain(p_invitation uuid) returns bigint
language plpgsql stable as $$
declare
  r record;
  prev bytea := null;
begin
  for r in select * from public.audit_events where invitation_id = p_invitation order by id loop
    if r.prev_hash is distinct from prev
       or r.event_hash <> public.audit_event_digest(prev, r.id, r.invitation_id, r.document_id,
            r.actor_type, r.actor_id, r.event_type, r.occurred_at, r.details, r.ip_address, r.user_agent) then
      return r.id;
    end if;
    prev := r.event_hash;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Grants (least privilege). Supabase grants anon/authenticated broad default
-- privileges on new public tables, so revoke them explicitly first.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to papirma_app;
grant usage on type public.invitation_mode, public.invitation_status to papirma_app;
grant select, insert, update on public.profiles, public.documents, public.document_versions, public.invitations to papirma_app;
grant select, insert, update, delete on public.otp_challenges, public.recipient_sessions, public.rate_limits to papirma_app;
grant select, insert on public.signing_completions, public.audit_events to papirma_app;
grant usage on all sequences in schema public to papirma_app;
grant execute on function public.verify_audit_chain(uuid) to papirma_app;
grant execute on function public.audit_event_digest(bytea, bigint, uuid, uuid, text, uuid, text, timestamptz, jsonb, inet, text) to papirma_app;

grant usage on schema public to authenticated;
grant select on public.profiles, public.documents, public.document_versions,
                public.signing_completions, public.audit_events to authenticated;
-- invitations are exposed to authenticated only through a view without secrets
create view public.sender_invitations with (security_invoker = true) as
  select id, document_version_id, sender_id, recipient_email, security_mode, status,
         expires_at, first_opened_at, revoked_at, created_at
  from public.invitations;
grant select (id, document_version_id, sender_id, recipient_email, security_mode, status,
              expires_at, first_opened_at, revoked_at, created_at)
  on public.invitations to authenticated;
grant select on public.sender_invitations to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security (deny by default)
-- ---------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.documents           enable row level security;
alter table public.document_versions   enable row level security;
alter table public.invitations         enable row level security;
alter table public.otp_challenges      enable row level security;
alter table public.recipient_sessions  enable row level security;
alter table public.signing_completions enable row level security;
alter table public.audit_events        enable row level security;
alter table public.rate_limits         enable row level security;

-- The API role is trusted to apply its own authorization checks.
create policy app_all on public.profiles            for all to papirma_app using (true) with check (true);
create policy app_all on public.documents           for all to papirma_app using (true) with check (true);
create policy app_all on public.document_versions   for all to papirma_app using (true) with check (true);
create policy app_all on public.invitations         for all to papirma_app using (true) with check (true);
create policy app_all on public.otp_challenges      for all to papirma_app using (true) with check (true);
create policy app_all on public.recipient_sessions  for all to papirma_app using (true) with check (true);
create policy app_all on public.signing_completions for all to papirma_app using (true) with check (true);
create policy app_all on public.audit_events        for all to papirma_app using (true) with check (true);
create policy app_all on public.rate_limits         for all to papirma_app using (true) with check (true);

-- Senders: read-only, own rows.
create policy own_profile on public.profiles for select to authenticated using (id = auth.uid());
create policy own_documents on public.documents for select to authenticated using (owner_id = auth.uid());
create policy own_versions on public.document_versions for select to authenticated using (
  exists (select 1 from public.documents d where d.id = document_id and d.owner_id = auth.uid()));
create policy own_invitations on public.invitations for select to authenticated using (sender_id = auth.uid());
create policy own_completions on public.signing_completions for select to authenticated using (
  exists (select 1 from public.invitations i where i.id = invitation_id and i.sender_id = auth.uid()));
create policy own_audit on public.audit_events for select to authenticated using (
  (invitation_id is not null and exists (select 1 from public.invitations i where i.id = invitation_id and i.sender_id = auth.uid()))
  or (invitation_id is null and document_id is not null and exists (select 1 from public.documents d where d.id = document_id and d.owner_id = auth.uid())));
-- otp_challenges, recipient_sessions, rate_limits: no client policies at all.

-- ---------------------------------------------------------------------------
-- Private storage bucket (Supabase Storage). No policies on storage.objects are
-- created for anon/authenticated, so clients cannot list, read or write it.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 26214400, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 26214400, allowed_mime_types = array['application/pdf'];
