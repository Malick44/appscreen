// Opt-in real TCP/Streamable HTTP rehearsal, not an actual Codex/Claude run.
// TEST_DATABASE_URL=postgresql://...@127.0.0.1:.../appscreen_test \
// DATABASE_URL="$TEST_DATABASE_URL" npx tsx server/tests/mcp-client-smoke.ts
// Does not load .env, start a queue consumer, install/configure clients, call a
// provider, or inspect existing projects. All fixture data is retained.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import JSZip from 'jszip';
import sharp from 'sharp';
import { resolveDevice, validateCampaign } from '../../core/campaign.mjs';
import { createApp } from '../app.js';
import { hash } from '../auth.js';
import { loadConfig } from '../config.js';
import { createDatabase, verifyMigrations } from '../db.js';
import { createWorker } from '../worker.js';

const directScopes = ['projects:read', 'projects:write', 'assets:write', 'exports:write'];
const profile = { id: 'iphone-6.9', width: 1320, height: 2868 };
const colors = ['#B74A32', '#367C92', '#7053AA'];

async function availablePort() {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  // The app must bind this exact port or abort; no existing listener is reused.
  return port;
}

async function syntheticSource(index: number) {
  const rows = [0, 1, 2, 3].map(row => `<rect x="24" y="${180 + row * 100}" width="282" height="78" rx="10" fill="${colors[index]}"/><text x="42" y="${226 + row * 100}" font-size="20" fill="white">FIXTURE ${index + 1} / ${row + 1}</text>`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="330" height="717"><rect width="330" height="717" fill="#162333"/><g font-family="sans-serif"><rect width="330" height="45" fill="${colors[index]}"/><text x="24" y="106" font-size="28" fill="white">SYNTHETIC ${index + 1}</text><text x="24" y="144" font-size="16" fill="white">MCP protocol fixture only</text>${rows}<text x="24" y="657" font-size="15" fill="white">NOT A CUSTOMER CAPTURE</text></g></svg>`)).flatten({ background: '#162333' }).removeAlpha().png().toBuffer();
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL || '';
  assert.ok(databaseUrl, 'A dedicated TEST_DATABASE_URL is required.');
  assert.equal(process.env.DATABASE_URL, databaseUrl, 'DATABASE_URL must exactly match TEST_DATABASE_URL.');
  const address = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(address.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(address.hostname), 'The database must use literal loopback.');
  assert.equal(address.pathname, '/appscreen_test'); assert.equal(address.search, '');
  const output = await mkdtemp(join(tmpdir(), 'appscreen-mcp-client-'));
  const runId = randomUUID(), baseUrl = `http://127.0.0.1:${await availablePort()}`;
  const report: any = {
    version: 1, runId, startedAt: new Date().toISOString(), completed: false, output,
    client: { type: 'Official MCP JavaScript SDK Client with StreamableHTTPClientTransport over real loopback TCP; not a Codex or Claude model session', sdkVersion: JSON.parse(await readFile(new URL('../../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url), 'utf8')).version },
    isolation: { database: 'appscreen_test', baseUrl, syntheticSources: 3, privateTemporaryStorage: true, dotenvLoaded: false, persistentClientConfiguration: false, queueConsumerStarted: false, hostedAIEnabled: false, oauthEnabled: false, billingEnabled: false, externalFetchAttempts: 0, hostedEngineCalls: 0 },
    limitations: ['Actual Codex and Claude client initialization, tool use and reconnect are not exercised; installed CLI --version/help evidence is separate.', 'Supabase OAuth, PKCE, refresh, consent and real client revocation require separate authorized acceptance; this rehearsal uses short-lived synthetic bearer tokens.', 'No hosted AI quality, production network/hosting, concurrency/load or provider acceptance is claimed.', 'The synthetic source images are protocol fixtures, not user app screenshots or production marketing assets.'],
    checks: [], protocol: [], jobs: [], sources: [], fixtureWorkspaces: [],
  };
  const check = (name: string, pass: boolean, details?: unknown) => { report.checks.push({ name, pass, ...(details === undefined ? {} : { details }) }); assert.ok(pass, name); };
  const nativeFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== baseUrl) { report.isolation.externalFetchAttempts++; throw new Error('Non-rehearsal network fetch is forbidden.'); }
    const response = await nativeFetch(input, { ...init, redirect: 'error' });
    if (url.pathname === '/mcp') {
      const rpc = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      // Never retain headers, bearer credentials, signed URLs or tool arguments.
      report.protocol.push({ method: init?.method || 'GET', rpc: rpc?.method || null, tool: rpc?.method === 'tools/call' ? rpc.params?.name : undefined, status: response.status });
    }
    return response;
  };
  globalThis.fetch = guardedFetch;
  const db = createDatabase(databaseUrl);
  let application: Awaited<ReturnType<typeof createApp>> | undefined;
  let worker: ReturnType<typeof createWorker> | undefined;
  const clients: Client[] = [], issuedTokens: { id: string; workspaceId: string }[] = [];
  try {
    await verifyMigrations(db);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, APP_BASE_URL: baseUrl, APPSCREEN_DEV_AUTH: 'true', APPSCREEN_SIGNING_SECRET: randomBytes(48).toString('hex'), APPSCREEN_STORAGE_PATH: join(output, 'private-storage'), APPSCREEN_ENABLE_AI: 'false', APPSCREEN_EMBEDDED_WORKER: 'false' });
    check('Providers and OAuth are disabled with no provider credentials supplied', !config.allowLiveAI && !config.enableBilling && !config.mcpOAuthEnabled && !config.emailEnabled && !config.openaiKey && !config.supabaseServiceKey && !config.stripeKey && !config.resendKey);
    application = await createApp(config, db);
    await application.app.listen({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
    worker = createWorker(application.services, application.billing, { engine: (async () => { report.isolation.hostedEngineCalls++; throw new Error('Hosted engines are forbidden in this rehearsal.'); }) as any });
    console.log(`Synthetic MCP SDK rehearsal: ${output}`);

    async function api(path: string, method = 'GET', token?: string, body?: unknown) {
      const response = await guardedFetch(`${baseUrl}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.status, 200, `${method} ${path} failed with HTTP ${response.status}`);
      return response.json() as Promise<any>;
    }
    async function identity(label: string) {
      const { token } = await api('/api/dev/session', 'POST', undefined, { email: `mcp-${label}-${runId}@example.test` });
      const session = await api('/api/session', 'GET', token);
      const workspaceId = session.workspace.id;
      report.fixtureWorkspaces.push(workspaceId);
      return { token, workspaceId };
    }
    async function connection(owner: { token: string; workspaceId: string }, scopes: string[]) {
      const issued = await api('/api/connections', 'POST', owner.token, { name: 'Synthetic MCP SDK rehearsal', scopes, days: 1 });
      issuedTokens.push({ id: issued.id, workspaceId: owner.workspaceId });
      return issued as { id: string; token: string };
    }
    async function connect(token: string) {
      const client = new Client({ name: 'appscreen-isolated-sdk-rehearsal', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: guardedFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
      clients.push(client); await client.connect(transport);
      report.client.protocolVersion = transport.protocolVersion;
      check('Stateless initialization returns server identity and design instructions', client.getServerVersion()?.name === 'appscreen' && /real screenshots/.test(client.getInstructions() || '') && !transport.sessionId);
      return client;
    }
    async function call(client: Client, name: string, args: Record<string, unknown> = {}, expectedError?: string) {
      const result = await client.callTool({ name: `appscreen_${name}`, arguments: args });
      const payload: any = result.structuredContent || JSON.parse((result.content as any[]).find(block => block.type === 'text')?.text || '{}');
      if (expectedError) { check(`${name} rejects ${expectedError}`, result.isError === true && payload.error?.code === expectedError, { code: payload.error?.code }); }
      else assert.ok(!result.isError, `${name} failed: ${payload.error?.code || 'invalid result'}`);
      return payload;
    }
    const key = (name: string) => `${name}:${runId}`;
    const owner = await identity('owner'), stranger = await identity('other-workspace');
    const direct = await connection(owner, directScopes), readOnly = await connection(owner, ['projects:read']), foreign = await connection(stranger, directScopes);
    let client = await connect(direct.token);
    const reader = await connect(readOnly.token), outsider = await connect(foreign.token);
    const tools = await client.listTools();
    check('Real HTTP SDK discovers all 19 documented tools', tools.tools.length === 19);
    check('Discovery separates read and write annotations', tools.tools.find(tool => tool.name === 'appscreen_list_templates')?.annotations?.readOnlyHint === true && tools.tools.find(tool => tool.name === 'appscreen_create_draft')?.annotations?.readOnlyHint === false);
    check('Tool discovery exposes no filesystem, execution, billing or publishing operation', tools.tools.every(tool => !/(?:filesystem|exec_code|change_billing|publish_store)/.test(tool.name)));
    const reference = await call(client, 'get_operation_reference');
    check('Operation contract includes locks and direct text editing', reference.examples.some((operation: any) => operation.op === 'set_locks') && reference.examples.some((operation: any) => operation.op === 'update_text'));
    const projectArgs = { name: 'SYNTHETIC - MCP SDK protocol rehearsal', idempotencyKey: key('project') };
    const { project } = await call(client, 'create_project', projectArgs);
    report.projectId = project.id;
    check('Project creation replays one idempotent result', (await call(client, 'create_project', projectArgs)).project.id === project.id);
    await call(reader, 'create_project', { name: 'Must not exist', idempotencyKey: key('denied-write') }, 'INSUFFICIENT_SCOPE');
    await call(outsider, 'get_project', { projectId: project.id }, 'PROJECT_NOT_FOUND');
    const { project: foreignProject } = await call(outsider, 'create_project', { name: 'SYNTHETIC - isolated other workspace', idempotencyKey: key('foreign-project') });
    const sourceBytes = new Map<string, Buffer>();
    await mkdir(join(output, 'sources'));
    async function upload(target: Client, projectId: string, index: number, label: string) {
      const bytes = await syntheticSource(index), filename = `synthetic-${label}.png`;
      const ticket = await call(target, 'request_asset_upload', { projectId, filename, mimeType: 'image/png', byteLength: bytes.length, checksum: hash(bytes), idempotencyKey: key(`upload-${label}`) });
      const response = await guardedFetch(ticket.uploadUrl, { method: ticket.method, headers: ticket.headers, body: bytes });
      check(`Actual screenshot bytes upload over the scoped ticket (${label})`, response.status === 200);
      const { asset } = await call(target, 'complete_asset_upload', { projectId, assetId: ticket.assetId });
      check(`Uploaded image dimensions/checksum are verified (${label})`, asset.width === 330 && asset.height === 717 && asset.sha256 === hash(bytes));
      return { asset, bytes };
    }
    for (let index = 0; index < 3; index++) {
      const { asset, bytes } = await upload(client, project.id, index, String(index + 1));
      sourceBytes.set(asset.id, bytes);
      await writeFile(join(output, 'sources', asset.name), bytes, { mode: 0o600 });
      report.sources.push({ assetId: asset.id, name: asset.name, sha256: hash(bytes), width: asset.width, height: asset.height });
    }
    const { asset: foreignAsset } = await upload(outsider, foreignProject.id, 0, 'foreign');
    const uploaded = [...sourceBytes.keys()], sourceOrder = [uploaded[2], uploaded[0], uploaded[1]];
    const { templates } = await call(client, 'list_templates');
    const { template } = await call(client, 'get_template', { templateId: 'tidal-relay' });
    check('Catalog selection identifies a cloud-compatible connected template', templates.some((item: any) => item.id === template.id) && template.cloudCompatible === true);
    const draftArgs = { projectId: project.id, assetIds: sourceOrder, templateId: template.id, templateMode: 'exact', screenCount: 3, locale: 'en', profile: profile.id, idempotencyKey: key('draft') };
    const localOnlyTemplate = templates.find((item: any) => item.cloudCompatible === false);
    assert.ok(localOnlyTemplate, 'Catalog must expose the current local-only capability boundary.');
    await call(client, 'create_draft', { ...draftArgs, templateId: localOnlyTemplate.id, idempotencyKey: key('unsupported-template') }, 'UNSUPPORTED_TEMPLATE');
    await call(client, 'create_draft', { ...draftArgs, assetIds: [foreignAsset.id], idempotencyKey: key('foreign-source') }, 'ASSET_FORBIDDEN');
    const { revision: draft } = await call(client, 'create_draft', draftArgs);
    check('Draft creation replays without another revision', (await call(client, 'create_draft', draftArgs)).revision.id === draft.id);
    const document = draft.document;
    check('Explicit source order and stable source mapping survive composition', JSON.stringify(document.sources.map((source: any) => source.assetId)) === JSON.stringify(sourceOrder) && document.sources.every((source: any) => source.id === source.assetId) && document.scenes.every((scene: any, index: number) => scene.sourceId === sourceOrder[index]));
    check('Exact selected template and canonical campaign remain valid', document.template.id === 'tidal-relay' && document.template.mode === 'exact' && validateCampaign(document).valid);
    check('Creating a draft does not overwrite the active project', (await call(client, 'get_project', { projectId: project.id })).project.activeRevisionId === null);
    check('Project listing is limited to the authorized workspace', (await call(client, 'list_projects')).projects.every((item: any) => item.id !== foreignProject.id) && (await call(outsider, 'list_projects')).projects.every((item: any) => item.id !== project.id));
    const scene = document.scenes[0], placement = scene.devices[0];
    await call(client, 'apply_operations', { projectId: project.id, expectedRevisionId: draft.id, operations: [{ op: 'update_device', sceneId: scene.id, deviceId: placement.id, patch: { centerX: 0.4 } }], idempotencyKey: key('locked-geometry') }, 'LOCKED');
    const edits = document.scenes.map((item: any, index: number) => ({ op: 'update_text', sceneId: item.id, patch: { headlines: { en: `Synthetic ${index + 1}\nConnected screens` }, headlineSize: 88, subheadlineEnabled: false } }));
    edits.push({ op: 'set_locks', sceneId: scene.id, patch: { colors: true } });
    const editArgs = { projectId: project.id, expectedRevisionId: draft.id, operations: edits, idempotencyKey: key('edit') };
    const { revision: edited } = await call(client, 'apply_operations', editArgs);
    check('Direct editing replays without another revision', (await call(client, 'apply_operations', editArgs)).revision.id === edited.id);
    check('Copy-only edits preserve all canonical device and shared appearance groups', JSON.stringify(document.deviceGroups) === JSON.stringify(edited.document.deviceGroups) && JSON.stringify(document.appearanceGroups) === JSON.stringify(edited.document.appearanceGroups));
    await call(client, 'apply_operations', { projectId: project.id, expectedRevisionId: edited.id, operations: [{ op: 'update_background', sceneId: scene.id, patch: { type: 'solid', solid: '#FF0000' } }], idempotencyKey: key('locked-color') }, 'LOCKED');
    for (let index = 0; index < 2; index++) {
      const left = edited.document.scenes[index], right = edited.document.scenes[index + 1];
      const shared = left.devices.find((device: any) => right.devices.some((next: any) => next.groupId === device.groupId));
      assert.ok(shared);
      const a = resolveDevice(edited.document, left.id, shared.id), b = resolveDevice(edited.document, right.id, right.devices.find((device: any) => device.groupId === shared.groupId).id);
      check(`Connected device geometry and border continue across seam ${index + 1}`, Math.abs(a.centerX - b.centerX - 1) < 1e-9 && a.centerY === b.centerY && a.scale === b.scale && a.rotation === b.rotation && a.sourceId === b.sourceId && JSON.stringify(a.frame) === JSON.stringify(b.frame) && a.frame.enabled);
    }
    await call(client, 'create_design_job', { projectId: project.id, input: { revisionId: edited.id }, maxCredits: 5, idempotencyKey: key('denied-ai') }, 'INSUFFICIENT_SCOPE');
    const applyArgs = { projectId: project.id, revisionId: edited.id, expectedRevisionId: null, idempotencyKey: key('apply-reviewed-fixture') };
    await call(client, 'apply_revision', applyArgs);
    check('Explicit fixture approval applies one revision idempotently', (await call(client, 'apply_revision', applyArgs)).project.activeRevisionId === edited.id);
    await call(client, 'apply_revision', { ...applyArgs, revisionId: draft.id, idempotencyKey: key('stale-apply') }, 'REVISION_CONFLICT');
    report.revisionId = edited.id;
    await writeFile(join(output, 'campaign-document.json'), JSON.stringify(edited.document, null, 2), { mode: 0o600 });

    let revocationMediaUrl = '';
    for (const format of ['preview', 'project', 'zip'] as const) {
      const tool = format === 'preview' ? 'render_preview' : 'create_export_job';
      const args = { projectId: project.id, revisionId: edited.id, ...(format === 'preview' ? {} : { format }), idempotencyKey: key(`export-${format}`) };
      const { job: queued } = await call(client, tool, args);
      check(`${format} job requests replay without duplicate admission`, (await call(client, tool, args)).job.id === queued.id);
      if (format === 'preview') { await client.close(); client = await connect(direct.token); }
      check(`${format} durable job remains readable after request completion`, (await call(client, 'get_job', { jobId: queued.id })).job.id === queued.id);
      await worker.run(queued.id); // Explicit single synthetic job, never a queue consumer.
      const { job } = await call(client, 'get_job', { jobId: queued.id });
      check(`${format} real renderer finishes with three immutable scene previews`, ['ready', 'needs-input'].includes(job.status) && job.result?.previews?.length === 3 && job.result.revisionId === edited.id, { status: job.status, errorCode: job.error?.code });
      const { result } = await call(client, 'get_result_links', { jobId: queued.id });
      check(`${format} renderer has no error-severity QA findings`, !result.qa.issues.some((issue: any) => issue.severity === 'error'));
      await call(outsider, 'get_job', { jobId: queued.id }, 'JOB_NOT_FOUND');
      await call(outsider, 'get_result_links', { jobId: queued.id }, 'JOB_NOT_FOUND');
      const directory = join(output, format); await mkdir(directory);
      const pngs = new Map<string, Buffer>(), files: any[] = [];
      let zip: Buffer | undefined, backup: Buffer | undefined;
      for (const artifact of [...result.artifacts, result.contactSheet]) {
        const response = await guardedFetch(artifact.url); assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.match(artifact.name, /^(?:\d\d-en\.png|contact-sheet\.png|campaign\.zip|editable-project\.zip)$/);
        await writeFile(join(directory, artifact.name), bytes, { mode: 0o600 });
        files.push({ name: artifact.name, assetId: artifact.assetId, bytes: bytes.length, sha256: hash(bytes) });
        revocationMediaUrl = artifact.url;
        if (/^\d\d-en\.png$/.test(artifact.name)) {
          const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
          const pixels = await sharp(bytes, { failOn: 'error' }).raw().toBuffer();
          check(`${format}/${artifact.name} is a fully decoded opaque 1320 × 2868 PNG`, metadata.format === 'png' && metadata.width === profile.width && metadata.height === profile.height && !metadata.hasAlpha && pixels.length === profile.width * profile.height * 3);
          const sceneIndex = Number(artifact.name.slice(0, 2)) - 1;
          const sourceColor = colors[uploaded.indexOf(sourceOrder[sceneIndex])].slice(1).match(/../g)!.map(value => parseInt(value, 16));
          let sourceMarkerPixels = 0;
          for (let pixel = 0; pixel < pixels.length; pixel += 3) if (pixels[pixel] === sourceColor[0] && pixels[pixel + 1] === sourceColor[1] && pixels[pixel + 2] === sourceColor[2]) sourceMarkerPixels++;
          check(`${format}/${artifact.name} visibly contains its explicitly mapped source marker`, sourceMarkerPixels > 1000, { sourceMarkerPixels });
          pngs.set(artifact.name, bytes);
        } else if (artifact.name === 'campaign.zip') zip = bytes;
        else if (artifact.name === 'editable-project.zip') backup = bytes;
      }
      check(`${format} downloads exactly three ordered store screens`, [...pngs.keys()].join(',') === '01-en.png,02-en.png,03-en.png');
      if (backup) {
        const archive = await JSZip.loadAsync(backup, { checkCRC32: true }), manifest = JSON.parse(await archive.file('project.json')!.async('string'));
        check('Portable backup preserves the exact editable document and ordered source mapping', manifest.format === 'appscreen-campaign' && JSON.stringify(manifest.document) === JSON.stringify(edited.document));
        for (const asset of manifest.assets) check(`Portable backup preserves original uploaded bytes (${asset.id})`, hash(await archive.file(asset.file)!.async('nodebuffer')) === hash(sourceBytes.get(asset.id)!));
        check('Portable backup contains all three original sources', manifest.assets.length === 3);
      }
      if (zip) {
        const archive = await JSZip.loadAsync(zip, { checkCRC32: true }), manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
        check('Store ZIP manifest matches revision, dimensions and ordered scenes', manifest.revisionId === edited.id && JSON.stringify(manifest.profile) === JSON.stringify(profile) && JSON.stringify(manifest.screens.map((screen: any) => screen.sceneId)) === JSON.stringify(edited.document.scenes.map((item: any) => item.id)));
        check('Store ZIP has only the three PNGs and manifest', Object.keys(archive.files).sort().join(',') === ['01-en.png', '02-en.png', '03-en.png', 'manifest.json'].sort().join(','));
        for (const [name, bytes] of pngs) check(`Store ZIP entry matches separately downloaded PNG (${name})`, hash(await archive.file(name)!.async('nodebuffer')) === hash(bytes));
      }
      check(`${format} requested archive format is actually present`, format === 'preview' || (format === 'project' ? !!backup : !!zip));
      report.jobs.push({ id: job.id, format, status: job.status, revisionId: edited.id, qa: result.qa, files });
    }
    const beforeRevoke = await api('/api/usage', 'GET', owner.token);
    check('Direct MCP workflow spends no AI credits', beforeRevoke.credits.available === config.trialCredits && beforeRevoke.credits.reserved === 0 && beforeRevoke.events.every((event: any) => event.reason === 'trial'));
    const scopeRows = await db.query('SELECT kind,status FROM agent_jobs WHERE workspace_id=$1', [owner.workspaceId]);
    check('Only the three explicit synthetic export jobs were created and completed', scopeRows.rows.length === 3 && scopeRows.rows.every((job: any) => job.kind === 'export' && ['ready', 'needs-input'].includes(job.status)));
    const pendingBytes = await syntheticSource(0);
    const pendingTicket = await call(client, 'request_asset_upload', { projectId: project.id, filename: 'revoked-upload.png', mimeType: 'image/png', byteLength: pendingBytes.length, checksum: hash(pendingBytes), idempotencyKey: key('revoked-upload') });
    await api(`/api/connections/${direct.id}`, 'DELETE', owner.token);
    const protocolIndex = report.protocol.length;
    await assert.rejects(() => client.listTools());
    check('An already-initialized SDK connection is denied immediately after revocation', report.protocol.slice(protocolIndex).some((item: any) => item.method === 'POST' && item.status === 401));
    check('Previously signed media links stop working after their connection is revoked', (await guardedFetch(revocationMediaUrl)).status === 403);
    check('Previously issued upload tickets stop working after connection revocation', (await guardedFetch(pendingTicket.uploadUrl, { method: pendingTicket.method, headers: pendingTicket.headers, body: pendingBytes })).status === 403);
    check('Revocation does not break another valid read-only connection', (await call(reader, 'get_project', { projectId: project.id })).project.activeRevisionId === edited.id);
    check('Revocation does not alter the other synthetic workspace', (await call(outsider, 'get_project', { projectId: foreignProject.id })).project.id === foreignProject.id);
    check('All Node fetches stayed on the isolated listener and no hosted engine ran', report.isolation.externalFetchAttempts === 0 && report.isolation.hostedEngineCalls === 0);
    check('Protocol evidence includes actual initialization, notification, discovery and tools/call responses', ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].every(method => report.protocol.some((entry: any) => entry.rpc === method && entry.status >= 200 && entry.status < 300)));
    report.completed = true;
  } catch (error: any) {
    // Assertions are authored labels; unexpected messages/stacks can contain
    // transport URLs or credentials and must not be persisted or printed.
    report.failure = { name: error?.name || 'Error', code: /^[A-Z_]{2,60}$/.test(error?.code || '') ? error.code : undefined, ...(error?.name === 'AssertionError' ? { assertion: String(error.message).split('\n')[0] } : {}) };
    process.exitCode = 1;
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    await worker?.renderer.close().catch(() => {});
    for (const token of issuedTokens) await db.query('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2', [token.id, token.workspaceId]);
    report.cleanup = { allSyntheticTokensRevoked: true, projectsAndArtifactsRetained: true, globalConfigurationChanged: false };
    await application?.app.close(); await db.end(); globalThis.fetch = nativeFetch;
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ completed: report.completed, checks: report.checks.length, passed: report.checks.filter((item: any) => item.pass).length, report: join(output, 'report.json'), ...(report.failure ? { failure: report.failure } : {}) }));
  }
}

// Setup/cleanup failures can carry connection strings or signed URLs. Keep the
// top-level fallback as redacted as the main report's unexpected-error path.
await main().catch(() => { process.exitCode = 1; console.error('The isolated MCP rehearsal could not start or finish cleanup. No unexpected error details were printed.'); });
