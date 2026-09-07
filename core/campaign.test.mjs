import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaign, validateCampaign, applyOperations, resolveDevice, toLegacyState, fromLegacyState, assertDocumentEditAllowed } from './campaign.mjs';
import { listTemplates } from './templates.mjs';
import { seededRandom } from './render.mjs';

const assets = [1, 2, 3, 4, 5].map(index => ({ id: `asset-${index}`, name: `Real capture ${index}`, width: 1320, height: 2868 }));
const make = options => createCampaign({ assets, screenCount: 5, templateId: 'tidal-relay', ...options });
// Persisted JSON objects may return in a different key order; arrays keep theirs.
const reorderObjectKeys = value => Array.isArray(value) ? value.map(reorderObjectKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)).map(([key, child]) => [key, reorderObjectKeys(child)])) : value;

test('every cloud-supported catalog template produces an editable versioned campaign', () => {
  for (const template of listTemplates().filter(t => t.cloudCompatible)) {
    const doc = make({ templateId: template.id });
    assert.equal(validateCampaign(doc).valid, true, template.id);
    assert.equal(doc.scenes.length, 5);
    assert.equal(doc.sources.length, 5);
    assert.equal(doc.template.id, template.id);
    assert.equal(JSON.stringify(doc).includes('data:image'), false);
  }
});

test('a connected device is one canonical placement with consistent screen-local coordinates', () => {
  const doc = make();
  const a = resolveDevice(doc, doc.scenes[0].id, doc.scenes[0].devices[0].id);
  const b = resolveDevice(doc, doc.scenes[1].id, doc.scenes[1].devices[0].id);
  assert.equal(a.groupId, b.groupId); assert.equal(a.sourceId, b.sourceId);
  assert.ok(Math.abs(a.centerX - b.centerX - 1) < 1e-12);
  const updated = applyOperations(doc, [{ op: 'update_device', sceneId: doc.scenes[0].id, deviceId: a.id, patch: { centerX: 0.93, rotation: 12 } }]);
  const result = resolveDevice(updated, doc.scenes[1].id, b.id);
  assert.ok(Math.abs(result.centerX + 0.07) < 1e-12); assert.equal(result.rotation, 12);
  assert.equal(doc.revision, 0); assert.equal(updated.revision, 1);
});

test('appearance propagates across all connected screens but geometry remains per-device', () => {
  const doc = make();
  const updated = applyOperations(doc, [{ op: 'update_appearance', sceneId: doc.scenes[0].id, patch: { frame: { enabled: true, color: '#ffcc00', width: 19 }, cornerRadius: 30 } }]);
  for (const scene of updated.scenes) for (const device of scene.devices) {
    const resolved = resolveDevice(updated, scene.id, device.id);
    assert.equal(resolved.frame.width, 19); assert.equal(resolved.frame.color, '#ffcc00'); assert.equal(resolved.cornerRadius, 30);
  }
});

test('exact template mode permits copy but rejects geometry changes atomically', () => {
  const doc = make({ templateMode: 'exact' }), scene = doc.scenes[0];
  assert.throws(() => applyOperations(doc, [{ op: 'update_text', sceneId: scene.id, patch: { headlines: { en: 'Accurate benefit' } } }, { op: 'update_device', sceneId: scene.id, deviceId: scene.devices[0].id, patch: { scale: 80 } }]), { code: 'LOCKED' });
  assert.equal(doc.scenes[0].text.headlines.en, '');
  assert.equal(applyOperations(doc, [{ op: 'update_text', sceneId: scene.id, patch: { headlines: { en: 'Accurate benefit' } } }]).scenes[0].text.headlines.en, 'Accurate benefit');
});

