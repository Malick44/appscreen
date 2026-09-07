import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { File } from 'node:buffer';
import { createBackupImport, validateBackupSelection, clearBackupImportStorage, MAX_BACKUP_BYTES } from '../backup-import.mjs';

const projectId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const workspaceId = '44444444-4444-4444-8444-444444444444';
const success = () => ({ project: { id: projectId }, revision: { id: revisionId } });
const file = (name = 'editable-project.zip', content = 'synthetic archive bytes') => new File([content], name, { type: 'application/zip' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function memoryStorage() {
  const values = new Map();
  return {
    values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}
function fixture(respond = async () => success(), options = {}) {
  let owner = 'user-1:workspace-1';
  const calls = [], updates = [], storage = options.storage || memoryStorage();
  const request = async (path, config) => {
    calls.push({ path, ...config });
    return respond(path, config);
  };
  const controller = createBackupImport(request, {
    scope: () => owner, target: { userId, workspaceId }, storage, crypto: webcrypto, onChange: value => updates.push(value), ...options,
  });
  return { controller, calls, updates, storage, request, setOwner: value => { owner = value; } };
}
const receipt = call => call.body.get('idempotencyKey');

test('backup selection accepts ZIP case variants, trims optional names, and validates only bounded files', () => {
  assert.equal(validateBackupSelection(file('BACKUP.ZIP'), '  Launch copy  '), 'Launch copy');
  assert.equal(validateBackupSelection({ name: 'backup.zip', size: MAX_BACKUP_BYTES }), '');
  for (const invalid of [undefined, file('backup.json'), file('screen.png'), file('backup.zip.exe')]) {
    assert.throws(() => validateBackupSelection(invalid), /editable-project ZIP/);
  }
  for (const size of [0, -1, 0.5, NaN, Infinity, MAX_BACKUP_BYTES + 1]) {
    assert.throws(() => validateBackupSelection({ name: 'backup.zip', size }), /100 MiB/);
  }
  assert.throws(() => validateBackupSelection(file(), 'x'.repeat(121)), /120 characters/);
  assert.throws(() => validateBackupSelection(file(), 5), /120 characters/);
});

test('import posts only multipart backup/name/receipt to the import endpoint without AI calls', async () => {
  const view = fixture(), original = file();
  const result = await view.controller.submit(original, '  My imported campaign  ');
  assert.equal(view.calls.length, 1);
  const call = view.calls[0];
  assert.equal(call.path, '/api/projects/import');
  assert.equal(call.method, 'POST');
  assert.equal(call.timeout, 120000);
  assert.ok(call.body instanceof FormData);
  assert.deepEqual([...call.body.keys()].sort(), ['expectedUserId', 'expectedWorkspaceId', 'file', 'idempotencyKey', 'name']);
  assert.equal(call.body.get('expectedUserId'), userId);
  assert.equal(call.body.get('expectedWorkspaceId'), workspaceId);
  assert.equal(call.body.get('name'), 'My imported campaign');
  assert.equal(call.body.get('file').name, original.name);
  assert.deepEqual(await call.body.get('file').arrayBuffer(), await original.arrayBuffer());
  assert.match(receipt(call), /^[a-f0-9-]{36}$/);
  assert.equal(result.phase, 'ready');
  assert.deepEqual(result.result, success());
  assert.match(result.message, /new campaign.*existing campaigns are unchanged.*No AI credits/);
  assert.deepEqual(view.updates.map(update => update.phase), ['checking', 'importing', 'ready']);
  assert.equal(view.storage.length, 0, 'confirmed receipt is removed');
});

test('blank name is omitted so server applies the imported-copy default', async () => {
  const view = fixture();
  await view.controller.submit(file(), '   ');
  assert.deepEqual([...view.calls[0].body.keys()].sort(), ['expectedUserId', 'expectedWorkspaceId', 'file', 'idempotencyKey']);
});

test('double submit is ignored while hashing and while uploading, and ready cannot be submitted again', async () => {
  const reading = deferred(), upload = deferred(), reachedRequest = deferred();
  const original = file();
  original.arrayBuffer = () => reading.promise;
  const view = fixture(() => { reachedRequest.resolve(); return upload.promise; });
  const pending = view.controller.submit(original, 'Original');
  assert.equal(view.controller.snapshot().phase, 'checking');
  assert.equal(view.controller.snapshot().pending, true);
  await view.controller.submit(file('different.zip'), 'Different');
  assert.equal(view.calls.length, 0);
  reading.resolve(new TextEncoder().encode('archive bytes').buffer);
  await reachedRequest.promise;
  assert.equal(view.controller.snapshot().phase, 'importing');
  await view.controller.submit(file('different.zip'), 'Different');
  assert.equal(view.calls.length, 1);
  upload.resolve(success());
  await pending;
  await view.controller.submit(file());
  assert.equal(view.calls.length, 1);
});

test('uncertain retry keeps immutable file, name, and key even if new selection is passed', async () => {
  let attempts = 0;
  const view = fixture(async () => { if (++attempts === 1) throw new Error('Lost connection'); return success(); });
  await view.controller.submit(file('original.zip', 'first bytes'), 'Original name');
  assert.equal(view.controller.snapshot().phase, 'retry');
  assert.equal(view.controller.snapshot().frozen, true);
  assert.equal(view.controller.snapshot().pending, false);
  assert.match(view.controller.snapshot().message, /same file and request.*close this dialog.*same file and name/);
  await view.controller.submit(file('changed.zip', 'different bytes'), 'Changed name');
  assert.equal(view.calls.length, 2);
  assert.equal(receipt(view.calls[0]), receipt(view.calls[1]));
  assert.equal(view.calls[1].body.get('name'), 'Original name');
  assert.equal(view.calls[1].body.get('file').name, 'original.zip');
  assert.equal(await view.calls[1].body.get('file').text(), 'first bytes');
});

test('reconstruction and reselection reuse the receipt for same owner, file bytes, and trimmed name', async () => {
  const storage = memoryStorage();
  const first = fixture(async () => { throw new Error('Response lost'); }, { storage });
  await first.controller.submit(file('original.zip', 'stable bytes'), '  Saved name  ');
  assert.equal(storage.length, 1);
  const second = fixture(async () => success(), { storage });
  await second.controller.submit(file('reselected.zip', 'stable bytes'), 'Saved name');
  assert.equal(receipt(first.calls[0]), receipt(second.calls[0]));
  assert.equal(storage.length, 0);
});

test('receipt contains only opaque hash/key and changes for different bytes, name, account, or workspace', async () => {
  const storage = memoryStorage(), keys = [];
  for (const [owner, content, name] of [
    ['user-a:workspace-a', 'PRIVATE_IMAGE_BYTES', 'PRIVATE_NAME'],
    ['user-a:workspace-a', 'different bytes', 'PRIVATE_NAME'],
    ['user-a:workspace-a', 'PRIVATE_IMAGE_BYTES', 'Other name'],
    ['user-b:workspace-a', 'PRIVATE_IMAGE_BYTES', 'PRIVATE_NAME'],
    ['user-a:workspace-b', 'PRIVATE_IMAGE_BYTES', 'PRIVATE_NAME'],
  ]) {
    const view = fixture(async () => { throw new Error('Lost response'); }, { storage, scope: () => owner });
    await view.controller.submit(file('PRIVATE_FILENAME.zip', content), name);
    keys.push(receipt(view.calls[0]));
  }
  assert.equal(new Set(keys).size, keys.length);
  assert.doesNotMatch(JSON.stringify([...storage.values]), /PRIVATE_|user-a|workspace-a/);
});

test('definitive invalid archive responses release the selection and permit a new receipt', async () => {
  for (const status of [400, 413, 415, 422]) {
    let attempts = 0;
    const view = fixture(async () => {
      if (++attempts === 1) throw Object.assign(new Error('Invalid backup archive'), { status });
      return success();
    });
    await view.controller.submit(file('invalid.zip'));
    assert.equal(view.controller.snapshot().phase, 'error');
    assert.equal(view.controller.snapshot().frozen, false);
    assert.equal(view.storage.length, 0);
    await view.controller.submit(file('valid.zip', 'new bytes'));
    assert.equal(view.controller.snapshot().phase, 'ready');
    assert.equal(view.calls[1].body.get('file').name, 'valid.zip');
    assert.notEqual(receipt(view.calls[0]), receipt(view.calls[1]));
  }
});

test('server errors and unconfirmed identity responses retain the receipt instead of claiming success', async () => {
  for (const response of [null, {}, { project: { id: '../unsafe' }, revision: { id: revisionId } }, { project: { id: projectId }, revision: { id: 'invalid' } }]) {
    const view = fixture(async () => response);
    const result = await view.controller.submit(file());
    assert.equal(result.phase, 'retry');
    assert.equal(result.result, null);
    assert.equal(result.frozen, true);
    assert.equal(view.storage.length, 1);
  }
  const view = fixture(async () => { throw Object.assign(new Error('Service unavailable'), { status: 503 }); });
  assert.equal((await view.controller.submit(file())).phase, 'retry');
  assert.equal(view.storage.length, 1);
});

test('changed account or workspace blocks before file reads or upload', async () => {
  for (const owner of ['user-2:workspace-1', 'user-1:workspace-2', null]) {
    const view = fixture();
    view.setOwner(owner);
    const result = await view.controller.submit(file());
    assert.equal(result.phase, 'blocked');
    assert.equal(result.pending, false);
    assert.equal(view.calls.length, 0);
    assert.equal(view.storage.length, 0);
  }
});

test('import target is captured immutably before a possible token refresh', async () => {
  const target = { userId, workspaceId };
  const view = fixture(undefined, { target });
  target.userId = 'changed-user';
  target.workspaceId = 'changed-workspace';
  await view.controller.submit(file());
  assert.equal(view.calls[0].body.get('expectedUserId'), userId);
  assert.equal(view.calls[0].body.get('expectedWorkspaceId'), workspaceId);
  for (const incomplete of [undefined, {}, { userId }, { workspaceId }]) {
    const blocked = fixture(undefined, { target: incomplete });
    assert.equal((await blocked.controller.submit(file())).phase, 'blocked');
    assert.equal(blocked.calls.length, 0);
  }
});

test('account changes during file inspection prevent uploading', async () => {
  const reading = deferred(), original = file(), view = fixture();
  original.arrayBuffer = () => reading.promise;
  const pending = view.controller.submit(original);
  view.setOwner('different:workspace');
  reading.resolve(new TextEncoder().encode('archive bytes').buffer);
  const result = await pending;
  assert.equal(result.pending, false);
  assert.match(result.message, /account or workspace changed.*No backup was uploaded/);
  assert.equal(view.calls.length, 0);
});

test('account changes during upload do not expose result in the new workspace and block another upload', async () => {
  const upload = deferred(), reachedRequest = deferred();
  const view = fixture(() => { reachedRequest.resolve(); return upload.promise; });
  const pending = view.controller.submit(file());
  await reachedRequest.promise;
  view.setOwner('different:workspace');
  upload.resolve(success());
  const result = await pending;
  assert.equal(result.phase, 'blocked');
  assert.equal(result.result, null);
  assert.match(result.message, /original workspace/);
  await view.controller.submit(file());
  assert.equal(view.calls.length, 1);
  assert.equal(view.storage.length, 1, 'old workspace receipt is retained for safe recovery');
});

test('unavailable receipt storage fails before sending any archive', async () => {
  for (const failAt of ['getItem', 'setItem']) {
    const storage = memoryStorage();
    storage[failAt] = () => { throw new Error('Storage is unavailable'); };
    const view = fixture(undefined, { storage });
    const result = await view.controller.submit(file());
    assert.equal(result.phase, 'error');
    assert.equal(result.frozen, false);
    assert.match(result.message, /retry receipt.*No backup was uploaded/);
    assert.equal(view.calls.length, 0);
  }
});

test('unsafe stored receipt is replaced and confirmed storage cleanup failure does not hide success', async () => {
  const storage = memoryStorage();
  storage.getItem = () => 'not-a-request-key';
  storage.removeItem = () => { throw new Error('Storage changed'); };
  const view = fixture(undefined, { storage });
  const result = await view.controller.submit(file());
  assert.equal(result.phase, 'ready');
  assert.match(receipt(view.calls[0]), /^[a-f0-9-]{36}$/);
});

test('invalid local selections never make requests or create receipts', async () => {
  const view = fixture();
  const result = await view.controller.submit(file('export.json'));
  assert.equal(result.phase, 'error');
  assert.equal(view.calls.length, 0);
  assert.equal(view.storage.length, 0);
});

test('explicit receipt cleanup removes only backup-import receipts and does not skip adjacent keys', () => {
  const storage = memoryStorage();
  storage.setItem('other', 'keep');
  storage.setItem('appscreen.backup-import.v1.first', 'one');
  storage.setItem('appscreen.backup-import.v1.second', 'two');
  storage.setItem('appscreen.dev.token', 'synthetic');
  clearBackupImportStorage(storage);
  assert.deepEqual([...storage.values], [['other', 'keep'], ['appscreen.dev.token', 'synthetic']]);
});
