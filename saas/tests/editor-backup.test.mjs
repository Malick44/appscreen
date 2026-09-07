import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual adapter, including saveCloud, without a user browser/DB.
const source = readFileSync(new URL('../editor-cloud.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');

function element() {
  const attributes = new Map();
  return {
    textContent: '', hidden: false, dataset: {}, children: [],
    get title() { return attributes.get('title') || ''; },
    set title(value) { attributes.set('title', value); },
    get disabled() { return attributes.has('disabled'); },
    set disabled(value) { if (value) attributes.set('disabled', ''); else attributes.delete('disabled'); },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    append(child) { this.children.push(child); child.remove = () => { this.children = this.children.filter(item => item !== child); }; },
    querySelector(selector) { return this.children.find(item => `.${item.className}` === selector) || null; },
  };
}

function fixture(respond) {
  const calls = [], navigations = [], listeners = new Map(), classes = new Set(['cloud-hosted-mode']);
  const button = element(), importButton = element(), bar = element(), status = element(), save = element(), retry = element();
  status.className = 'cloud-status';
  button.title = 'Export Project Backup';
  importButton.title = 'Import Project Backup';
  bar.append(status);
  const query = bar.querySelector.bind(bar);
  bar.querySelector = selector => ({ '#cloud-save': save, '#cloud-retry': retry })[selector] || query(selector);
  const view = { document: { id: 'project-1', revision: 1, scenes: [{ headline: 'Original title' }] }, attached: true };
  const bridge = {
    get currentDocument() { return view.attached ? { id: 'project-1' } : null; },
    getAssetReferences: () => [],
    exportDocument: () => structuredClone(view.document),
    acknowledgeSave: document => { view.document.revision = document.revision; },
  };
  const context = {
    crypto: globalThis.crypto, URL, URLSearchParams, FormData,
    location: { pathname: '/test', search: '', href: 'http://localhost/editor?project=project-1', assign: url => navigations.push(url) },
    history: { replaceState() {} },
    setTimeout: () => 1, clearTimeout() {},
    document: {
      body: { classList: { contains: name => classes.has(name) } },
      getElementById: id => id === 'export-project-btn' ? button : id === 'import-project-btn' ? importButton : null,
      createElement: () => element(),
      addEventListener: (type, callback, capture) => listeners.set(type, { callback, capture }),
    },
    api: async (path, options) => {
      calls.push({ path, ...structuredClone(options) });
      if (respond) {
        const result = await respond(path, options, view);
        if (result !== undefined) return result;
      }
      if (path.endsWith('/revisions')) return {
        revision: { id: `saved-${calls.length}`, document: { ...structuredClone(options.body.document), revision: view.document.revision + 1 } },
        project: { activeRevisionId: `saved-${calls.length}` },
      };
      return { job: { id: 'backup-1', state: 'queued' } };
    },
    fixtureBar: bar, fixtureBridge: bridge,
  };
  runInNewContext(`${source}
    bar = fixtureBar; bridge = fixtureBridge; projectId = 'project-1';
    currentRevisionId = 'revision-1'; projectName = 'Demo'; loaded = true; appliedMode = true;
    lastSavedFingerprint = backupFingerprint(bridge.exportDocument());
    globalThis.subject = {
      prepareCloudBackup, setCloudBackupControl, onDocumentChange,
      setCloudImportControl,
      saveCloud,
      state: () => ({ dirty, halted, saving, currentRevisionId, pendingBackup }),
      setSaving: value => { saving = value; },
      detach: () => { loaded = false; setCloudBackupControl(false); },
    };
  `, context);
  const subject = context.subject;
  subject.setCloudBackupControl(true);
  return { ...subject, calls, navigations, view, button, importButton, bar, status, save, retry, classes, listeners };
}

test('editor backup saves the latest snapshot even before change debounce, then requests portable format', async () => {
  const view = fixture();
  view.view.document.scenes[0].headline = 'Immediate edit';
  assert.equal(view.state().dirty, false);
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 2);
  assert.equal(view.calls[0].path, '/api/projects/project-1/revisions');
  assert.equal(view.calls[0].body.document.scenes[0].headline, 'Immediate edit');
  assert.equal(view.calls[0].body.expectedRevisionId, 'revision-1');
  assert.equal(view.calls[0].body.apply, true);
  assert.equal(view.calls[1].path, '/api/projects/project-1/export-jobs');
  assert.deepEqual(Object.keys(view.calls[1].body).sort(), ['format', 'idempotencyKey', 'revisionId']);
  assert.equal(view.calls[1].body.format, 'project');
  assert.equal(view.calls[1].body.revisionId, 'saved-1');
  assert.notEqual(view.calls[1].body.idempotencyKey, view.calls[0].body.idempotencyKey);
  const link = view.bar.querySelector('.cloud-backup-link');
  assert.equal(link.href, '/app/projects/project-1#revision-area');
  assert.equal(link.target, undefined, 'same-tab navigation retains development sign-in');
  assert.equal(typeof link.onclick, 'function');
  assert.match(view.status.textContent, /backup requested.*No AI credits used/);
  assert.doesNotMatch(view.status.textContent, /backup ready/i);
  assert.equal(view.button.disabled, false);
  assert.equal(view.button.getAttribute('aria-busy'), null);
  assert.equal(view.button.title, 'Prepare editable backup');
});

