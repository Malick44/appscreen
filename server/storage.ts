import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { Config } from './config.js';
import { invariant } from './errors.js';
import { resolveStorageConfig } from '../deploy/storage-config.mjs';

export function createStorage(config: Config) {
  const { url, key } = resolveStorageConfig({
    NODE_ENV: config.production ? 'production' : 'development',
    SUPABASE_URL: config.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: config.supabaseServiceKey,
    SUPABASE_STORAGE_URL: config.supabaseStorageUrl, SUPABASE_STORAGE_SERVICE_ROLE_KEY: config.supabaseStorageServiceKey,
  });
  const cloud = key ? createClient(url,key,{
    auth:{persistSession:false,autoRefreshToken:false},
    // Custom apikey headers must never follow redirects to another installation.
    global:{fetch:(input,options)=>fetch(input,{...options,redirect:'error'})},
  }) : null;
  function localPath(key: string) {
    invariant(/^[a-zA-Z0-9_./-]+$/.test(key),'INVALID_STORAGE_KEY','Invalid file reference.');
    const path=resolve(config.localStorageDirectory,key);
    invariant(path.startsWith(config.localStorageDirectory+sep),'INVALID_STORAGE_KEY','Invalid file reference.');
    return path;
  }
  return {
    async put(key: string, bytes: Buffer, mimeType: string) {
      if(cloud) { const {error}=await cloud.storage.from(config.storageBucket).upload(key,bytes,{contentType:mimeType,upsert:false}); if(error) throw new Error(`Private storage upload failed: ${error.statusCode || 'unknown'}`); }
      else { invariant(!config.production,'STORAGE_NOT_CONFIGURED','Private storage is not configured.',503); const path=localPath(key); await mkdir(dirname(path),{recursive:true}); await writeFile(path,bytes,{flag:'wx',mode:0o600}); }
    },
    async read(key: string): Promise<Buffer> {
      if(cloud) { const {data,error}=await cloud.storage.from(config.storageBucket).download(key); if(error||!data) throw new Error('Private asset download failed.'); return Buffer.from(await data.arrayBuffer()); }
      return readFile(localPath(key));
    },
    async remove(key: string) {
      if(cloud) { const {error}=await cloud.storage.from(config.storageBucket).remove([key]); if(error) throw new Error('Private asset removal failed.'); }
      else await unlink(localPath(key)).catch(error=>{if(error.code!=='ENOENT') throw error;});
    },
  };
}
export type Storage = ReturnType<typeof createStorage>;
