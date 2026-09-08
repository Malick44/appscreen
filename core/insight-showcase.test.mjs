import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, createCampaign, fromLegacyState, resolveDevice, toLegacyState } from './campaign.mjs';
import { getTemplate } from './templates.mjs';

const variants = [
  ['insight-showcase-single', 1],
  ['insight-showcase-2', 2],
  ['insight-showcase', 3],
  ['insight-showcase-6', 6],
];
const assets = Array.from({ length: 6 }, (_, index) => ({
  id: `insight-source-${index + 1}`,
  name: `Real screenshot ${index + 1}`,
  width: 1320,
  height: 2868,
}));
const scenesOf = template => template.type === 'sequence' ? template.scenes : [template];
const cardContent = ({ id, templatePopout, ...card }) => card;

// The catalog is intentionally local-only in 3D. Exercise the shared campaign
// composition with a 2D copy without changing that cloud admission boundary.
async function withTwoDTemplate(templateId, run) {
  const original = getTemplate(templateId);
  assert.ok(original, `Missing template ${templateId}`);
  const copy = structuredClone(original);
  copy.id = `${templateId}-test-2d`;
  scenesOf(copy).forEach(scene => {
    if (scene.screenshot) scene.screenshot.use3D = false;
    (scene.devices || []).forEach(device => { device.use3D = false; });
  });
  const catalog = globalThis.AppScreenTemplates.templates;
  catalog.push(copy);
  try {
    return await run(copy);
  } finally {
    catalog.splice(catalog.indexOf(copy), 1);
  }
}

test('Insight Showcase has 1, 2, 3, and 6 screen layouts with real crop cards and a closed final seam', () => {
  for (const [templateId, screenCount] of variants) {
    const template = getTemplate(templateId);
    assert.ok(template, templateId);
    assert.equal(template.screenCount, screenCount, templateId);
    assert.equal(template.cloudCompatible, false, '3D remains local-only');
    assert.ok(template.cloudLimitations.some(item => item.code === 'DEVICE_3D'));
    const scenes = scenesOf(template);
    assert.equal(scenes.length, screenCount);
    for (const [index, scene] of scenes.entries()) {
      assert.equal(scene.background.solid, '#F4F1EA', 'Respect the dirty white template default');
      const hero = scene.devices.find(device => (device.sourceOffset || 0) === 0);
      assert.equal(hero?.use3D, true, `${templateId} screen ${index + 1} has an angled 3D hero`);
      assert.ok(scene.popouts?.length, `${templateId} screen ${index + 1} has editable screenshot crops`);
      for (const card of scene.popouts) {
        assert.ok(card.cropWidth > 0 && card.cropHeight > 0);
        assert.ok(card.cropX >= 0 && card.cropX + card.cropWidth <= 100);
        assert.ok(card.cropY >= 0 && card.cropY + card.cropHeight <= 100);
        assert.ok(card.width > 0);
        assert.equal(card.image, undefined, 'Cards derive from the current real source image');
        assert.equal(card.imageSrc, undefined);
      }
      if (index > 0) {
        const incoming = scene.devices.find(device => device.sourceOffset === -1);
        const outgoing = scenes[index - 1].devices.find(device => (device.sourceOffset || 0) === 0);
        assert.ok(incoming, `${templateId} screen ${index + 1} carries the prior hero`);
        assert.ok(Math.abs(incoming.centerX - (outgoing.centerX - 1)) < 1e-9);
        const seamAppearance = ({ centerX, sourceOffset, ...device }) => device;
        assert.deepEqual(seamAppearance(incoming), seamAppearance(outgoing), 'Both panels render the exact same hero');
      }
    }
    const terminal = scenes.at(-1).devices.find(device => (device.sourceOffset || 0) === 0);
    assert.equal(terminal.continueToNext, false, `${templateId} ends without an outgoing continuation`);
    assert.equal(scenes.at(-1).devices.some(device => device.continueToNext === true), false);
    for (const key of ['sequenceName', 'continuationCycle', 'continuationStep', 'continuationTextPositions']) {
      assert.equal(terminal[key], undefined, `${templateId} terminal ${key}`);
    }
    const radians = Math.abs(terminal.rotation) * Math.PI / 180;
    const halfWidth = terminal.scale / 200
      * (Math.abs(Math.cos(radians)) + (2556 / 1179) * Math.abs(Math.sin(radians)));
    const halfHeight = terminal.scale / 200
      * (Math.abs(Math.cos(radians)) + (1179 / 2556) * Math.abs(Math.sin(radians)));
    assert.ok(terminal.centerX - halfWidth >= 0.035 - 1e-12, `${templateId} terminal left edge`);
    assert.ok(terminal.centerX + halfWidth <= 0.965 + 1e-12, `${templateId} terminal right edge`);
    assert.ok(terminal.centerY - halfHeight >= 0.035 - 1e-12, `${templateId} terminal top edge`);
    assert.ok(terminal.centerY + halfHeight <= 0.965 + 1e-12, `${templateId} terminal bottom edge`);
  }
});

