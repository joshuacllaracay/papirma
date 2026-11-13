import type { Deps } from './deps.js'
import { WORKFLOW_VERSION, loadEnv } from './config.js'
import { createPostgresDb } from './db.js'
import { createSupabaseStorage } from './storage.js'
import { createResendMailer } from './email.js'
import { createSupabaseAuth } from './auth.js'

let cached: Deps | null = null

/** Production wiring, created once per warm function instance. */
export function productionDeps(): Deps {
  if (cached) return cached
  const env = loadEnv()
  cached = {
    db: createPostgresDb(env.DATABASE_URL),
    storage: createSupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.STORAGE_BUCKET),
    mailer: createResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM),
    auth: createSupabaseAuth(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    config: {
      appOrigin: env.APP_ORIGIN.replace(/\/$/, ''),
      ipHmacKey: env.IP_HMAC_KEY,
      cronSecret: env.CRON_SECRET,
      workflowVersion: WORKFLOW_VERSION,
    },
  }
  return cached
}
