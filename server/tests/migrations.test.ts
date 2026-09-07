import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { checkMigrationHistory, createDatabase, migrate, verifyMigrations } from '../db.js';
import { loadConfig } from '../config.js';
import { createAuth } from '../auth.js';

test('migration history rejects changed, removed, out-of-order and incomplete releases',()=>{
  const first={name:'202601010001_base.sql',sha256:'a'},second={name:'202601010002_next.sql',sha256:'b'};
  assert.deepEqual(checkMigrationHistory([first,second],[first]),[second]);
  assert.deepEqual(checkMigrationHistory([first,second],[first,second],true),[]);
  assert.throws(()=>checkMigrationHistory([{...first,sha256:'changed'}],[first]),/missing or changed/);
  assert.throws(()=>checkMigrationHistory([],[first]),/missing or changed/);
  assert.throws(()=>checkMigrationHistory([first,second],[second]),/precedes/);
  assert.throws(()=>checkMigrationHistory([first,second],[first],true),/pending/);
});

const databaseUrl=process.env.TEST_DATABASE_URL;
test('concurrent startup does not repeat application DDL or deadlock account admission',{skip:!databaseUrl,timeout:60_000},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/(?:^|[_/-])test(?:[_/-]|$)/);
  const db=createDatabase(databaseUrl!);t.after(()=>db.end());await migrate(db);
  const previous=await db.query('SELECT name,sha256,applied_at FROM app_private.schema_migrations ORDER BY name');
  assert.ok(previous.rowCount!>=3);
  const observed:string[]=[];
  const instrumented:any={query:async(sql:string,args?:any[])=>{observed.push(sql);return db.query(sql,args);},connect:async()=>{const client=await db.connect();return {query:async(sql:string,args?:any[])=>{observed.push(sql);return client.query(sql,args);},release:()=>client.release()};}};
  const auth=createAuth(db,loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:databaseUrl!,APPSCREEN_SIGNING_SECRET:randomBytes(48).toString('hex')}));
  const identities=Array.from({length:8},()=>randomUUID());
  await Promise.all([...Array.from({length:4},()=>migrate(instrumented)),...identities.map(id=>auth.ensureWorkspace(id,'isolated-migration@example.test'))]);
  assert.equal(observed.some(sql=>/ALTER TABLE|CREATE POLICY|CREATE OR REPLACE FUNCTION/.test(sql)),false);
  assert.deepEqual((await db.query('SELECT name,sha256,applied_at FROM app_private.schema_migrations ORDER BY name')).rows,previous.rows);
  observed.length=0;await verifyMigrations(instrumented);
  assert.equal(observed.some(sql=>/CREATE|ALTER|INSERT|UPDATE|DELETE|REVOKE/.test(sql)),false);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM workspace_members WHERE user_id=ANY($1::text[])',[identities])).rows[0].n,8);
});
