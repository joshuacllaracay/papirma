-- Early-access requests for PirmaNest Pro (no payments yet).
-- A signed-in free user can record a request; only the project owner changes `plan`:
--
--   -- list pending requests
--   select u.email, p.display_name, p.pro_requested_at
--     from public.profiles p join auth.users u on u.id = p.id
--    where p.plan = 'free' and p.pro_requested_at is not null
--    order by p.pro_requested_at;
--
--   -- approve one
--   update public.profiles set plan = 'pro'
--    where id = (select id from auth.users where email = 'someone@example.com');

alter table public.profiles add column pro_requested_at timestamptz;

create index profiles_pro_requests_idx on public.profiles (pro_requested_at)
  where plan = 'free' and pro_requested_at is not null;
