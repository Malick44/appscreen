import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, readdir, realpath, chmod, symlink, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLiveAIBudgetLedger, openLiveAIBudgetLedger } from './live-ai-budget-ledger.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const seed = () => ({ runId: randomUUID(), reportSha256: digest('offline synthetic prior report; not the real report'), reservedUpperBoundMicroUsd: 454_725 });
async function fixture() {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'appscreen-budget-tests-')));
  const prior = seed();
  const created = await createLiveAIBudgetLedger({ temporaryRoot, budgetMicroUsd: 5_000_000, seedReservations: [prior] });
  const options = { directory: created.directory, temporaryRoot, expectedBudgetId: created.budgetId, expectedManifestSha256: created.manifestSha256, runId: randomUUID(), approvalSha256: digest('offline explicit approval') };
  return { temporaryRoot, prior, created, options, open: extra => openLiveAIBudgetLedger({ ...options, ...extra }) };
}
const receipt = async (directory, name) => JSON.parse(await readFile(join(directory, name), 'utf8'));

test('creation uses a private immutable manifest and carries forward the full prior reservation', async () => {
  const f = await fixture(), manifestBytes = await readFile(join(f.created.directory, 'manifest.json'));
  assert.equal((await stat(f.created.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.created.directory, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal(digest(manifestBytes), f.created.manifestSha256);
  assert.deepEqual(JSON.parse(manifestBytes).seedReservations, [f.prior]);
  assert.equal(f.created.budgetMicroUsd, 5_000_000);
  assert.equal(f.created.reservedUpperBoundMicroUsd, 454_725);
  assert.equal(f.created.remainingMicroUsd, 4_545_275);
  const ledger = await f.open();
  const snapshot = ledger.snapshot(); snapshot.budgetMicroUsd = 1; snapshot.directory = 'changed';
  assert.equal(ledger.snapshot().budgetMicroUsd, 5_000_000);
  assert.equal(ledger.snapshot().directory, f.created.directory);
  await ledger.close();
  assert.deepEqual(await readFile(join(f.created.directory, 'manifest.json')), manifestBytes);
});

test('durable reservations survive clean close and accumulate across fresh approved runs', async () => {
  const f = await fixture(), first = await f.open();
  const details = { call: 1, reservedUpperBoundMicroUsd: 1_000 };
  const pending = first.reserve(details); details.reservedUpperBoundMicroUsd = 1;
  await pending;
  assert.equal((await receipt(f.created.directory, 'reservation-000001.json')).reservedUpperBoundMicroUsd, 1_000);
  await first.reserve({ call: 2, reservedUpperBoundMicroUsd: 2_000 });
  const before = await readFile(join(f.created.directory, 'reservation-000001.json'));
  await first.close();
  assert.equal(first.snapshot().closed, true);
  assert.equal(first.snapshot().remainingMicroUsd, 4_542_275);
  assert.ok(!(await readdir(f.created.directory)).includes('owner.lock'));
  const next = await f.open({ runId: randomUUID(), approvalSha256: digest('second offline approval') });
  assert.equal(next.snapshot().reservedUpperBoundMicroUsd, 457_725);
  await next.reserve({ call: 1, reservedUpperBoundMicroUsd: 4_000 });
  await next.close();
  assert.equal(next.snapshot().reservedUpperBoundMicroUsd, 461_725);
  assert.deepEqual(await readFile(join(f.created.directory, 'reservation-000001.json')), before);
  assert.equal((await readdir(f.created.directory)).filter(name => name.startsWith('reservation-')).length, 3);
});

test('exact cap is admitted once; no later run can release holds or exceed the total budget', async () => {
  const f = await fixture(), ledger = await f.open();
  await ledger.reserve({ call: 1, reservedUpperBoundMicroUsd: 4_545_275 });
  assert.equal(ledger.snapshot().reservedUpperBoundMicroUsd, 5_000_000);
  assert.equal(ledger.snapshot().remainingMicroUsd, 0);
  await assert.rejects(ledger.reserve({ call: 2, reservedUpperBoundMicroUsd: 1 }), { code: 'BUDGET_LEDGER_EXCEEDED' });
  await assert.rejects(ledger.reserve({ call: 2, reservedUpperBoundMicroUsd: 1 }), { code: 'BUDGET_LEDGER_STOPPED' });
  await ledger.close();
  const next = await f.open({ runId: randomUUID() });
  await assert.rejects(next.reserve({ call: 1, reservedUpperBoundMicroUsd: 1 }), { code: 'BUDGET_LEDGER_EXCEEDED' });
  await next.close();
  assert.equal((await readdir(f.created.directory)).filter(name => name.startsWith('reservation-')).length, 1);
});

test('concurrent calls serialize; repeating a call never authorizes another dispatch', async () => {
  const f = await fixture(), ledger = await f.open();
  await Promise.all([1, 2].map(call => ledger.reserve({ call, reservedUpperBoundMicroUsd: 10 })));
  assert.equal(ledger.snapshot().reservedUpperBoundMicroUsd, 454_745);
  const results = await Promise.allSettled([1, 2].map(() => ledger.reserve({ call: 3, reservedUpperBoundMicroUsd: 10 })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'BUDGET_LEDGER_CALL_REUSED');
  assert.equal(ledger.snapshot().reservedUpperBoundMicroUsd, 454_755);
  await ledger.close();
});

test('simultaneous open attempts admit exactly one process owner', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([1, 2].map(() => f.open({ runId: randomUUID() })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'BUDGET_LEDGER_BUSY');
  await results.find(item => item.status === 'fulfilled').value.close();
});

test('clean close waits for queued reservations and closes future admission immediately', async () => {
  const f = await fixture(), ledger = await f.open();
  const pending = ledger.reserve({ call: 1, reservedUpperBoundMicroUsd: 123 });
  const closing = ledger.close();
  await assert.rejects(ledger.reserve({ call: 2, reservedUpperBoundMicroUsd: 1 }), { code: 'BUDGET_LEDGER_STOPPED' });
  await pending; await closing;
  assert.equal((await receipt(f.created.directory, `closed-${f.options.runId}.json`)).reservationCount, 1);
  assert.equal(ledger.snapshot().reservedUpperBoundMicroUsd, 454_848);
});

test('historical seed and completed run IDs cannot be reused, even with a different approval hash', async () => {
  const f = await fixture();
  await assert.rejects(f.open({ runId: f.prior.runId }), { code: 'BUDGET_LEDGER_RUN_REUSED' });
  const ledger = await f.open(); await ledger.close();
  await assert.rejects(f.open({ approvalSha256: digest('a new approval cannot make the old run fresh') }), { code: 'BUDGET_LEDGER_RUN_REUSED' });
  assert.ok(!(await readdir(f.created.directory)).includes('owner.lock'));
});

test('wrong pinned manifest or budget identity rejects before claiming ownership', async () => {
  const f = await fixture();
  await assert.rejects(f.open({ expectedBudgetId: randomUUID() }), { code: 'BUDGET_LEDGER_APPROVAL_MISMATCH' });
  await assert.rejects(f.open({ expectedManifestSha256: digest('not this ledger') }), { code: 'BUDGET_LEDGER_APPROVAL_MISMATCH' });
  assert.deepEqual(await readdir(f.created.directory), ['manifest.json']);
});

test('invalid budget, seed values and hashes cannot create a reset or negative balance', async () => {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'appscreen-budget-tests-')));
  for (const budgetMicroUsd of [0, -1, 5_000_001, 0.1, NaN, Infinity, '5000000']) {
    await assert.rejects(createLiveAIBudgetLedger({ temporaryRoot, budgetMicroUsd, seedReservations: [seed()] }));
  }
  for (const seedReservations of [[], [null], [{ ...seed(), reservedUpperBoundMicroUsd: -1 }], [{ ...seed(), reservedUpperBoundMicroUsd: 0 }], [{ ...seed(), reportSha256: '../escape' }]]) {
    await assert.rejects(createLiveAIBudgetLedger({ temporaryRoot, budgetMicroUsd: 5_000_000, seedReservations }));
  }
  const repeated = seed();
  await assert.rejects(createLiveAIBudgetLedger({ temporaryRoot, budgetMicroUsd: 5_000_000, seedReservations: [repeated, repeated] }));
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('invalid or skipped call values stop locally without writing a reservation', async () => {
  for (const details of [null, { call: 0, reservedUpperBoundMicroUsd: 1 }, { call: 2, reservedUpperBoundMicroUsd: 1 }, { call: 1, reservedUpperBoundMicroUsd: 0 }, { call: 1, reservedUpperBoundMicroUsd: -1 }, { call: 1, reservedUpperBoundMicroUsd: 0.5 }, { call: 1, reservedUpperBoundMicroUsd: NaN }, { call: 1, reservedUpperBoundMicroUsd: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = await fixture(), ledger = await f.open();
    await assert.rejects(ledger.reserve(details));
    assert.equal(ledger.snapshot().reservationCount, 0);
    assert.equal(ledger.snapshot().stopped, true);
    await ledger.close();
  }
});

test('unrecognized files or malformed receipt bytes permanently block uncertain ownership', async () => {
  for (const file of ['unrecognized.json', 'reservation-000002.json']) {
    const f = await fixture(), ledger = await f.open();
    await ledger.reserve({ call: 1, reservedUpperBoundMicroUsd: 20 });
    await writeFile(join(f.created.directory, file), '{partial', { flag: 'wx', mode: 0o600 });
    await assert.rejects(ledger.reserve({ call: 2, reservedUpperBoundMicroUsd: 20 }), { code: 'BUDGET_LEDGER_UNCERTAIN' });
    assert.equal(ledger.snapshot().remainingMicroUsd, 0);
    assert.equal(ledger.snapshot().reservedUpperBoundMicroUsd, 5_000_000);
    assert.equal(ledger.snapshot().uncertain, true);
    await assert.rejects(ledger.close(), { code: 'BUDGET_LEDGER_UNCERTAIN' });
    assert.ok((await readdir(f.created.directory)).includes('owner.lock'));
    await assert.rejects(f.open({ runId: randomUUID() }), { code: 'BUDGET_LEDGER_BUSY' });
  }
});

test('directory or manifest permissions, symlinks and hard links are rejected', async () => {
  for (const variation of ['directory-mode', 'manifest-mode', 'symlink', 'hardlink']) {
    const f = await fixture(), path = join(f.created.directory, 'manifest.json');
    if (variation === 'directory-mode') await chmod(f.created.directory, 0o755);
    if (variation === 'manifest-mode') await chmod(path, 0o644);
    if (variation === 'symlink') {
      const target = join(f.temporaryRoot, 'synthetic-manifest.json');
      await writeFile(target, await readFile(path), { flag: 'wx', mode: 0o600 });
      await unlink(path); await symlink(target, path);
    }
    if (variation === 'hardlink') await link(path, join(f.temporaryRoot, 'synthetic-hardlink.json'));
    await assert.rejects(f.open());
  }
});

test('a changed ownership lock is never removed by the old owner', async () => {
  const f = await fixture(), ledger = await f.open(), lockPath = join(f.created.directory, 'owner.lock');
  const changed = Buffer.from(JSON.stringify({ another: 'synthetic owner' }));
  await writeFile(lockPath, changed);
  await assert.rejects(ledger.reserve({ call: 1, reservedUpperBoundMicroUsd: 1 }), { code: 'BUDGET_LEDGER_UNCERTAIN' });
  await assert.rejects(ledger.close(), { code: 'BUDGET_LEDGER_UNCERTAIN' });
  assert.deepEqual(await readFile(lockPath), changed);
});

test('removing a committed reservation cannot reduce the balance on a subsequent open', async () => {
  const f = await fixture(), ledger = await f.open();
  await ledger.reserve({ call: 1, reservedUpperBoundMicroUsd: 20 }); await ledger.close();
  await unlink(join(f.created.directory, 'reservation-000001.json'));
  await assert.rejects(f.open({ runId: randomUUID() }), { code: 'BUDGET_LEDGER_INVALID' });
});

test('a process exit without close remains blocked; removing its lock alone cannot recover it', async () => {
  const f = await fixture();
  const moduleUrl = new URL('./live-ai-budget-ledger.mjs', import.meta.url).href;
  const source = `import {openLiveAIBudgetLedger} from ${JSON.stringify(moduleUrl)}; const ledger=await openLiveAIBudgetLedger(${JSON.stringify(f.options)}); await ledger.reserve({call:1,reservedUpperBoundMicroUsd:30}); process.exit(0);`;
  await execute(process.execPath, ['--input-type=module', '-e', source], { timeout: 10_000, env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null' } });
  await assert.rejects(f.open({ runId: randomUUID() }), { code: 'BUDGET_LEDGER_BUSY' });
  const reservation = await readFile(join(f.created.directory, 'reservation-000001.json'));
  // This deletion is an intentional corruption of only this test's own fixture;
  // there is no corresponding recovery operation in the ledger API.
  await unlink(join(f.created.directory, 'owner.lock'));
  await assert.rejects(f.open({ runId: randomUUID() }), { code: 'BUDGET_LEDGER_UNCLOSED_RUN' });
  assert.deepEqual(await readFile(join(f.created.directory, 'reservation-000001.json')), reservation);
});
