import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export type DB = pg.Pool;
export type Connection = pg.Pool | pg.PoolClient;
export function createDatabase(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
}
export async function transaction<T>(pool: DB, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export function row<T = Record<string, any>>(value: Record<string, any>): T {
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()), val])) as T;
}
async function migrationFiles() {
  const directory=new URL('../supabase/migrations/',import.meta.url);
  const files=(await readdir(directory)).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(files.map(async name=>{const sql=await readFile(new URL(name,directory),'utf8');return {name,sql,sha256:createHash('sha256').update(sql).digest('hex')};}));
}
export function checkMigrationHistory(files:Array<{name:string;sha256:string}>,history:Array<{name:string;sha256:string}>,requireComplete=false) {
  const found=new Map(history.map(item=>[item.name,item.sha256]));
  for(const entry of history) {
    const file=files.find(file=>file.name===entry.name);
    if(!file||file.sha256!==entry.sha256)throw new Error(`Applied migration ${entry.name} is missing or changed. Restore it and add a new migration instead.`);
  }
  const pending=files.filter(file=>!found.has(file.name));
  const latest=history.map(item=>item.name).sort().at(-1);
  if(latest&&pending.some(file=>file.name<latest))throw new Error('A pending migration precedes an applied migration. Add new migrations after the current version.');
  if(requireComplete&&pending.length)throw new Error('Database migrations are pending. Run npm run db:migrate as the controlled deployment step before starting services.');
  return pending;
}
/** Production startup is deliberately read-only. Applying DDL is an explicit,
 * single deployment step, not work each web/worker replica repeats on startup. */
export async function verifyMigrations(pool:DB) {
  const files=await migrationFiles();
  const exists=await pool.query("SELECT to_regclass('app_private.schema_migrations') AS name");
  if(!exists.rows[0].name)throw new Error('Database migration history is not initialized. Run npm run db:migrate before starting services.');
  const history=await pool.query('SELECT name,sha256 FROM app_private.schema_migrations ORDER BY name');
  checkMigrationHistory(files,history.rows,true);
}
export async function migrate(pool: DB) {
  const files=await migrationFiles();
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('appscreen-schema'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS app_private');
    await client.query('CREATE TABLE IF NOT EXISTS app_private.schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('REVOKE ALL ON TABLE app_private.schema_migrations FROM PUBLIC');
    await client.query("DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON TABLE app_private.schema_migrations FROM anon; END IF; IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON TABLE app_private.schema_migrations FROM authenticated; END IF; END $$");
    const history=await client.query('SELECT name,sha256 FROM app_private.schema_migrations ORDER BY name');
    const pending=checkMigrationHistory(files,history.rows);
    for(const entry of pending){const file=files.find(file=>file.name===entry.name)!;await client.query(file.sql);await client.query('INSERT INTO app_private.schema_migrations(name,sha256) VALUES($1,$2)',[file.name,file.sha256]);}
  });
}
