import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Private object storage. Clients only ever get short-lived signed URLs. */
export interface ObjectStorage {
  /** Signed URL the browser can PUT one new object to (never overwrites). */
  createUploadUrl(path: string): Promise<string>
  /** Signed GET URL, served as an attachment, valid for ttlSec. */
  createDownloadUrl(path: string, ttlSec: number, filename: string): Promise<string>
  get(path: string): Promise<Uint8Array | null>
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  remove(path: string): Promise<void>
}

export function createSupabaseStorage(url: string, serviceRoleKey: string, bucket: string): ObjectStorage {
  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const b = () => client.storage.from(bucket)
  return {
    async createUploadUrl(path) {
      const { data, error } = await b().createSignedUploadUrl(path, { upsert: false })
      if (error || !data) throw new Error('storage: could not create upload url')
      return data.signedUrl
    },
    async createDownloadUrl(path, ttlSec, filename) {
      const { data, error } = await b().createSignedUrl(path, ttlSec, { download: filename })
      if (error || !data) throw new Error('storage: could not create download url')
      return data.signedUrl
    },
    async get(path) {
      const { data, error } = await b().download(path)
      if (error || !data) return null
      return new Uint8Array(await data.arrayBuffer())
    },
    async put(path, bytes, contentType) {
      const { error } = await b().upload(path, bytes, { contentType, upsert: false })
      if (error) throw new Error('storage: upload failed')
    },
    async remove(path) {
      await b().remove([path])
    },
  }
}