test('backup exposes busy state and ignores duplicate clicks while saving/queuing', async () => {
  let finish;
  const deferred = new Promise(resolve => { finish = resolve; });
  const view = fixture(async path => { if (path.endsWith('/revisions')) await deferred; });
  const pending = view.prepareCloudBackup();
  assert.equal(view.button.disabled, true);
  assert.equal(view.button.getAttribute('aria-busy'), 'true');
  assert.equal(view.button.getAttribute('aria-label'), 'Preparing editable backup…');
  await view.prepareCloudBackup();
  finish();
  await pending;
  assert.equal(view.calls.length, 2);
  assert.equal(view.button.disabled, false);
});

test('an existing save blocks backup without starting a competing save', async () => {
  const view = fixture();
  view.setSaving(true);
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 0);
  assert.match(view.status.textContent, /Wait for the current save/);
  assert.equal(view.status.dataset.status, 'error');
  assert.equal(view.button.disabled, false);
});

test('failed/conflicting saves never export an older revision or silently unpause saving', async () => {
  const view = fixture(async () => { throw Object.assign(new Error('Newer revision exists'), { code: 'REVISION_CONFLICT' }); });
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 1);
  assert.equal(view.state().halted, true);
  assert.equal(view.state().dirty, true);
  assert.equal(view.retry.hidden, false);
  assert.match(view.status.textContent, /Cloud conflict.*Reopen the campaign to compare/);
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 1);
  assert.match(view.status.textContent, /Resolve the cloud save/);
  assert.equal(view.button.disabled, false);
});

test('edits during save are detected even before their change event arrives', async () => {
  const view = fixture(async (path, options, editor) => {
    if (path.endsWith('/revisions')) editor.document.scenes[0].headline = 'New edit during save';
  });
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 1);
  assert.equal(view.view.document.scenes[0].headline, 'New edit during save');
  assert.match(view.status.textContent, /Finish saving your latest changes/);
  assert.equal(view.bar.querySelector('.cloud-backup-link'), null);
});

test('uncertain retries keep the identical revision/key and explain that later edits are excluded', async () => {
  let attempts = 0;
  const view = fixture(async path => {
    if (path.endsWith('/export-jobs') && ++attempts === 1) throw new Error('Connection interrupted.');
  });
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 2);
  assert.equal(view.button.title, 'Retry editable backup (same saved snapshot)');
  assert.match(view.status.textContent, /Retry editable backup.*later edits are not included/);
  assert.equal(view.button.disabled, false);
  view.view.document.scenes[0].headline = 'A later edit';
  view.onDocumentChange();
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 3, 'retry must not create a second revision');
  assert.deepEqual(view.calls[2], view.calls[1]);
  assert.equal(view.view.document.scenes[0].headline, 'A later edit');
  assert.equal(view.state().dirty, true);
  assert.match(view.status.textContent, /earlier saved snapshot.*Later edits remain here/);
  assert.equal(view.button.title, 'Prepare editable backup');
  assert.equal(view.state().pendingBackup, null);
});

test('edits during job admission remain in the editor and get accurate snapshot feedback', async () => {
  const view = fixture(async (path, options, editor) => {
    if (path.endsWith('/export-jobs')) editor.document.scenes[0].headline = 'Not in the backup';
  });
  await view.prepareCloudBackup();
  assert.match(view.status.textContent, /earlier saved snapshot/);
  assert.equal(view.view.document.scenes[0].headline, 'Not in the backup');
});

