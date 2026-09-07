export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const RECEIPT_PREFIX = 'appscreen.backup-import.v1.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateBackupSelection(file, name = '') {
  if (!file || !/\.zip$/i.test(file.name || ''))
    throw new Error('Choose an AppScreen editable-project ZIP. PNG exports and old JSON backups cannot be imported here.');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BACKUP_BYTES)
    throw new Error('Choose an editable backup of 100 MiB or smaller. Empty files cannot be imported.');
  if (typeof name !== 'string' || name.trim().length > 120)
    throw new Error('Use a campaign name of 120 characters or fewer.');
  return name.trim();
}

export function clearBackupImportStorage(storage) {
  // Explicit local cleanup only. Normal sign-out keeps opaque pending receipts
  // so signing back in after an uncertain response cannot duplicate an import.
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(RECEIPT_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export function createBackupImport(request, {
  scope, target, storage, onChange = () => {}, crypto = globalThis.crypto,
} = {}) {
  const owner = scope();
  const expectedUserId = target?.userId;
  const expectedWorkspaceId = target?.workspaceId;
  let phase = 'idle', message = '', intent = null, result = null;
  const snapshot = () => ({
    phase, message, frozen: !!intent, pending: ['checking', 'importing'].includes(phase),
    fileName: intent?.file.name || '', copyName: intent?.name || '', result,
  });
  const publish = () => { const value = snapshot(); onChange(value); return value; };
  const stillOwner = () => owner && expectedUserId && expectedWorkspaceId && scope() === owner;
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    snapshot,
    async submit(file, name = '') {
      if (snapshot().pending || phase === 'ready') return snapshot();
      if (!stillOwner()) {
        phase = 'blocked'; message = 'Your account or workspace changed. Close this dialog and reopen import.';
        return publish();
      }
      try {
        if (!intent) {
          name = validateBackupSelection(file, name);
          phase = 'checking'; message = 'Checking the selected file…'; publish();
          const hash = await digest(await file.arrayBuffer());
          const receiptId = RECEIPT_PREFIX + await digest(new TextEncoder().encode(JSON.stringify({ owner, hash, name })));
          if (!stillOwner()) throw new Error('Your account or workspace changed. No backup was uploaded.');
          let key;
          try {
            const previous = storage.getItem(receiptId);
            key = previous && UUID.test(previous) ? previous : crypto.randomUUID();
            // Persist before transmission. Reselecting the same file/name after
            // an interrupted request reuses its receipt without storing images.
            storage.setItem(receiptId, key);
          } catch {
            throw new Error('Your browser could not keep a retry receipt. No backup was uploaded. Allow session storage and try again.');
          }
          intent = { file, name, key, receiptId };
        }
        phase = 'importing'; message = 'Importing a new campaign and checking its original screenshots…'; publish();
        const body = new FormData();
        body.append('expectedUserId', expectedUserId);
        body.append('expectedWorkspaceId', expectedWorkspaceId);
        body.append('idempotencyKey', intent.key);
        if (intent.name) body.append('name', intent.name);
        body.append('file', intent.file, intent.file.name);
        const response = await request('/api/projects/import', { method: 'POST', body, timeout: 120000 });
        if (!stillOwner()) {
          phase = 'blocked'; message = 'Your account or workspace changed. Check the original workspace for the import result.';
          return publish();
        }
        if (!UUID.test(response?.project?.id || '') || !UUID.test(response?.revision?.id || ''))
          throw new Error('The server did not confirm an imported campaign.');
        result = response;
        phase = 'ready'; message = 'Imported as a new campaign. Your existing campaigns are unchanged. No AI credits used.';
        try { storage.removeItem(intent.receiptId); } catch { /* The confirmed receipt remains safe to replay. */ }
      } catch (error) {
        if (intent && [400, 413, 415, 422].includes(error.status)) {
          // Definitive validation rejection: nothing was admitted. Let the user
          // choose a valid archive; only uncertain outcomes need a frozen retry.
          try { storage.removeItem(intent.receiptId); } catch { /* Harmless rejected receipt. */ }
          intent = null;
        }
        phase = intent ? 'retry' : 'error';
        message = intent
          ? `${error.message} Retry checks the same file and request, without creating a second copy. If you close this dialog, reselect the same file and name in this tab to retry.`
          : error.message;
      }
      return publish();
    },
  };
}
