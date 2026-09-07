import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, registerMcp, MCP_SCOPES } from './index.mjs';

const context = { userId: 'user_1', workspaceId: 'workspace_1', scopes: MCP_SCOPES, authKind: 'mcp' };
async function clientFor(services, ctx = context) {
  const server = createMcpServer(services, ctx), client = new Client({ name: 'test-codex-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP exposes separate direct-edit and hosted-AI modes', async () => {
  const calls = [];
  const f = await clientFor({ applyOperations: async (ctx, args) => { calls.push({ ctx, args }); return { revisionId: 'draft_1' }; }, createJob: async (ctx, args) => { calls.push({ ctx, args }); return { jobId: 'job_1' }; } });
  try {
    const list = await f.client.listTools();
    assert.ok(list.tools.some(tool => tool.name === 'appscreen_get_operation_reference'));
    assert.ok(list.tools.some(tool => tool.name === 'appscreen_create_design_job'));
    const result = await f.client.callTool({ name: 'appscreen_apply_operations', arguments: { projectId: 'p', expectedRevisionId: 'r', operations: [{ op: 'update_text', sceneId: 's', patch: { headlines: { en: 'Hello' } } }], idempotencyKey: 'direct-edit-1' } });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.workspaceId, 'workspace_1');
    assert.equal(calls[0].args.kind, undefined);
    await f.client.callTool({ name: 'appscreen_create_design_job', arguments: { projectId: 'p', input: { revisionId: 'r', template: { id: 'tidal-relay', mode: 'exact' } }, maxCredits: 5, idempotencyKey: 'paid-design-1' } });
    assert.equal(calls[1].args.kind, 'design');
    assert.equal(calls[1].args.maxCredits, 5);
  } finally { await f.close(); }
});

test('read-only authorization cannot start paid jobs or edit projects', async () => {
  let invoked = false;
  const f = await clientFor({ createJob: async () => { invoked = true; } }, { ...context, scopes: ['projects:read'] });
  try {
    const result = await f.client.callTool({ name: 'appscreen_create_design_job', arguments: { projectId: 'p', input: { revisionId: 'r' }, maxCredits: 5, idempotencyKey: 'paid-design-1' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /INSUFFICIENT_SCOPE/);
    assert.equal(invoked, false);
  } finally { await f.close(); }
});

test('local screenshot paths are rejected; the upload tool only authorizes uploaded bytes', async () => {
  let invoked = false;
  const f = await clientFor({ requestAssetUpload: async () => { invoked = true; return {}; } });
  try {
    const result = await f.client.callTool({ name: 'appscreen_request_asset_upload', arguments: { projectId: 'p', filename: '/Users/person/private.png', mimeType: 'image/png', byteLength: 20, idempotencyKey: 'upload-key-1' } });
    assert.equal(result.isError, true);
    assert.equal(invoked, false);
  } finally { await f.close(); }
});

test('provider/internal failures never disclose secrets through MCP errors', async () => {
  const f = await clientFor({ getProject: async () => { throw Object.assign(new Error('DATABASE_URL=private_secret'), { code: 'INTERNAL_ERROR', statusCode: 500 }); } });
  try {
    const result = await f.client.callTool({ name: 'appscreen_get_project', arguments: { projectId: 'p' } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /private_secret/);
  } finally { await f.close(); }
});

test('Streamable HTTP authenticates every request, rejects unsafe origins, and advertises resource metadata', async () => {
  const app = Fastify();
  await registerMcp(app, { listProjects: async () => ({ projects: [] }) }, async req => req.headers.authorization === 'Bearer valid' ? context : null, { baseUrl: 'https://appscreen.example', authorizationServers: ['https://auth.example'] });
  try {
    const auth = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    assert.equal(auth.statusCode, 401);
    assert.match(auth.headers['www-authenticate'], /oauth-protected-resource\/mcp/);
    const origin = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer valid', origin: 'https://evil.example' }, payload: {} });
    assert.equal(origin.statusCode, 403);
    const get = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer valid' } });
    assert.equal(get.statusCode, 405);
    const metadata = await app.inject('/.well-known/oauth-protected-resource/mcp');
    assert.equal(metadata.json().resource, 'https://appscreen.example/mcp');
    assert.deepEqual(metadata.json().authorization_servers, ['https://auth.example']);
    const rpc = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer valid', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code-test', version: '1.0.0' } } } });
    assert.equal(rpc.statusCode, 200);
    assert.equal(rpc.json().result.serverInfo.name, 'appscreen');
    const tools = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer valid', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
    assert.equal(tools.statusCode, 200);
    assert.ok(tools.json().result.tools.length > 10);
  } finally { await app.close(); }
});
