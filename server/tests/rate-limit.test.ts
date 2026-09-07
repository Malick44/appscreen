import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { createDatabase } from '../db.js';
import { loadConfig } from '../config.js';

test('static app navigation cannot exhaust or bypass protected API and mutation quotas',async t=>{
  // These requests require no database connection or provider account.
  const config=loadConfig({NODE_ENV:'test',APPSCREEN_DEV_AUTH:'true',DATABASE_URL:'postgresql://unused/unused_test',APPSCREEN_SIGNING_SECRET:'isolated-rate-limit-test-'.repeat(3),APP_BASE_URL:'http://localhost'});
  const db=createDatabase(config.databaseUrl),{app}=await createApp(config,db);await app.ready();
  t.after(async()=>{await app.close();await db.end();});
  const staticPaths=['/app/inbox','/app/support','/app/operator/report','/saas/session.js','/saas/api.js','/saas/report.mjs'];
  for(let i=0;i<210;i++) {
    const response=await app.inject({url:staticPaths[i%staticPaths.length]});assert.equal(response.statusCode,200,`Static request ${i}: ${response.body.slice(0,100)}`);
  }
  for(let i=0;i<180;i++)assert.equal((await app.inject({url:'/api/config'})).statusCode,200);
  const limited=await app.inject({url:'/api/config'});assert.equal(limited.statusCode,429);assert.ok(limited.headers['retry-after']);
  assert.equal((await app.inject({url:'/saas/session.js'})).statusCode,200,'the UI can load to display and recover from throttling');
  assert.equal((await app.inject({url:'/api/unknown.js'})).statusCode,429,'an API-shaped fallback path is not a static exemption');
  for(let i=0;i<20;i++)assert.equal((await app.inject({method:'POST',url:'/api/support',remoteAddress:'127.0.0.2',payload:{message:'Synthetic report without a session'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/support',remoteAddress:'127.0.0.2',payload:{message:'Synthetic report without a session'}})).statusCode,429,'support retains its tighter mutation limit');
  assert.equal((await app.inject({url:'/saas/tests/preview-server.mjs',remoteAddress:'127.0.0.3'})).statusCode,404,'test source remains private');
  for(let i=0;i<180;i++)assert.equal((await app.inject({method:'POST',url:'/mcp',remoteAddress:'127.0.0.4',payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/mcp',remoteAddress:'127.0.0.4',payload:{}})).statusCode,429,'MCP transport is not a static exemption');
});
