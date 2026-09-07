import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  LIVE_AI_CONFIRMATION, LIVE_AI_TOTAL_CONFIRMATION, LIVE_AI_FIXTURE_VERSION, LIVE_AI_LIMITS, LIVE_AI_RATE_CARD,
  assertLiveAITestDatabase, parseLiveAIArguments, assertPreparedDirectory, readBoundedFile, readPreparedChild,
  assertLiveAIApproval, claimLiveAIAttempt, createLiveAIReportWriter, extractApprovedOpenAIKey,
  assertApprovedOpenAIRequest, createApprovedOpenAIFetch, canonicalJSON, sha256, liveAIBudgetBinding,
} from '../../deploy/live-ai-smoke-guards.mjs';
import { syntheticLiveAISources, fixedManualDocument, assertFixedManualDocument, normalizedFixtureDocument, connectedFixtureGeometry } from './live-ai-fixtures.mjs';

// No dotenv import, provider SDK, database connection or live harness import.
// Every key-like string below is a fixed invalid synthetic test value.
const keyFile = '/synthetic/project/.env';
const database = assertLiveAITestDatabase('postgresql://synthetic:synthetic@127.0.0.1:55432/appscreen_test');
const now = new Date(`${LIVE_AI_RATE_CARD.verifiedAt}T12:00:00.000Z`);
function prepared() {
  return { kind: 'appscreen-live-ai-prepared', version: 1, fixtureVersion: LIVE_AI_FIXTURE_VERSION, status: 'prepared-no-live-authorization', runId: randomUUID(), rateCard: { ...LIVE_AI_RATE_CARD }, limits: { ...LIVE_AI_LIMITS }, databaseFingerprint: database.fingerprint, preparedAt: new Date(now.getTime() - 1000).toISOString() };
}
function approval(value: ReturnType<typeof prepared>) {
  return { APPSCREEN_LIVE_AI_CONFIRM: LIVE_AI_CONFIRMATION, APPSCREEN_LIVE_AI_RUN_ID: value.runId, APPSCREEN_LIVE_AI_RATE_REVIEWED: LIVE_AI_RATE_CARD.verifiedAt, APPSCREEN_LIVE_AI_KEY_FILE: keyFile };
}
const options = { now, databaseFingerprint: database.fingerprint, expectedKeyFile: keyFile };
const expectCode = (code: string) => (error: any) => error.code === code;
async function temporary(t: any) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'appscreen-live-ai-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const identities = () => ({ runId: randomUUID(), projectId: randomUUID(), assetIds: Array.from({ length: 5 }, () => randomUUID()) });
const responseBody = () => ({ model: LIVE_AI_RATE_CARD.model, store: false, service_tier: 'default', max_output_tokens: 6000, input: 'Synthetic test only.' });
const request = (body: any = responseBody()) => ({ method: 'POST', headers: {}, body: JSON.stringify(body) });

