import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

export const BUCKET_POLICY = Object.freeze({ public: false, allowedMimeTypes: ['image/png', 'image/jpeg', 'application/zip'], fileSizeLimit: 524_288_000 });

/** Explicit operator setup, never run automatically at server start. Existing
 * buckets are inspected, not silently changed or made inaccessible. */
export async function ensurePrivateBucket(storage, name, { create = false } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/.test(name)) throw new Error('Invalid private bucket name.');
  const { data, error } = await storage.getBucket(name);
  if (error) {
    if (!create || !['404', 'NoSuchBucket', 'NotFound'].includes(String(error.status || error.statusCode || error.code))) throw new Error('Private bucket unavailable. Check access or run setup with --create for a new bucket.');
    const result = await storage.createBucket(name, BUCKET_POLICY);
    if (result.error) throw new Error('Could not create private storage bucket. Check provider limits and permissions.');
    return { name, created: true, private: true };
  }
  if (!data || data.public !== false) throw new Error('Storage bucket must be private. Public buckets are rejected.');
  const types = data.allowed_mime_types;
  if (!Array.isArray(types) || BUCKET_POLICY.allowedMimeTypes.some(type => !types.includes(type)) || types.some(type => !BUCKET_POLICY.allowedMimeTypes.includes(type))) throw new Error('Bucket must allow exactly PNG, JPEG and ZIP exports. Adjust the bucket policy explicitly.');
  if (data.file_size_limit && Number(data.file_size_limit) < BUCKET_POLICY.fileSizeLimit) throw new Error('Bucket file limit is below the reviewed maximum archive size. Adjust it explicitly or lower application limits.');
  return { name, created: false, private: true };
}

export async function verifyConfiguredStorage({ create = false } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url?.startsWith('https://') || !key) throw new Error('Provide runtime SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await ensurePrivateBucket(client.storage, process.env.SUPABASE_STORAGE_BUCKET || 'appscreen-private', { create });
  console.log(`Private storage verified: ${result.name}${result.created ? ' (created)' : ''}.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyConfiguredStorage({ create: process.argv.includes('--create') });
