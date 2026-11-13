import type { SenderAuth } from './auth.js'
import type { AppConfig } from './config.js'
import type { Db } from './db.js'
import type { Mailer } from './email.js'
import type { ObjectStorage } from './storage.js'

/** Everything a request handler needs; real services in production, fakes in tests. */
export interface Deps {
  db: Db
  storage: ObjectStorage
  mailer: Mailer
  auth: SenderAuth
  config: AppConfig
}
