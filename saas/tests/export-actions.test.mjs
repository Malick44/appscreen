import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { escapeHTML, revisionId, jobRevisionId } from '../utils.mjs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing frontend function: ${startMarker}`);
  return source.slice(start, end);
}
const actions = [
  extract('function button(', '\nfunction notice('),
  extract('function busy(', '\nfunction operationKey('),
  extract('function operationKey(', '\nfunction publicHeader('),
  extract('function revisionMarkup(', '\nfunction historyMarkup('),
  extract('async function handleAction(', '\ndocument.addEventListener("click"'),
].join('\n');

function fixture(respond = async () => ({ job: { id: 'export-job', state: 'queued' } })) {
  const calls = [], messages = [];
  const context = {
    crypto: globalThis.crypto,
    state: {
      operationKeys: new Map(), config: { aiEnabled: false },
      project: { project: { id: 'project-1', activeRevisionId: 'revision-1' }, revision: { id: 'revision-1', document: { scenes: [] } }, jobs: [] },
    },
    api: async (path, options) => {
      calls.push({ path, ...JSON.parse(JSON.stringify(options)) });
      return respond(path, options);
    },
    toast: (message, error = false) => messages.push({ message, error }),
    updateJobSections: () => { context.updates += 1; },
    startPolling: () => { context.polls += 1; },
    updates: 0, polls: 0,
    e: escapeHTML, revisionId, jobRevisionId,
    icon: () => '', getPreviews: () => [], campaignPreviews: () => '',
    currentJob: () => context.state.project.jobs[0], artifactMarkup: () => '', creditQuote: () => '',
  };
  runInNewContext(`${actions}\nglobalThis.testActions = { handleAction, revisionMarkup };`, context);
  const button = (action = 'export-backup') => ({
    dataset: { action, id: 'revision-1' }, innerHTML: action === 'export-backup' ? 'Prepare editable backup' : 'Prepare downloads',
    disabled: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  });
  return { context, calls, messages, button, ...context.testActions };
}

test('editable backup stays secondary and explains its contents without replacing PNG downloads', () => {
  const { revisionMarkup } = fixture();
  const markup = revisionMarkup();
  assert.match(markup, /data-action="export"[^>]*>Prepare downloads<\/button>/);
  assert.match(markup, /class="button quiet [^"]*" data-action="export-backup"[^>]*>Prepare editable backup<\/button>/);
  assert.match(markup, /Downloads contain PNG screens/);
  assert.match(markup, /editable backup contains your design and original screenshots/);
  assert.match(markup, /Neither uses AI or AI credits/);
});

test('backup sends project format, exposes busy feedback, and follows the existing export-job flow', async () => {
  let complete;
  const result = new Promise(resolve => { complete = resolve; });
  const view = fixture(() => result);
  const element = view.button();
  const pending = view.handleAction(element);
  assert.equal(element.disabled, true);
  assert.equal(element.attributes['aria-busy'], 'true');
  assert.equal(element.textContent, 'Preparing editable backup…');
  assert.equal(view.calls[0].path, '/api/projects/project-1/export-jobs');
  assert.equal(view.calls[0].method, 'POST');
  assert.equal(view.calls[0].body.revisionId, 'revision-1');
  assert.equal(view.calls[0].body.format, 'project');
  assert.ok(view.calls[0].body.idempotencyKey);
  complete({ job: { id: 'backup-job', state: 'queued' } });
  await pending;
  assert.equal(view.context.state.project.jobs[0].id, 'backup-job');
  assert.equal(view.context.updates, 1);
  assert.equal(view.context.polls, 1);
  assert.equal(element.disabled, false);
  assert.equal(element.attributes['aria-busy'], undefined);
  assert.equal(element.innerHTML, 'Prepare editable backup');
  assert.match(view.messages[0].message, /Preparing editable backup.*No AI calls or AI credits/);
});

test('backup retries reuse their request identity without colliding with the existing PNG action', async () => {
  let attempt = 0;
  const view = fixture(async () => {
    if (++attempt === 1) throw new Error('Connection interrupted.');
    return { job: { id: `job-${attempt}`, state: 'queued' } };
  });
  const element = view.button();
  await view.handleAction(element);
  assert.equal(element.disabled, false);
  assert.equal(element.innerHTML, 'Prepare editable backup');
  assert.equal(view.context.state.project.jobs.length, 0);
  assert.equal(view.messages[0].error, true);
  assert.match(view.messages[0].message, /Try Prepare editable backup again/);
  await view.handleAction(element);
  await view.handleAction(view.button('export'));
  assert.equal(view.calls[0].body.idempotencyKey, view.calls[1].body.idempotencyKey);
  assert.notEqual(view.calls[1].body.idempotencyKey, view.calls[2].body.idempotencyKey);
  assert.deepEqual(Object.keys(view.calls[2].body).sort(), ['idempotencyKey', 'revisionId']);
  assert.equal(view.calls[2].body.revisionId, 'revision-1');
});