test('locks protect connected siblings and nested colors, full document saves cannot bypass them', () => {
  let doc = make(), scene = doc.scenes[1];
  doc = applyOperations(doc, [{ op: 'set_locks', sceneId: scene.id, patch: { positions: true, colors: true } }]);
  assert.throws(() => applyOperations(doc, [{ op: 'update_device', sceneId: doc.scenes[0].id, deviceId: doc.scenes[0].devices[0].id, patch: { rotation: 12 } }]), { code: 'LOCKED' });
  assert.throws(() => applyOperations(doc, [{ op: 'update_appearance', sceneId: doc.scenes[0].id, patch: { frame: { color: '#123456' } } }]), { code: 'LOCKED' });
  const next = structuredClone(doc); next.deviceGroups[0].geometry.scale = 99;
  assert.throws(() => assertDocumentEditAllowed(doc, next), { code: 'LOCKED' });
});

test('stale revisions are rejected and explicit unlock keeps devices independent', () => {
  const doc = make(), scene = doc.scenes[0];
  assert.throws(() => applyOperations(doc, [], { expectedRevision: 9 }), { code: 'REVISION_CONFLICT' });
  const updated = applyOperations(doc, [{ op: 'update_device', sceneId: scene.id, deviceId: scene.devices[0].id, patch: { seamLocked: false } }]);
  assert.notEqual(updated.scenes[0].devices[0].groupId, updated.scenes[1].devices[0].groupId);
});

test('legacy roundtrip preserves asset mapping, devices, appearance, source identity and localized copy', async () => {
  let doc = make();
  doc.sources[0].localizedAssets.de = 'german-asset';
  doc.scenes[0].text.headlines = { en: 'Listen anywhere', de: 'Überall hören' };
  doc = applyOperations(doc, [{ op: 'update_appearance', sceneId: doc.scenes[0].id, patch: { frame: { width: 21 } } }]);
  const legacy = await toLegacyState(doc, async id => `https://assets.example/${id}`);
  const assetMap = Object.fromEntries([...assets.map(a => a.id), 'german-asset'].map(id => [`https://assets.example/${id}`, id]));
  const result = fromLegacyState(legacy, { id: doc.id, name: doc.name, assetMap, baseDocument: doc });
  assert.equal(result.profile.width, 1320); assert.equal(result.profile.height, 2868);
  assert.equal(result.sources[0].localizedAssets.de, 'german-asset');
  assert.deepEqual(result.scenes[0].text.headlines, doc.scenes[0].text.headlines);
  for (let index = 0; index < doc.scenes.length; index++) for (const device of doc.scenes[index].devices) {
    const a = resolveDevice(doc, doc.scenes[index].id, device.id), b = resolveDevice(result, result.scenes[index].id, device.id);
    for (const key of ['sourceId', 'centerX', 'centerY', 'scale', 'rotation', 'frame', 'shadow']) assert.deepEqual(b[key], a[key], `${index}:${key}`);
  }
});

test('append carries outgoing portion forward without cloning the source UI', () => {
  const doc = make(), last = doc.scenes.at(-1), outgoing = last.devices.at(-1);
  const result = applyOperations(doc, [{ op: 'add_scene', sourceId: doc.sources[0].id }]);
  assert.equal(result.scenes.length, 6); assert.equal(result.sources.length, 5);
  assert.equal(result.scenes.at(-1).devices[0].groupId, outgoing.groupId);
  const a = resolveDevice(result, last.id, outgoing.id), b = resolveDevice(result, result.scenes.at(-1).id, result.scenes.at(-1).devices[0].id);
  assert.ok(Math.abs(a.centerX - b.centerX - 1) < 1e-12);
});

test('invalid references, binary payloads and unsupported operations fail closed', () => {
  const doc = make(), bad = structuredClone(doc); bad.deviceGroups[0].sourceId = 'not-there';
  assert.equal(validateCampaign(bad).valid, false);
  assert.throws(() => applyOperations(doc, [{ op: 'update_background', sceneId: doc.scenes[0].id, patch: { imageSrc: 'data:image/png;base64,AAAA' } }]));
  assert.throws(() => applyOperations(doc, [{ op: 'execute_code', sceneId: doc.scenes[0].id }]));
  assert.throws(() => createCampaign({ assets: [] }), { code: 'SOURCES_REQUIRED' });
});

