/** Local, single-host synthetic-test allowance only. Not production accounting,
 * a distributed lock, an invoice guarantee, or permission to call any provider.
 * Every caller must pin the returned directory + manifest hash in fresh approval.
 * Never create another ledger to bypass an exhausted or uncertain one.
 * This assumes the approved local user does not delete/roll back ledger files;
 * private files and hash chains are not protection against that same user's
 * deliberate filesystem rollback. Keep the directory and its receipts intact.
 *
 * All reservations (including prior reports and uncertain requests) are retained.
 * The only removable file is this process's ownership lock after durable close.
 * A crash, partial write, ownership change or storage ambiguity leaves the ledger
 * blocked; there is deliberately no automatic stale-lock recovery API.
 *
 * Reserve-before-dispatch guidance:
 * https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api
 */
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_LIVE_AI_TEST_BUDGET_MICRO_USD = 5_000_000;
const MAX_RUNS = 32, MAX_RESERVATIONS = 256, MAX_FILE_BYTES = 16_384;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export class LiveAIBudgetError extends Error {
  constructor(code) { super(code); this.name = 'LiveAIBudgetError'; this.code = code; }
}
const check = (condition, code = 'BUDGET_LEDGER_INVALID') => { if (!condition) throw new LiveAIBudgetError(code); };
const keys = (value, expected) => check(plain(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
const integer = (value, min, max) => check(Number.isSafeInteger(value) && value >= min && value <= max);
const timestamp = value => check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const now = () => new Date().toISOString();
const snapshotClone = value => structuredClone(value);
const reservationName = sequence => `reservation-${String(sequence).padStart(6, '0')}.json`;

function privateStat(stat, directory = false) {
  check(directory ? stat.isDirectory() : stat.isFile(), 'BUDGET_LEDGER_PATH_UNSAFE');
  check(stat.uid === process.getuid() && (stat.mode & 0o777) === (directory ? 0o700 : 0o600), 'BUDGET_LEDGER_PATH_UNSAFE');
  if (!directory) check(stat.nlink === 1, 'BUDGET_LEDGER_PATH_UNSAFE');
}
async function checkedDirectory(directory, temporaryRoot) {
  check(typeof directory === 'string' && isAbsolute(directory) && resolve(directory) === directory, 'BUDGET_LEDGER_PATH_UNSAFE');
  const parent = await realpath(temporaryRoot);
  check(dirname(directory) === parent && /^appscreen-live-ai-budget-[A-Za-z0-9]{6}$/.test(basename(directory)), 'BUDGET_LEDGER_PATH_UNSAFE');
  const stat = await lstat(directory);
  check(!stat.isSymbolicLink() && await realpath(directory) === directory, 'BUDGET_LEDGER_PATH_UNSAFE');
  privateStat(stat, true);
  return { directory, dev: stat.dev, ino: stat.ino };
}
async function unchangedDirectory(identity) {
  const stat = await lstat(identity.directory);
  privateStat(stat, true);
  check(!stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino && await realpath(identity.directory) === identity.directory, 'BUDGET_LEDGER_PATH_UNSAFE');
}
async function syncDirectory(directory, requirePrivate = true) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); check(stat.isDirectory()); if (requirePrivate) privateStat(stat, true); await handle.sync(); }
  finally { await handle.close(); }
}
async function readJSON(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); privateStat(stat);
    check(stat.size > 0 && stat.size <= MAX_FILE_BYTES);
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    check(bytesRead === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'BUDGET_LEDGER_CHANGED');
    const bytes = buffer.subarray(0, bytesRead);
    let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new LiveAIBudgetError('BUDGET_LEDGER_INVALID'); }
    return { data, sha256: sha256(bytes), dev: stat.dev, ino: stat.ino };
  } finally { await handle.close(); }
}
async function writeNew(directory, name, data) {
  const bytes = Buffer.from(JSON.stringify(data) + '\n');
  check(bytes.length <= MAX_FILE_BYTES);
  const handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { privateStat(await handle.stat()); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(directory);
  return sha256(bytes);
}
function validateManifest(value) {
  keys(value, ['kind', 'version', 'budgetId', 'scope', 'budgetMicroUsd', 'createdAt', 'seedReservations']);
  check(value.kind === 'appscreen-live-ai-budget-ledger' && value.version === 1 && value.scope === 'local-synthetic-tests-only' && uuid(value.budgetId));
  integer(value.budgetMicroUsd, 1, MAX_LIVE_AI_TEST_BUDGET_MICRO_USD); timestamp(value.createdAt);
  check(Array.isArray(value.seedReservations) && value.seedReservations.length > 0 && value.seedReservations.length <= MAX_RUNS);
  const seen = new Set(); let total = 0;
  for (const seed of value.seedReservations) {
    keys(seed, ['runId', 'reportSha256', 'reservedUpperBoundMicroUsd']);
    check(uuid(seed.runId) && hash(seed.reportSha256) && !seen.has(seed.runId)); seen.add(seed.runId);
    integer(seed.reservedUpperBoundMicroUsd, 1, value.budgetMicroUsd); total += seed.reservedUpperBoundMicroUsd;
  }
  check(total <= value.budgetMicroUsd);
  return total;
}
async function readState(identity, expectedBudgetId, expectedManifestSha256, activeRunId = null) {
  await unchangedDirectory(identity);
  const manifestFile = await readJSON(join(identity.directory, 'manifest.json'));
  const manifest = manifestFile.data, seeded = validateManifest(manifest);
  check(manifest.budgetId === expectedBudgetId && manifestFile.sha256 === expectedManifestSha256, 'BUDGET_LEDGER_APPROVAL_MISMATCH');
  const names = (await readdir(identity.directory)).sort();
  check(names.length <= 2 + MAX_RUNS * 2 + MAX_RESERVATIONS, 'BUDGET_LEDGER_LIMIT');
  const files = new Map(), runs = new Map(), closed = new Map(), reservations = [];
  for (const name of names) {
    if (name === 'manifest.json' || name === 'owner.lock') continue;
    const match = name.match(/^(run|closed)-([a-f0-9-]{36})\.json$/);
    check(match || /^reservation-\d{6}\.json$/.test(name), 'BUDGET_LEDGER_UNEXPECTED_FILE');
    const record = await readJSON(join(identity.directory, name)); files.set(name, record.sha256);
    const value = record.data;
    if (match) {
      check(uuid(match[2]) && value.runId === match[2] && value.budgetId === manifest.budgetId && value.version === 1);
      if (match[1] === 'run') {
        keys(value, ['kind', 'version', 'budgetId', 'runId', 'approvalSha256', 'startedAt', 'startSequence', 'startHeadSha256']);
        check(value.kind === 'run' && hash(value.approvalSha256) && hash(value.startHeadSha256)); timestamp(value.startedAt); integer(value.startSequence, 0, MAX_RESERVATIONS);
        check(!manifest.seedReservations.some(seed => seed.runId === value.runId), 'BUDGET_LEDGER_RUN_REUSED');
        runs.set(value.runId, value);
      } else {
        keys(value, ['kind', 'version', 'budgetId', 'runId', 'closedAt', 'lastSequence', 'headSha256', 'reservationCount', 'reservedUpperBoundMicroUsd']);
        check(value.kind === 'closed' && hash(value.headSha256)); timestamp(value.closedAt);
        integer(value.lastSequence, 0, MAX_RESERVATIONS); integer(value.reservationCount, 0, 20); integer(value.reservedUpperBoundMicroUsd, 0, manifest.budgetMicroUsd);
        closed.set(value.runId, value);
      }
    } else reservations.push({ name, ...record });
  }
  check(runs.size <= MAX_RUNS && reservations.length <= MAX_RESERVATIONS, 'BUDGET_LEDGER_LIMIT');
  const heads = [manifestFile.sha256], totals = [seeded], counts = new Map();
  for (const [index, record] of reservations.entries()) {
    const entry = record.data, sequence = index + 1;
    keys(entry, ['kind', 'version', 'budgetId', 'sequence', 'runId', 'call', 'reservedUpperBoundMicroUsd', 'previousSha256', 'createdAt']);
    check(record.name === reservationName(sequence) && entry.kind === 'reservation' && entry.version === 1 && entry.budgetId === manifest.budgetId && entry.sequence === sequence);
    check(runs.has(entry.runId) && entry.previousSha256 === heads[index]); timestamp(entry.createdAt);
    integer(entry.reservedUpperBoundMicroUsd, 1, manifest.budgetMicroUsd);
    const count = (counts.get(entry.runId) || 0) + 1; integer(entry.call, 1, 20); check(entry.call === count);
    counts.set(entry.runId, count); heads.push(record.sha256); totals.push(totals[index] + entry.reservedUpperBoundMicroUsd);
    check(totals.at(-1) <= manifest.budgetMicroUsd, 'BUDGET_LEDGER_EXCEEDED');
  }
  for (const [runId, run] of runs) {
    check(run.startSequence < heads.length && run.startHeadSha256 === heads[run.startSequence]);
    const own = reservations.filter(record => record.data.runId === runId), end = run.startSequence + own.length;
    check(own.every((record, index) => record.data.sequence === run.startSequence + index + 1));
    const receipt = closed.get(runId);
    if (runId === activeRunId) check(!receipt, 'BUDGET_LEDGER_RUN_REUSED');
    else {
      check(receipt, 'BUDGET_LEDGER_UNCLOSED_RUN');
      check(receipt.lastSequence === end && receipt.headSha256 === heads[end] && receipt.reservationCount === own.length && receipt.reservedUpperBoundMicroUsd === totals[end]);
    }
  }
  check([...closed.keys()].every(id => runs.has(id)));
  const reserved = totals.at(-1);
  return {
    manifest, files, reservations, runs, seeded,
    fingerprint: sha256(JSON.stringify([manifestFile.sha256, [...files]])),
    headSha256: heads.at(-1),
    snapshot: { directory: identity.directory, budgetId: manifest.budgetId, manifestSha256: manifestFile.sha256, budgetMicroUsd: manifest.budgetMicroUsd, seededReservedUpperBoundMicroUsd: seeded, reservedUpperBoundMicroUsd: reserved, remainingMicroUsd: manifest.budgetMicroUsd - reserved, reservationCount: reservations.length, runCount: runs.size },
  };
}

/** Creates a NEW private directory only. Initialization never rewrites an old
 * ledger or reads the prior report; its exact reviewed hash/hold are supplied.
 * @param {{ temporaryRoot?: string, budgetMicroUsd: number, seedReservations: Array<{runId:string, reportSha256:string, reservedUpperBoundMicroUsd:number}> }} options
 */
export async function createLiveAIBudgetLedger({ temporaryRoot = tmpdir(), budgetMicroUsd, seedReservations } = {}) {
  const manifest = { kind: 'appscreen-live-ai-budget-ledger', version: 1, budgetId: randomUUID(), scope: 'local-synthetic-tests-only', budgetMicroUsd, createdAt: now(), seedReservations: snapshotClone(seedReservations) };
  validateManifest(manifest);
  const parent = await realpath(temporaryRoot), directory = await mkdtemp(join(parent, 'appscreen-live-ai-budget-'));
  const identity = await checkedDirectory(directory, parent);
  const manifestSha256 = await writeNew(directory, 'manifest.json', manifest);
  await syncDirectory(parent, false);
  const state = await readState(identity, manifest.budgetId, manifestSha256);
  return { directory, ...state.snapshot };
}

/** Fresh approval must pin directory + budgetId + manifest hash and this runId.
 * Call reserve only once per one-based model call, immediately before dispatch.
 * A duplicate is an error, never permission to resend an earlier reservation.
 * Call close only when no provider operation can still start. It awaits queued
 * reservations and retains every receipt; uncertain I/O keeps owner.lock.
 * @param {{ directory:string, temporaryRoot?:string, expectedBudgetId:string, expectedManifestSha256:string, runId:string, approvalSha256:string }} options
 */
export async function openLiveAIBudgetLedger({ directory, temporaryRoot = tmpdir(), expectedBudgetId, expectedManifestSha256, runId, approvalSha256 } = {}) {
  check(uuid(expectedBudgetId) && uuid(runId) && hash(expectedManifestSha256) && hash(approvalSha256), 'BUDGET_LEDGER_APPROVAL_MISMATCH');
  const identity = await checkedDirectory(directory, temporaryRoot), lockPath = join(directory, 'owner.lock');
  try { await lstat(lockPath); throw new LiveAIBudgetError('BUDGET_LEDGER_BUSY'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const initial = await readState(identity, expectedBudgetId, expectedManifestSha256);
  check(!initial.runs.has(runId) && !initial.manifest.seedReservations.some(seed => seed.runId === runId), 'BUDGET_LEDGER_RUN_REUSED');
  check(initial.runs.size < MAX_RUNS, 'BUDGET_LEDGER_LIMIT');
  const owner = { version: 1, budgetId: expectedBudgetId, runId, ownerId: randomUUID(), pid: process.pid, startedAt: now() };
  try { await writeNew(directory, 'owner.lock', owner); }
  catch (error) { if (error.code === 'EEXIST') throw new LiveAIBudgetError('BUDGET_LEDGER_BUSY'); throw error; }
  // From here onward, unexpected failure deliberately leaves the ownership lock.
  let state = await readState(identity, expectedBudgetId, expectedManifestSha256);
  check(state.fingerprint === initial.fingerprint, 'BUDGET_LEDGER_CHANGED');
  await writeNew(directory, `run-${runId}.json`, { kind: 'run', version: 1, budgetId: expectedBudgetId, runId, approvalSha256, startedAt: now(), startSequence: state.reservations.length, startHeadSha256: state.headSha256 });
  state = await readState(identity, expectedBudgetId, expectedManifestSha256, runId);
  const lockIdentity = await readJSON(lockPath);
  check(JSON.stringify(lockIdentity.data) === JSON.stringify(owner), 'BUDGET_LEDGER_OWNERSHIP_LOST');
  let tail = Promise.resolve(), stopped = false, uncertain = false, closing = false, closed = false;
  const serial = operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; };
  const assertOwned = async () => {
    await unchangedDirectory(identity);
    const lock = await readJSON(lockPath);
    check(lock.ino === lockIdentity.ino && lock.dev === lockIdentity.dev && lock.sha256 === lockIdentity.sha256, 'BUDGET_LEDGER_OWNERSHIP_LOST');
    const current = await readState(identity, expectedBudgetId, expectedManifestSha256, runId);
    check(current.fingerprint === state.fingerprint, 'BUDGET_LEDGER_CHANGED');
  };
  const failUncertain = () => { uncertain = true; stopped = true; return new LiveAIBudgetError('BUDGET_LEDGER_UNCERTAIN'); };
  return {
    // An ambiguous write might exist durably even if rereading it failed. Never
    // report stale cached "remaining" money as available after that uncertainty.
    snapshot: () => ({ ...snapshotClone(state.snapshot), ...(uncertain ? { reservedUpperBoundMicroUsd: state.manifest.budgetMicroUsd, remainingMicroUsd: 0 } : {}), runId, stopped, uncertain, closed }),
    reserve(details) {
      // Copy primitive values synchronously, before awaiting another reservation.
      const call = details?.call, amount = details?.reservedUpperBoundMicroUsd;
      if (closing || closed || stopped) return Promise.reject(new LiveAIBudgetError('BUDGET_LEDGER_STOPPED'));
      return serial(async () => {
        check(!stopped && !closed, 'BUDGET_LEDGER_STOPPED');
        try {
          integer(call, 1, 20); integer(amount, 1, state.manifest.budgetMicroUsd);
          const priorCalls = state.reservations.filter(record => record.data.runId === runId).length;
          check(call === priorCalls + 1, 'BUDGET_LEDGER_CALL_REUSED');
          check(state.reservations.length < MAX_RESERVATIONS, 'BUDGET_LEDGER_LIMIT');
          check(state.snapshot.reservedUpperBoundMicroUsd + amount <= state.manifest.budgetMicroUsd, 'BUDGET_LEDGER_EXCEEDED');
        } catch (error) { stopped = true; throw error; }
        try {
          await assertOwned();
          const entry = { kind: 'reservation', version: 1, budgetId: expectedBudgetId, sequence: state.reservations.length + 1, runId, call, reservedUpperBoundMicroUsd: amount, previousSha256: state.headSha256, createdAt: now() };
          await writeNew(directory, reservationName(entry.sequence), entry);
          state = await readState(identity, expectedBudgetId, expectedManifestSha256, runId);
          return snapshotClone(state.snapshot);
        } catch { throw failUncertain(); }
      });
    },
    close() {
      if (closed) return Promise.resolve(snapshotClone(state.snapshot));
      if (closing) return Promise.reject(new LiveAIBudgetError('BUDGET_LEDGER_STOPPED'));
      closing = true;
      return serial(async () => {
        check(!uncertain, 'BUDGET_LEDGER_UNCERTAIN');
        try {
          await assertOwned();
          await writeNew(directory, `closed-${runId}.json`, { kind: 'closed', version: 1, budgetId: expectedBudgetId, runId, closedAt: now(), lastSequence: state.reservations.length, headSha256: state.headSha256, reservationCount: state.reservations.filter(record => record.data.runId === runId).length, reservedUpperBoundMicroUsd: state.snapshot.reservedUpperBoundMicroUsd });
          await unchangedDirectory(identity);
          const lock = await readJSON(lockPath);
          check(lock.ino === lockIdentity.ino && lock.dev === lockIdentity.dev && lock.sha256 === lockIdentity.sha256, 'BUDGET_LEDGER_OWNERSHIP_LOST');
          await unlink(lockPath);
          await syncDirectory(directory);
          closed = true;
          return snapshotClone(state.snapshot);
        } catch { throw failUncertain(); }
      });
    },
  };
}
