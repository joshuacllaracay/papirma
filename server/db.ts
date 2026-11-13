import postgres from 'postgres'

export type Row = Record<string, unknown>

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends Queryable {
  /** Runs fn in a single transaction; any thrown error rolls it back. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
}

/**
 * Production database: Supabase Postgres via the transaction pooler, connected
 * as the least-privilege `papirma_app` role (never the owner or service role).
 */
export function createPostgresDb(url: string): Db {
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 })
  const wrap = (s: postgres.Sql | postgres.TransactionSql): Queryable => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await s.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[]
    },
  })
  return {
    ...wrap(sql),
    tx: <T>(fn: (q: Queryable) => Promise<T>) => sql.begin((t) => fn(wrap(t))) as Promise<T>,
  }
}

export async function one<T extends Row>(q: Queryable, text: string, params?: unknown[]): Promise<T | undefined> {
  return (await q.query<T>(text, params))[0]
}
