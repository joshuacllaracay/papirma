import { z } from 'zod'

/** Settings the services need. Built from env in production, by hand in tests. */
export interface AppConfig {
  /** e.g. https://papirma.com — used for links and Origin checks */
  appOrigin: string
  ipHmacKey: string
  cronSecret: string
  workflowVersion: string
}

export const WORKFLOW_VERSION = 'pro-sign/1'

const Env = z.object({
  APP_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  STORAGE_BUCKET: z.string().default('documents'),
  RESEND_API_KEY: z.string().min(10),
  EMAIL_FROM: z.string().min(3),
  IP_HMAC_KEY: z.string().min(32),
  CRON_SECRET: z.string().min(32),
})

export type ServerEnv = z.infer<typeof Env>

/** Fails fast (without printing values) if a required server secret is missing. */
export function loadEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Missing or invalid server env: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
  }
  return parsed.data
}
