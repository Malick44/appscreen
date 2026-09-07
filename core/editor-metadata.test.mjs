import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createCampaign, toLegacyState, fromLegacyState, resolveDevice, assertDocumentEditAllowed } from './campaign.mjs';

// Run the real legacy-editor normalization path, without loading its DOM or renderer.
const editorSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const metadataHelpers = [
  'devicePlacementsFormSeam', 'ensureDeviceEditorNames', 'ensureDeviceMetadata',
  'isCurrentScreenshotDevice', 'getDeviceSourceIndex',
].map(name => {
  const start = editorSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing editor helper: ${name}`);
  const end = editorSource.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1, `Missing end of editor helper: ${name}`);
  return editorSource.slice(start, end);
}).join('\n');

function normalizeMetadata(state) {
  runInNewContext(`${metadataHelpers}\nensureDeviceMetadata();`, {
    state, crypto: globalThis.crypto, normalizeDeviceRenderingModes() {},
  });
}

async function fixture(count = 5) {
  const before = createCampaign({
    templateId: 'tidal-relay', templateMode: 'exact', screenCount: count,
    assets: Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, width: 1179, height: 2556 })),
  });
  const legacy = await toLegacyState(before);
  const exportDocument = () => fromLegacyState(legacy, {
    baseDocument: before, assetMap: new Map(before.sources.map(source => [source.assetId, source.assetId])),
  });
  return { before, legacy, exportDocument };
}

for (const count of [3, 5]) {
  test(`${count}-screen exact template keeps its final canonical device through headline-only editor saves`, async () => {
    const { before, legacy, exportDocument } = await fixture(count);
    const outgoing = legacy.screenshots.at(-1).devices.at(-1);
    const groupId = outgoing.groupId;
    assert.equal(legacy.screenshots.flatMap(scene => scene.devices).filter(device => device.groupId === groupId).length, 1);
    normalizeMetadata(legacy);
    normalizeMetadata(legacy); // Selecting controls repeatedly must remain idempotent.
    assert.equal(outgoing.placementLinkId, groupId);
    assert.equal(outgoing.seamLocked, true);
    legacy.screenshots[0].text.headlines.en = 'Turn text into\nlistening';
    const after = exportDocument();
    assert.equal(assertDocumentEditAllowed(before, after), after);
    for (const scene of before.scenes) for (const device of scene.devices) {
      assert.deepEqual(resolveDevice(after, scene.id, device.id), resolveDevice(before, scene.id, device.id));
    }
    assert.equal(after.scenes[0].text.headlines.en, 'Turn text into\nlistening');
  });
}

test('normalization does not bypass exact-template geometry or overflow locks', async () => {
  for (const change of ['geometry', 'overflow']) {
    const { before, legacy, exportDocument } = await fixture();
    normalizeMetadata(legacy);
    const outgoing = legacy.screenshots.at(-1).devices.at(-1);
    if (change === 'geometry') outgoing.centerX += 0.1;
    else outgoing.seamLocked = false;
    normalizeMetadata(legacy);
    assert.throws(() => assertDocumentEditAllowed(before, exportDocument()), { code: 'LOCKED' }, change);
  }
});

test('malformed and detached singleton links still lose legacy seam metadata', async () => {
  const cases = [
    ['standalone legacy state', state => { delete state.cloudDocument; }],
    ['different cloud project', state => { state.id = 'detached-project'; }],
    ['mismatched group', state => { state.screenshots.at(-1).devices.at(-1).groupId = 'wrong-group'; }],
    ['unknown canonical group', state => { state.cloudDocument.deviceGroups = []; }],
    ['canonical group is unlocked', state => { state.cloudDocument.deviceGroups.at(-1).seamLocked = false; }],
    ['unknown canonical placement', state => { state.screenshots.at(-1).devices.at(-1).id = 'unknown-placement'; }],
    ['detached from an existing pair', state => {
      const pair = state.screenshots[0].devices[0].groupId;
      state.screenshots[1].devices = state.screenshots[1].devices.filter(device => device.groupId !== pair);
      return state.screenshots[0].devices[0];
    }],
  ];
  for (const [label, mutate] of cases) {
    const { legacy } = await fixture();
    const target = mutate(legacy) || legacy.screenshots.at(-1).devices.at(-1);
    normalizeMetadata(legacy);
    assert.equal(target.placementLinkId, undefined, label);
    assert.equal(target.seamLocked, undefined, label);
  }
});
