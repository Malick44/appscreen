import test from 'node:test';
import assert from 'node:assert/strict';
import { getCloudRenderSupport } from './cloud-support.mjs';
import { getTemplate, listTemplates } from './templates.mjs';
import { createCampaign, applyOperations } from './campaign.mjs';
import { renderScene } from './render.mjs';

test('catalog list, full list and individual templates share explicit compatibility reasons', () => {
  for (const summary of listTemplates()) {
    const full = getTemplate(summary.id), included = listTemplates({ includeScenes: true }).find(t => t.id === summary.id);
    assert.equal(summary.cloudCompatible, full.cloudCompatible);
    assert.deepEqual(summary.cloudLimitations, full.cloudLimitations);
    assert.deepEqual(full, included);
    if (summary.cloudCompatible) assert.deepEqual(summary.cloudLimitations, []);
    else assert.ok(summary.cloudLimitations.length);
  }
  assert.deepEqual(getTemplate('pulse-portrait').cloudLimitations.map(i => i.code), ['DEVICE_3D', 'LAYERED_PHOTO']);
  const local = getTemplate('pulse-portrait'); local.cloudLimitations.length = 0;
  assert.equal(getTemplate('pulse-portrait').cloudLimitations.length, 2);
});

test('2D layered photos are independently unsupported; flat uploaded backgrounds remain supported', () => {
  const template = { devices: [{ use3D: false }], background: { type: 'gradient', photo: { enabled: true } } };
  assert.deepEqual(getCloudRenderSupport(template).cloudLimitations.map(i => i.code), ['LAYERED_PHOTO']);
  template.background.photo.enabled = false;
  assert.equal(getCloudRenderSupport(template).cloudCompatible, true);
  assert.equal(getCloudRenderSupport({ background: { type: 'image', assetId: 'uploaded' }, devices: [{ use3D: false }] }).cloudCompatible, true);
  assert.equal(getCloudRenderSupport({ scenes: [{ screenshot: { use3D: true } }] }).cloudCompatible, false);
  assert.equal(getCloudRenderSupport({ scenes: [], deviceGroups: [{ geometry: { use3D: true } }] }).cloudCompatible, false);
});

test('manual creation and template application reject local-only layouts without mutating the current campaign', () => {
  const assets = [{ id: 'fixture', width: 1320, height: 2868 }];
  assert.throws(() => createCampaign({ assets, templateId: 'pulse-portrait' }), { code: 'UNSUPPORTED_TEMPLATE', statusCode: 422 });
  const doc = createCampaign({ assets, templateId: 'tidal-relay', templateMode: 'inspiration' }), before = structuredClone(doc);
  assert.throws(() => applyOperations(doc, [{ op: 'apply_template', templateId: 'pulse-portrait' }]), { code: 'UNSUPPORTED_TEMPLATE' });
  assert.deepEqual(doc, before);
});

test('renderer rejects unsupported scene features before resources or source bytes are loaded', async () => {
  for (const feature of ['photo', '3d']) {
    const doc = createCampaign({ assets: [{ id: 'fixture', width: 1320, height: 2868 }] });
    if (feature === 'photo') doc.scenes[0].background.photo = { enabled: true };
    else doc.scenes[0].screenshot.use3D = true;
    let reads = 0;
    // No DOM/canvas is available in this Node test: support must fail first.
    await assert.rejects(renderScene(null, doc, doc.scenes[0].id, { resolveAsset: () => { reads++; throw new Error('Source read must not happen'); } }), /local editor only/);
    assert.equal(reads, 0);
  }
});
