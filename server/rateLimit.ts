import type { Queryable } from './db.js'
import { one } from './db.js'

/** Fixed-window counters in Postgres — enough at PirmaNest's scale, no Redis needed. */

/** Record one hit and return the count in the current window. */
export async function hit(q: Queryable, key: string, windowSec: number): Promise<number> {
  const row = await one<{ count: number }>(
    q,
    `insert into public.rate_limits as r (key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when r.window_start < now() - make_interval(secs => $2) then 1 else r.count + 1 end,
       window_start = case when r.window_start < now() - make_interval(secs => $2) then now() else r.window_start end
     returning count`,
    [key, windowSec],
  )
  return row!.count
}

/** Current count without recording a hit (0 if the window has passed). */
export async function peek(q: Queryable, key: string, windowSec: number): Promise<number> {
  const row = await one<{ count: number }>(
    q,
    `select case when window_start < now() - make_interval(secs => $2) then 0 else count end as count
     from public.rate_limits where key = $1`,
    [key, windowSec],
  )
  return row?.count ?? 0
}