test('backup progress navigation waits for immediate edits and allows the latest acknowledged save', async () => {
  const view = fixture();
  await view.prepareCloudBackup();
  const link = view.bar.querySelector('.cloud-backup-link');
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  link.onclick(event);
  assert.equal(prevented, 0, 'a saved design can leave the editor');
  view.view.document.scenes[0].headline = 'Immediate later edit';
  assert.equal(view.state().dirty, false);
  link.onclick(event);
  assert.equal(prevented, 1, 'debounce must not allow unsaved changes to be lost');
  assert.match(view.status.textContent, /Save your latest changes.*editor is still open/);
  await view.saveCloud(true);
  link.onclick(event);
  assert.equal(prevented, 1, 'saving later edits unblocks navigation even though the backup is older');
  view.setSaving(true);
  link.onclick(event);
  assert.equal(prevented, 2);
});

test('detaching during a save prevents job admission and restores the standalone backup control', async () => {
  const view = fixture(async path => {
    if (path.endsWith('/revisions')) { view.view.attached = false; view.detach(); }
  });
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 1);
  assert.equal(view.button.title, 'Export Project Backup');
  assert.equal(view.button.getAttribute('aria-label'), null);
  assert.equal(view.button.getAttribute('aria-busy'), null);
  assert.equal(view.button.disabled, false);
  assert.equal(view.bar.querySelector('.cloud-backup-link'), null);
});

test('detaching during job admission cannot add cloud feedback to the selected local project', async () => {
  const view = fixture(async path => {
    if (path.endsWith('/export-jobs')) {
      view.view.attached = false; view.detach();
      view.status.textContent = 'Local project selected';
    }
  });
  await view.prepareCloudBackup();
  assert.equal(view.status.textContent, 'Local project selected');
  assert.equal(view.bar.querySelector('.cloud-backup-link'), null);
  assert.equal(view.button.title, 'Export Project Backup');
});

test('a failed save after detaching cannot dirty the local project or expose stale recovery controls', async () => {
  const view = fixture(async path => {
    if (path.endsWith('/revisions')) {
      view.view.attached = false; view.detach();
      view.status.textContent = 'Local project selected';
      view.retry.hidden = true;
      throw new Error('Old cloud request failed');
    }
  });
  await view.prepareCloudBackup();
  assert.equal(view.calls.length, 1);
  assert.equal(view.status.textContent, 'Local project selected');
  assert.equal(view.state().dirty, false);
  assert.equal(view.retry.hidden, true);
  assert.equal(view.button.title, 'Export Project Backup');
  assert.equal(view.bar.querySelector('.cloud-backup-link'), null);
});

test('capture handler replaces only the hosted backup, leaving the standalone handler untouched', async () => {
  const view = fixture();
  const listener = view.listeners.get('click');
  assert.equal(listener.capture, true);
  let prevented = 0, stopped = 0;
  const event = {
    target: { closest: selector => selector === '#export-project-btn' ? view.button : null },
    preventDefault: () => { prevented++; },
    stopImmediatePropagation: () => { stopped++; },
  };
  view.classes.delete('cloud-hosted-mode');
  listener.callback(event);
  assert.equal(prevented, 0);
  assert.equal(stopped, 0);
  assert.equal(view.calls.length, 0);
  view.classes.add('cloud-hosted-mode');
  view.setSaving(true); // Predictable immediate completion of the hosted handler.
  listener.callback(event);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.match(view.status.textContent, /Wait for the current save/);
});

test('cloud import opens the new-campaign flow only after edits are saved, preserving local JSON import', () => {
  const view = fixture();
  view.setCloudImportControl(true);
  assert.equal(view.importButton.title, 'Import editable backup as a new campaign');
  assert.equal(view.importButton.getAttribute('aria-label'), view.importButton.title);
  let prevented = 0, stopped = 0;
  const event = {
    target: { closest: selector => selector === '#import-project-btn' ? view.importButton : null },
    preventDefault: () => { prevented++; }, stopImmediatePropagation: () => { stopped++; },
  };
  view.listeners.get('click').callback(event);
  assert.deepEqual(view.navigations, ['/app#import-backup']);
  assert.equal(stopped, 1);
  view.view.document.scenes[0].headline = 'Unsaved before debounce';
  view.listeners.get('click').callback(event);
  assert.equal(view.navigations.length, 1);
  assert.match(view.status.textContent, /before opening backup import/);
  view.setCloudImportControl(false);
  assert.equal(view.importButton.title, 'Import Project Backup');
  assert.equal(view.importButton.getAttribute('aria-label'), null);
  view.classes.delete('cloud-hosted-mode');
  const prior = prevented;
  view.listeners.get('click').callback(event);
  assert.equal(prevented, prior, 'the legacy file picker must remain available outside cloud mode');
});