test('campaign composition keeps every detail card independent and preserves hero source identity across seams', async () => {
  for (const [templateId, screenCount] of variants) {
    await withTwoDTemplate(templateId, async template => {
      const doc = createCampaign({ templateId: template.id, assets, screenCount });
      const layouts = scenesOf(template);
      const ids = new Set();
      doc.scenes.forEach((scene, index) => {
        assert.deepEqual(scene.popouts.map(cardContent), layouts[index].popouts.map(cardContent));
        for (const card of scene.popouts) {
          assert.equal(card.templatePopout, true);
          assert.ok(!ids.has(card.id), 'Every applied card has an independent editor identity');
          ids.add(card.id);
        }
        if (index > 0) {
          const incomingIndex = layouts[index].devices.findIndex(device => device.sourceOffset === -1);
          const outgoingIndex = layouts[index - 1].devices.findIndex(device => (device.sourceOffset || 0) === 0);
          const previous = doc.scenes[index - 1];
          const incoming = resolveDevice(doc, scene.id, scene.devices[incomingIndex].id);
          const outgoing = resolveDevice(doc, previous.id, previous.devices[outgoingIndex].id);
          assert.equal(incoming.groupId, outgoing.groupId, 'Both panels reference one hero');
          assert.equal(incoming.sourceId, outgoing.sourceId);
          assert.ok(Math.abs(outgoing.centerX - incoming.centerX - 1) < 1e-9);
        }
      });
      const expectedCard = structuredClone(layouts[0].popouts[0]);
      doc.scenes[0].popouts[0].shadow.blur += 1;
      assert.deepEqual(layouts[0].popouts[0], expectedCard, 'Applied card styles cannot mutate the catalog');
    });
  }
});

test('showcase crops remain editable and survive the editor persistence roundtrip', async () => {
  await withTwoDTemplate('insight-showcase-6', async template => {
    let doc = createCampaign({ templateId: template.id, assets, screenCount: 6 });
    const scene = doc.scenes[0];
    doc = applyOperations(doc, [{
      op: 'update_popout', sceneId: scene.id, popoutId: scene.popouts[0].id,
      patch: { x: 42, cropX: 10, cropWidth: 70, shadow: { blur: 36 } },
    }]);
    assert.equal(doc.scenes[0].popouts[0].x, 42);
    assert.equal(doc.scenes[0].popouts[0].cropWidth, 70);
    assert.equal(doc.scenes[0].popouts[0].shadow.blur, 36);
    doc.sources[0].localizedAssets.de = 'insight-source-1-de';
    const legacy = await toLegacyState(doc);
    const roundtrip = fromLegacyState(legacy, {
      baseDocument: doc,
      assetMap: new Map([...assets.map(asset => [asset.id, asset.id]), ['insight-source-1-de', 'insight-source-1-de']]),
    });
    assert.deepEqual(roundtrip.scenes.map(item => item.popouts), doc.scenes.map(item => item.popouts));
    assert.equal(roundtrip.sources[0].localizedAssets.de, 'insight-source-1-de');
  });
});