test('live rehearsal defaults to offline prepare and demands exact live arguments', () => {
  assert.deepEqual(parseLiveAIArguments([]), { mode: 'prepare' });
  assert.deepEqual(parseLiveAIArguments(['--prepare']), { mode: 'prepare' });
  assert.deepEqual(parseLiveAIArguments(['--live', '/synthetic/absolute']), { mode: 'live', directory: '/synthetic/absolute' });
  for (const args of [['--live'], ['--live', 'relative'], ['--live', '/synthetic', '--retry'], ['--prepare', 'extra']]) assert.throws(() => parseLiveAIArguments(args));
});
test('only literal loopback and exact appscreen_test database are admitted', () => {
  assert.equal(database.database, 'appscreen_test'); assert.match(database.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(assertLiveAITestDatabase('postgres://synthetic@[::1]/appscreen_test').database, 'appscreen_test');
  for (const url of ['', 'https://127.0.0.1/appscreen_test', 'postgres://localhost/appscreen_test', 'postgres://db.example/appscreen_test', 'postgres://127.0.0.1/appscreen', 'postgres://127.0.0.1/appscreen_test_extra', 'postgres://127.0.0.1/appscreen_test?options=unsafe', 'postgres://127.0.0.1/appscreen_test#fragment']) assert.throws(() => assertLiveAITestDatabase(url));
});
test('approval is explicit, exact run, budget, date, database and key path', () => {
  const value = prepared(); assert.doesNotThrow(() => assertLiveAIApproval(value, approval(value), options));
  for (const field of Object.keys(approval(value))) { const env = approval(value); delete (env as any)[field]; assert.throws(() => assertLiveAIApproval(value, env, options)); }
  assert.throws(() => assertLiveAIApproval(value, { ...approval(value), APPSCREEN_LIVE_AI_RUN_ID: randomUUID() }, options), expectCode('EXPLICIT_LIVE_APPROVAL_REQUIRED'));
  assert.throws(() => assertLiveAIApproval(value, approval(value), { ...options, databaseFingerprint: 'changed' }), expectCode('PREPARED_DATABASE_CHANGED'));
  assert.throws(() => assertLiveAIApproval(value, approval(value), { ...options, expectedKeyFile: '/another/project/.env' }), expectCode('EXACT_APPROVED_KEY_FILE_REQUIRED'));
  assert.throws(() => assertLiveAIApproval({ ...value, limits: { ...value.limits, budgetMicroUsd: 6_000_000 } }, approval(value), options), expectCode('PREPARED_BUDGET_CHANGED'));
  assert.throws(() => assertLiveAIApproval({ ...value, rateCard: { ...value.rateCard, verifiedAt: '2020-01-01' } }, approval(value), options), expectCode('PREPARED_BUDGET_CHANGED'));
});
test('approval expires with rate-review UTC day or six-hour preparation window', () => {
  const value = prepared();
  assert.throws(() => assertLiveAIApproval(value, approval(value), { ...options, now: new Date(now.getTime() + 24 * 3600000) }), expectCode('FRESH_RATE_REVIEW_REQUIRED'));
  for (const time of ['invalid', new Date(now.getTime() + 1).toISOString(), new Date(now.getTime() - 6 * 3600000 - 1).toISOString()]) assert.throws(() => assertLiveAIApproval({ ...value, preparedAt: time }, approval(value), options), expectCode('PREPARATION_EXPIRED'));
});
test('aggregate allowance requires explicit total consent and pinned ledger identity', () => {
  const env = { APPSCREEN_LIVE_AI_TOTAL_CONFIRM: LIVE_AI_TOTAL_CONFIRMATION, APPSCREEN_LIVE_AI_BUDGET_DIRECTORY: '/synthetic/private-budget', APPSCREEN_LIVE_AI_BUDGET_ID: randomUUID(), APPSCREEN_LIVE_AI_BUDGET_MANIFEST_SHA256: 'a'.repeat(64) };
  assert.deepEqual(liveAIBudgetBinding(env), { directory: env.APPSCREEN_LIVE_AI_BUDGET_DIRECTORY, expectedBudgetId: env.APPSCREEN_LIVE_AI_BUDGET_ID, expectedManifestSha256: env.APPSCREEN_LIVE_AI_BUDGET_MANIFEST_SHA256 });
  for (const field of Object.keys(env)) { const missing = { ...env }; delete (missing as any)[field]; assert.throws(() => liveAIBudgetBinding(missing)); }
  for (const patch of [{ APPSCREEN_LIVE_AI_TOTAL_CONFIRM: LIVE_AI_CONFIRMATION }, { APPSCREEN_LIVE_AI_BUDGET_DIRECTORY: 'relative' }, { APPSCREEN_LIVE_AI_BUDGET_DIRECTORY: '/synthetic/../other' }, { APPSCREEN_LIVE_AI_BUDGET_ID: 'wrong' }, { APPSCREEN_LIVE_AI_BUDGET_MANIFEST_SHA256: 'not-a-hash' }]) assert.throws(() => liveAIBudgetBinding({ ...env, ...patch }));
});
test('prepared directory must be canonical freshly-named temp child, never symlink', async t => {
  const directory = await temporary(t);
  assert.equal(await assertPreparedDirectory(directory, tmpdir()), directory);
  const nested = join(directory, 'nested'); await mkdir(nested);
  await assert.rejects(assertPreparedDirectory(nested, tmpdir()), expectCode('PREPARED_DIRECTORY_INVALID'));
  const alias = join(directory, 'alias'); await symlink(directory, alias);
  await assert.rejects(assertPreparedDirectory(alias, tmpdir()), expectCode('PREPARED_DIRECTORY_INVALID'));
  await assert.rejects(assertPreparedDirectory(directory + '/.', tmpdir()), expectCode('PREPARED_DIRECTORY_INVALID'));
});
test('prepared child and key-file reads reject size, final links and symlink ancestors', async t => {
  const directory = await temporary(t), original = join(directory, 'fixture.txt');
  await writeFile(original, 'synthetic');
  assert.equal((await readBoundedFile(original, 100)).toString(), 'synthetic');
  await assert.rejects(readBoundedFile(original, 2), expectCode('REHEARSAL_FILE_INVALID'));
  await assert.rejects(readBoundedFile(directory, 100));
  const alias = join(directory, 'linked.txt'); await symlink(original, alias);
  await assert.rejects(readBoundedFile(alias, 100));
  await mkdir(join(directory, 'child')); await writeFile(join(directory, 'child', 'test.txt'), 'synthetic');
  await symlink(join(directory, 'child'), join(directory, 'linked-child'));
  await assert.rejects(readPreparedChild(directory, 'linked-child/test.txt', 100), expectCode('PREPARED_CHILD_INVALID'));
  await assert.rejects(readPreparedChild(directory, '../outside.txt', 100), expectCode('PREPARED_CHILD_INVALID'));
  assert.equal((await readPreparedChild(directory, 'child/test.txt', 100)).toString(), 'synthetic');
});
test('one-use live attempt has exactly one concurrent winner and cannot be retried', async t => {
  const directory = await temporary(t), value = prepared();
  const results = await Promise.allSettled([claimLiveAIAttempt(directory, value), claimLiveAIAttempt(directory, value)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'LIVE_ATTEMPT_ALREADY_USED').length, 1);
  const original = await readFile(join(directory, 'live-attempt.json'));
  await assert.rejects(claimLiveAIAttempt(directory, value), expectCode('LIVE_ATTEMPT_ALREADY_USED'));
  assert.deepEqual(await readFile(join(directory, 'live-attempt.json')), original);
  const receipt = JSON.parse(original.toString()); assert.equal(receipt.runId, value.runId); assert.equal(receipt.budgetMicroUsd, 5_000_000);
});
test('concurrent loser and later refusals never overwrite authoritative report bytes', async t => {
  const directory = await temporary(t), value = prepared();
  const writers = [createLiveAIReportWriter(directory, 'live'), createLiveAIReportWriter(directory, 'live')];
  const results = await Promise.allSettled(writers.map(writer => writer.claim(value)));
  const winner = writers[results.findIndex(result => result.status === 'fulfilled')], loser = writers[results.findIndex(result => result.status === 'rejected')];
  assert.ok(winner && loser); assert.equal(winner.path, join(directory, 'live-report.json'));
  await winner.persist({ checkpoint: 'first live evidence', completed: false });
  const original = await readFile(winner.path);
  await loser.persist({ status: 'concurrent refusal' });
  assert.notEqual(loser.path, winner.path); assert.deepEqual(await readFile(winner.path), original);
  const later = createLiveAIReportWriter(directory, 'live');
  await assert.rejects(later.claim(value), expectCode('LIVE_ATTEMPT_ALREADY_USED'));
  await later.persist({ status: 'later refusal' });
  assert.deepEqual(await readFile(winner.path), original);
  await winner.persist({ checkpoint: 'same owner final evidence', completed: false });
  assert.equal(JSON.parse((await readFile(winner.path)).toString()).checkpoint, 'same owner final evidence');
});
test('orphaned authoritative evidence is preserved even with no earlier claim', async t => {
  const directory = await temporary(t), original = Buffer.from('retained previous evidence');
  await writeFile(join(directory, 'live-report.json'), original);
  const writer = createLiveAIReportWriter(directory, 'live'); await assert.rejects(writer.claim(prepared()));
  await writer.persist({ status: 'refused orphan evidence overwrite' });
  assert.deepEqual(await readFile(join(directory, 'live-report.json')), original);
});
test('key parser uses only one explicit exact key with no interpolation or fallback', () => {
  for (const text of ['OPENAI_API_KEY=sk-synthetic-not-valid', 'export OPENAI_API_KEY="sk-synthetic-not-valid" # test', "OPENAI_API_KEY='sk-synthetic-not-valid'"])
    assert.equal(extractApprovedOpenAIKey(Buffer.from(`UNRELATED_KEY=do-not-read\n${text}\nOPENAI_BASE_URL=https://bad.example`)), 'sk-synthetic-not-valid');
  for (const text of ['OPENAI_KEY=sk-synthetic', 'OPENAI_API_KEY=', 'OPENAI_API_KEY=${OTHER}', 'OPENAI_API_KEY=sk-test\nOPENAI_API_KEY=sk-other', 'OPENAI_API_KEY=sk-test bad']) assert.throws(() => extractApprovedOpenAIKey(Buffer.from(text)));
});
test('provider fetch permits only exact HTTPS Responses and token-count POST endpoints', () => {
  assert.equal(assertApprovedOpenAIRequest('https://api.openai.com/v1/responses', request()), '/v1/responses');
  assert.equal(assertApprovedOpenAIRequest('https://api.openai.com/v1/responses/input_tokens', request()), '/v1/responses/input_tokens');
  for (const url of ['http://api.openai.com/v1/responses', 'https://evil.example/v1/responses', 'https://api.openai.com:444/v1/responses', 'https://user@api.openai.com/v1/responses', 'https://api.openai.com/v1/responses?query=yes', 'https://api.openai.com/v1/responses#hash', 'https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/files', 'https://api.openai.com/v1/responses/one']) assert.throws(() => assertApprovedOpenAIRequest(url, request()), expectCode('PROVIDER_NETWORK_DENIED'));
  assert.throws(() => assertApprovedOpenAIRequest('https://api.openai.com/v1/responses', { ...request(), method: 'GET' }), expectCode('PROVIDER_NETWORK_DENIED'));
});
test('provider fetch denies inherited account context and weakened body policy', () => {
  for (const header of ['OpenAI-Organization', 'OpenAI-Project', 'Cookie']) assert.throws(() => assertApprovedOpenAIRequest('https://api.openai.com/v1/responses', { ...request(), headers: { [header]: 'synthetic' } }), expectCode('INHERITED_PROVIDER_CONTEXT_DENIED'));
  for (const patch of [{ model: 'wrong' }, { store: true }, { service_tier: 'priority' }, { max_output_tokens: 6001 }]) assert.throws(() => assertApprovedOpenAIRequest('https://api.openai.com/v1/responses', request({ ...responseBody(), ...patch })));
  assert.throws(() => assertApprovedOpenAIRequest('https://api.openai.com/v1/responses', { ...request(), body: 'invalid' }), expectCode('PROVIDER_BODY_DENIED'));
});
test('mock provider transport always rejects redirects and never sees denied requests', async () => {
  const calls: any[] = [], events: any[] = [];
  const wrapped = createApprovedOpenAIFetch(async (input: Request, init: RequestInit) => { calls.push({ input, init }); return new Response('{}', { status: 200 }); }, event => events.push(event));
  await wrapped('https://api.openai.com/v1/responses', request());
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].input.method, 'POST');
  assert.deepEqual(events, [{ path: '/v1/responses', method: 'POST' }]);
  await assert.rejects(wrapped('https://other.example/v1/responses', request())); assert.equal(calls.length, 1);
});
test('five fixed synthetic sources are deterministic, distinct, full-size opaque PNGs', async () => {
  const [first, second] = await Promise.all([syntheticLiveAISources(), syntheticLiveAISources()]);
  assert.equal(first.length, 5); assert.equal(new Set(first.map(source => sha256(source.bytes))).size, 5);
  for (const [index, source] of first.entries()) {
    assert.equal(source.name, `synthetic-focusboard-${index + 1}.png`); assert.equal(sha256(source.bytes), sha256(second[index].bytes));
    const meta = await sharp(source.bytes, { failOn: 'error' }).metadata(); assert.equal(meta.width, 1179); assert.equal(meta.height, 2556); assert.equal(meta.hasAlpha, false);
    const { data, info } = await sharp(source.bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true }); assert.equal(info.channels, 3); assert.equal(data.length, 1179 * 2556 * 3);
  }
});
test('fresh synthetic base normalizes only regenerated runtime identities', () => {
  const ids = identities(), first = fixedManualDocument(ids), second: any = fixedManualDocument(ids);
  second.revisionId = randomUUID(); assert.notEqual(first.scenes[0].id, second.scenes[0].id);
  assert.deepEqual(normalizedFixtureDocument(first), normalizedFixtureDocument(second));
  assert.doesNotThrow(() => assertFixedManualDocument(second, ids));
});
test('writable manifest hash cannot approve tampered brief, copy, metadata or other asset', () => {
  const ids = identities(), original = fixedManualDocument(ids);
  const changes: Array<(document: any) => void> = [
    doc => { doc.brief.promise = 'Arbitrary private text'; }, doc => { doc.name = 'Changed name'; },
    doc => { doc.scenes[0].text.headlines.en = 'Private copy'; }, doc => { doc.privateMetadata = 'Sensitive'; },
    doc => { doc.scenes[0].privateMetadata = 'Sensitive'; }, doc => { doc.sources[0].name = 'private-file.png'; },
    doc => { doc.sources[0].localizedAssets.fr = randomUUID(); }, doc => { doc.scenes[0].background.assetId = randomUUID(); },
    doc => { doc.scenes[0].elements.push({ id: `element_${randomUUID()}`, type: 'image', assetId: randomUUID() }); },
    doc => { doc.deviceGroups[0].geometry.centerX += .01; }, doc => { doc.revision = 123; },
    doc => { doc.scenes[0].id = 'scene_private-information'; },
  ];
  for (const change of changes) { const document: any = structuredClone(original); change(document); const mutableManifestHash = sha256(canonicalJSON(document)); assert.match(mutableManifestHash, /^[0-9a-f]{64}$/); assert.throws(() => assertFixedManualDocument(document, ids)); }
});
test('exact layout comparison accepts recreated IDs and approved source reassignment', () => {
  const ids = identities(), first = fixedManualDocument(ids), regenerated = fixedManualDocument(ids);
  regenerated.deviceGroups.forEach((group: any, index: number) => { group.sourceId = regenerated.sources[(index + 1) % 5].id; });
  regenerated.appearanceGroups[0].frame.color = '#123456';
  const expected = connectedFixtureGeometry(first), actual = connectedFixtureGeometry(regenerated);
  assert.equal(actual.handoffs.length, 4); assert.deepEqual(actual, expected);
  regenerated.deviceGroups[0].geometry.scale += 1;
  assert.notDeepEqual(connectedFixtureGeometry(regenerated), expected);
});
test('geometry verification rejects unapproved source and broken adjacent handoff', () => {
  const document = fixedManualDocument(identities());
  document.deviceGroups[0].sourceId = randomUUID();
  assert.throws(() => connectedFixtureGeometry(document), expectCode('NONFIXTURE_DEVICE_SOURCE_DENIED'));
  const broken = fixedManualDocument(identities()); broken.deviceGroups[0].geometry.positionMode = 'screenshot';
  assert.throws(() => connectedFixtureGeometry(broken), expectCode('BROKEN_DEVICE_HANDOFF'));
});