test('noise is repeatable and never uses shared mutable random state', () => {
  const a = seededRandom(91), b = seededRandom(91), c = seededRandom(92);
  const values = Array.from({ length: 20 }, a);
  assert.deepEqual(values, Array.from({ length: 20 }, b));
  assert.notDeepEqual(values, Array.from({ length: 20 }, c));
});

test('exact-template full saves and regenerated IDs compare semantic geometry, not random IDs', async () => {
  const before = make({ templateMode: 'exact' });
  const cloned = structuredClone(before); cloned.revision += 1;
  assert.equal(assertDocumentEditAllowed(before, cloned), cloned);
  const regenerated = make({ id: before.id, templateMode: 'exact' });
  regenerated.scenes[0].text.headlines.en = 'A new accurate benefit';
  assert.equal(assertDocumentEditAllowed(before, regenerated), regenerated);
  regenerated.deviceGroups[0].geometry.scale += 1;
  assert.throws(() => assertDocumentEditAllowed(before, regenerated), { code: 'LOCKED' });
});

test('whole-document generation cannot bypass a locked scene by replacing its ID', () => {
  const before = make(); before.scenes[0].locks.text = true;
  const regenerated = make({ id: before.id }); regenerated.scenes[0].locks.text = true;
  regenerated.scenes[0].text.headlines.en = 'Changed';
  assert.throws(() => assertDocumentEditAllowed(before, regenerated), { code: 'LOCKED' });
});

test('persisted JSON key order cannot turn a headline-only exact-template roundtrip into a layout change', async () => {
  const before = reorderObjectKeys(make({ templateMode: 'exact' }));
  const legacy = await toLegacyState(before);
  legacy.screenshots[0].text.headlines.en = 'Turn text into\nlistening';
  const after = fromLegacyState(legacy, { baseDocument: before, assetMap: new Map(before.sources.map(source => [source.assetId, source.assetId])) });
  assert.notEqual(JSON.stringify(before.appearanceGroups[0].shadow), JSON.stringify(after.appearanceGroups[0].shadow));
  assert.deepEqual(before.appearanceGroups[0].shadow, after.appearanceGroups[0].shadow);
  assert.equal(assertDocumentEditAllowed(before, after), after);
});

test('semantic lock comparison still rejects genuine nested appearance, geometry and value-type changes', () => {
  const before = reorderObjectKeys(make({ templateMode: 'inspiration' }));
  before.locks = { appearance: true, positions: true, colors: true };
  const changes = [
    ['shadow offset', doc => { doc.appearanceGroups[0].shadow.x += 1; }],
    ['frame color', doc => { doc.appearanceGroups[0].frame.color = '#123456'; }],
    ['device position', doc => { doc.deviceGroups[0].geometry.centerX += 0.1; }],
    ['boolean changed to string', doc => { doc.appearanceGroups[0].shadow.enabled = 'true'; }],
  ];
  for (const [label, change] of changes) {
    const after = structuredClone(before);
    change(after);
    assert.throws(() => assertDocumentEditAllowed(before, after), { code: 'LOCKED' }, label);
  }
});

test('object key order is ignored but scene and nested gradient array order remain significant', () => {
  const before = make({ templateMode: 'exact' });
  before.locks = { colors: true, typography: true };
  const reorderedKeys = reorderObjectKeys(before);
  assert.equal(assertDocumentEditAllowed(before, reorderedKeys), reorderedKeys);
  const reorderedScenes = structuredClone(reorderedKeys);
  reorderedScenes.scenes.reverse();
  assert.throws(() => assertDocumentEditAllowed(before, reorderedScenes), { code: 'LOCKED' });
  const reorderedStops = structuredClone(reorderedKeys);
  reorderedStops.scenes[0].background.gradient.stops.reverse();
  assert.throws(() => assertDocumentEditAllowed(before, reorderedStops), { code: 'LOCKED' });
});
