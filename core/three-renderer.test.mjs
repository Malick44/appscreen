import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { listTemplates } from './templates.mjs';

const editorSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../three-renderer.js', import.meta.url), 'utf8');
const templates = listTemplates({ includeScenes: true });

function extractFunction(source, name) {
  const header = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(source);
  assert.ok(header, `Missing function: ${name}`);
  const nextFunction = /^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/gm;
  nextFunction.lastIndex = header.index + header[0].length;
  const next = nextFunction.exec(source);
  return source.slice(header.index, next?.index ?? source.length).trim();
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nearlyEqual(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, received ${actual}`);
}

function functionParameters(source, name) {
  const fn = extractFunction(source, name);
  const header = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`).exec(fn);
  assert.ok(header, `Could not read parameters for ${name}`);
  return {
    source: fn,
    names: header[1].split(',').map(value => value.trim().split('=')[0].trim()).filter(Boolean),
  };
}

test('catalog exposes fixed 1, 2, 3, and 6-screen templates with renderable device geometry', () => {
  assert.ok(templates.length > 0);
  assert.equal(new Set(templates.map(template => template.id)).size, templates.length, 'template ids must be unique');
  assert.deepEqual([...new Set(templates.map(template => template.screenCount))].sort((a, b) => a - b), [1, 2, 3, 6]);

  for (const template of templates) {
    assert.equal(template.fixedLength, true, `${template.id} must have a fixed screen count`);
    const scenes = template.scenes || [template];
    assert.equal(scenes.length, template.screenCount, `${template.id} scene count`);

    for (const [sceneIndex, scene] of scenes.entries()) {
      assert.ok(scene.devices?.length, `${template.id} scene ${sceneIndex + 1} needs a device`);
      for (const [deviceIndex, device] of scene.devices.entries()) {
        const label = `${template.id} scene ${sceneIndex + 1} device ${deviceIndex + 1}`;
        assert.ok(Number.isFinite(device.scale) && device.scale > 0, `${label} scale`);
        assert.ok(Number.isFinite(device.rotation), `${label} rotation`);
        if (device.positionMode === 'canvas') {
          assert.ok(Number.isFinite(device.centerX), `${label} centerX`);
          assert.ok(Number.isFinite(device.centerY), `${label} centerY`);
        } else {
          assert.ok(Number.isFinite(device.x), `${label} x`);
          assert.ok(Number.isFinite(device.y), `${label} y`);
        }

        if (Object.hasOwn(device, 'use3D')) assert.equal(typeof device.use3D, 'boolean', `${label} use3D`);
        if (device.device3D !== undefined) assert.ok(['iphone', 'samsung'].includes(device.device3D), `${label} device3D`);
        if (device.rotation3D) for (const axis of ['x', 'y', 'z']) {
          assert.ok(Number.isFinite(device.rotation3D[axis]), `${label} rotation3D.${axis}`);
          assert.ok(Math.abs(device.rotation3D[axis]) <= 45, `${label} rotation3D.${axis} range`);
        }
      }
    }
  }
});

test('3-screen sequences have 6-screen counterparts with matching seams and terminal devices', () => {
  const byId = new Map(templates.map(template => [template.id, template]));
  const sequences = templates.filter(template => template.screenCount > 1);
  assert.ok(sequences.some(template => template.screenCount === 3));
  assert.ok(sequences.some(template => template.screenCount === 6));

  for (const template of sequences.filter(candidate => candidate.screenCount === 3)) {
    const sixScreen = byId.get(`${template.id}-6`);
    assert.ok(sixScreen, `${template.id} needs a 6-screen counterpart`);
    assert.equal(sixScreen.name, template.name);
    assert.equal(sixScreen.category, template.category);
    assert.deepEqual(sixScreen.palette, template.palette);
  }

  for (const template of sequences) {
    for (let sceneIndex = 1; sceneIndex < template.scenes.length; sceneIndex++) {
      const previous = template.scenes[sceneIndex - 1].devices.find(device => (device.sourceOffset ?? 0) === 0);
      const incoming = template.scenes[sceneIndex].devices.filter(device => device.sourceOffset === -1);
      assert.ok(previous, `${template.id} scene ${sceneIndex} needs a current-source device`);
      assert.equal(incoming.length, 1, `${template.id} scene ${sceneIndex + 1} needs one incoming seam device`);
      nearlyEqual(incoming[0].centerX, previous.centerX - 1, `${template.id} seam ${sceneIndex} centerX`);
      for (const key of ['positionMode', 'centerY', 'scale', 'x', 'y', 'rotation', 'perspective', 'opacity']) {
        assert.equal(incoming[0][key], previous[key], `${template.id} seam ${sceneIndex} ${key}`);
      }
    }

    const terminalScene = template.scenes.at(-1);
    const terminal = terminalScene.devices.find(device => (device.sourceOffset ?? 0) === 0);
    assert.ok(terminal, `${template.id} terminal scene needs a current-source device`);
    assert.equal(terminal.continueToNext, false, `${template.id} must stop at its final screen`);
    assert.equal(terminalScene.devices.some(device => device.continueToNext === true), false);
    for (const key of ['sequenceName', 'continuationCycle', 'continuationStep', 'continuationTextPositions']) {
      assert.equal(terminal[key], undefined, `${template.id} terminal ${key}`);
    }

    // The terminal phone must finish inside the canvas instead of opening another seam.
    const radians = Math.abs(terminal.rotation) * Math.PI / 180;
    const horizontalHalfExtent = terminal.scale / 200
      * (Math.abs(Math.cos(radians)) + (2556 / 1179) * Math.abs(Math.sin(radians)));
    const verticalHalfExtent = terminal.scale / 200
      * (Math.abs(Math.cos(radians)) + (1179 / 2556) * Math.abs(Math.sin(radians)));
    assert.ok(terminal.centerX - horizontalHalfExtent >= 0.035 - 1e-12, `${template.id} terminal left edge`);
    assert.ok(terminal.centerX + horizontalHalfExtent <= 0.965 + 1e-12, `${template.id} terminal right edge`);
    assert.ok(terminal.centerY - verticalHalfExtent >= 0.035 - 1e-12, `${template.id} terminal top edge`);
    assert.ok(terminal.centerY + verticalHalfExtent <= 0.965 + 1e-12, `${template.id} terminal bottom edge`);
  }
});

test('terminal continuation flags stop the runtime legacy fallback path', () => {
  const helpers = [
    extractFunction(editorSource, 'isCurrentScreenshotDevice'),
    extractFunction(editorSource, 'getSequenceOutgoingDevices'),
  ].join('\n');
  const previous = { id: 'previous', devices: [], elements: [] };
  const terminal = {
    id: 'terminal',
    elements: [{ templateElement: true }],
    devices: [
      { sourceOffset: -1, sourceScreenshotId: 'previous', positionMode: 'canvas', centerX: -0.1, centerY: 0.7 },
      { sourceOffset: 0, sourceScreenshotId: 'terminal', positionMode: 'canvas', centerX: 0.9, centerY: 0.7, continueToNext: false },
    ],
  };
  const context = { state: { screenshots: [previous, terminal] }, terminal };
  runInNewContext(`${helpers}\nglobalThis.outgoing = getSequenceOutgoingDevices(terminal, 1);`, context);
  assert.deepEqual(jsonClone(context.outgoing), []);

  delete terminal.devices[1].continueToNext;
  runInNewContext(`${helpers}\nglobalThis.fallbackOutgoing = getSequenceOutgoingDevices(terminal, 1);`, context);
  assert.equal(context.fallbackOutgoing.length, 1, 'fixture must otherwise qualify for the legacy fallback');
});

test('template application preserves an active 3D workflow and honors explicit local 3D defaults', () => {
  const applyTemplateScene = extractFunction(editorSource, 'applyTemplateScene');
  const apply = (scene, { isSequence = false, startsIn3D = true, retainedThreeD = null } = {}) => {
    const screenshot = {
      background: {}, elements: [], devices: [],
      screenshot: { use3D: startsIn3D, device3D: 'samsung', frameColor: 'gray', rotation3D: { x: 9, y: 8, z: 7 } },
      text: { headlines: { en: 'Headline' }, subheadlines: { en: 'Subheadline' } },
    };
    const context = {
      screenshot,
      scene: jsonClone(scene),
      isSequence,
      applyTemplateBackground: background => background,
      templateShapeToElement: shape => shape,
      resolveTemplateDevices: devices => jsonClone(devices || []),
      getValidThreeDDeviceType: deviceType => deviceType === 'samsung' ? 'samsung' : 'iphone',
      getValidFrameColor: (deviceType, colorId) => colorId || (deviceType === 'samsung' ? 'gray' : 'natural'),
      retainedThreeD,
    };
    runInNewContext(`${applyTemplateScene}\napplyTemplateScene(screenshot, scene, 0, 'merge', isSequence, retainedThreeD);`, context);
    return screenshot;
  };

  const ordinary = apply({ devices: [{ source: 'current', scale: 70, x: 50, y: 50 }], text: {} });
  assert.equal(ordinary.screenshot.use3D, true);
  assert.equal(ordinary.screenshot.device3D, 'samsung');
  assert.equal(ordinary.screenshot.frameColor, 'gray');
  assert.deepEqual(jsonClone(ordinary.screenshot.rotation3D), { x: 9, y: 8, z: 7 });

  const ordinary2D = apply(
    { devices: [{ source: 'current', scale: 70, x: 50, y: 50 }], text: {} },
    { startsIn3D: false },
  );
  assert.equal(ordinary2D.screenshot.use3D, false);
  assert.deepEqual(jsonClone(ordinary2D.screenshot.rotation3D), { x: 0, y: 0, z: 0 });

  const explicit = apply({ devices: [{
    source: 'current', scale: 70, x: 50, y: 50, use3D: true,
    device3D: 'iphone', frameColor: 'natural', rotation3D: { x: 2, y: -38, z: -2 },
  }], text: {} }, { startsIn3D: false });
  assert.equal(explicit.screenshot.use3D, true);
  assert.equal(explicit.screenshot.device3D, 'iphone');
  assert.equal(explicit.screenshot.frameColor, 'natural');
  assert.deepEqual(jsonClone(explicit.screenshot.rotation3D), { x: 2, y: -38, z: -2 });

  const retained = { use3D: true, device3D: 'samsung', frameColor: 'gray', rotation3D: { x: 3, y: 4, z: 5 } };
  const sequence = apply(
    { devices: [{ sourceOffset: 0, scale: 70, x: 50, y: 50, use3D: true }], text: {} },
    { isSequence: true, startsIn3D: false, retainedThreeD: retained },
  );
  assert.equal(sequence.screenshot.use3D, true, 'an active 3D choice must survive sequence application');
  assert.equal(sequence.screenshot.device3D, 'samsung');
  assert.equal(sequence.screenshot.frameColor, 'gray');
  assert.deepEqual(jsonClone(sequence.screenshot.rotation3D), retained.rotation3D);

  const cloudPulse = apply({ devices: [{
    source: 'current', scale: 70, x: 50, y: 50, use3D: true,
    device3D: 'iphone', frameColor: 'natural', rotation3D: { x: 2, y: -38, z: -2 },
  }], text: {} }, { startsIn3D: true, retainedThreeD: { ...retained, allow3D: false } });
  assert.equal(cloudPulse.screenshot.use3D, false, 'cloud templates must stay in supported 2D mode');
});

test('composed 3D items preserve visible device order, source images, geometry, and shared appearance', () => {
  const helpers = [
    extractFunction(editorSource, 'getValidThreeDDeviceType'),
    extractFunction(editorSource, 'getDeviceRenderSettings'),
    extractFunction(editorSource, 'getThreeDItemViewport'),
    extractFunction(editorSource, 'getThreeDRenderItems'),
    extractFunction(editorSource, 'getDeviceSourceIndex'),
  ].join('\n');
  const previous = { id: 'previous' };
  const screenshot = {
    id: 'current-screen',
    screenshot: {
      use3D: true, device3D: 'samsung', rotation3D: { x: 4, y: 5, z: 6 },
      scale: 50, x: 50, y: 50, cornerRadius: 31,
      frame: { enabled: true, color: '#111111' }, shadow: { enabled: true, blur: 22 },
    },
    devices: [
      { id: 'incoming', sourceOffset: -1, sourceScreenshotId: 'previous', placementLinkId: 'seam-a', centerX: -0.15, centerY: 0.7, positionMode: 'canvas', scale: 84, rotation: -8, opacity: 65,
        frame: { enabled: false }, shadow: { enabled: false }, cornerRadius: 2,
        device3D: 'iphone', frameColor: 'natural', rotation3D: { x: 2, y: -38, z: -2 } },
      { id: 'hidden', sourceOffset: 0, centerX: 0.4, centerY: 0.4, positionMode: 'canvas', scale: 40, rotation: 0, hidden: true },
      { id: 'current', sourceOffset: 0, sourceScreenshotId: 'current-screen', placementLinkId: 'seam-b', centerX: 0.85, centerY: 0.7, positionMode: 'canvas', scale: 84, rotation: -8, opacity: 100 },
    ],
  };
  const context = {
    screenshot,
    state: { screenshots: [previous, { id: 'middle' }, screenshot] },
    getScreenshotImage: () => 'fallback-image',
    getDeviceSourceImage: (_screenIndex, device) => `${device.id}-image`,
  };
  runInNewContext(`${helpers}\nglobalThis.items = getThreeDRenderItems(screenshot, 2);`, context);
  const items = jsonClone(context.items);

  assert.deepEqual(items.map(item => item.image), ['incoming-image', 'current-image']);
  assert.deepEqual(items.map(item => item.viewport), [
    { screenIndex: 1, screenCount: 2 },
    { screenIndex: 0, screenCount: 2 },
  ]);
  assert.deepEqual(items.map(item => item.settings.centerX), [-0.15, 0.85]);
  assert.deepEqual(items.map(item => item.settings.opacity), [65, 100]);
  assert.deepEqual(items[0].settings.frame, screenshot.screenshot.frame);
  assert.deepEqual(items[0].settings.shadow, screenshot.screenshot.shadow);
  assert.equal(items[0].settings.cornerRadius, screenshot.screenshot.cornerRadius);
  assert.equal(items[0].settings.device3D, 'samsung');
  assert.equal(items[0].settings.frameColor, screenshot.screenshot.frameColor);
  assert.deepEqual(items[0].settings.rotation3D, screenshot.screenshot.rotation3D);

  screenshot.screenshot.device3D = 'unknown-persisted-model';
  runInNewContext(`${helpers}\nglobalThis.invalidItems = getThreeDRenderItems(screenshot, 2);`, context);
  assert.ok(context.invalidItems.every(item => item.settings.device3D === 'iphone'));

  screenshot.devices[2].placementLinkId = undefined;
  runInNewContext(`${helpers}\nglobalThis.localItems = getThreeDRenderItems(screenshot, 2);`, context);
  assert.deepEqual(jsonClone(context.localItems[1].viewport), { screenIndex: 0, screenCount: 1 });
});

test('local 3D mode propagates through a connected template without mutating cloud projects', () => {
  const helpers = [
    'setObjectPath', 'getLinkedDeviceScreens', 'getDefaultFrameColor', 'getValidThreeDDeviceType', 'getValidFrameColor',
    'getThreeDSettingTargets', 'setDeviceRenderMode', 'getDeviceSourceIndex',
  ].map(name => extractFunction(editorSource, name)).join('\n');
  const makeScreens = () => [
    { id: 'one', devices: [{ sourceOffset: 0 }], screenshot: { device3D: 'iphone', frameColor: 'natural', rotation3D: { x: -1, y: -2, z: -3 } } },
    { id: 'two', devices: [{ sourceOffset: -1, placementLinkId: 'first-seam' }, { sourceOffset: 0 }], screenshot: { device3D: 'samsung', frameColor: 'gray', rotation3D: { x: 4, y: 5, z: 6 } } },
    { id: 'three', devices: [{ sourceOffset: -1, placementLinkId: 'second-seam' }, { sourceOffset: 0 }], screenshot: { device3D: 'iphone', frameColor: 'natural', rotation3D: { x: 7, y: 8, z: 9 } } },
  ];
  const state = { screenshots: makeScreens(), selectedIndex: 1 };
  const context = {
    state,
    getCurrentScreenshot: () => state.screenshots[state.selectedIndex],
    isCloudDocumentContext: () => false,
    frameColorPresets: {
      iphone: [{ id: 'natural' }],
      samsung: [{ id: 'gray' }],
    },
  };
  runInNewContext(`${helpers}\nglobalThis.changed = setDeviceRenderMode(true);`, context);
  assert.equal(context.changed, true);
  assert.deepEqual(state.screenshots.map(screen => screen.screenshot.use3D), [true, true, true]);
  assert.deepEqual(state.screenshots.map(screen => screen.screenshot.device3D), ['samsung', 'samsung', 'samsung']);
  assert.deepEqual(state.screenshots.map(screen => screen.screenshot.frameColor), ['gray', 'gray', 'gray']);
  assert.deepEqual(jsonClone(state.screenshots.map(screen => screen.screenshot.rotation3D)), [
    { x: 4, y: 5, z: 6 },
    { x: 4, y: 5, z: 6 },
    { x: 4, y: 5, z: 6 },
  ]);

  const cloudState = { screenshots: makeScreens(), selectedIndex: 1 };
  const cloudContext = {
    state: cloudState,
    getCurrentScreenshot: () => cloudState.screenshots[cloudState.selectedIndex],
    isCloudDocumentContext: () => true,
    frameColorPresets: context.frameColorPresets,
  };
  runInNewContext(`${helpers}\nglobalThis.changed = setDeviceRenderMode(true);`, cloudContext);
  assert.equal(cloudContext.changed, false);
  assert.ok(cloudState.screenshots.every(screen => screen.screenshot.use3D === undefined));
});

test('adjacent 3D seam placements resolve to the same item-local world transform', () => {
  const applyTransform = extractFunction(rendererSource, 'applyThreeDPlacementTransform');
  const makePivot = () => ({
    position: { values: null, set(...values) { this.values = values; } },
    scale: { value: null, setScalar(value) { this.value = value; } },
    rotation: { values: null, set(...values) { this.values = values; } },
  });
  const context = {
    deviceConfigs: { iphone: { modelRotation: { x: 1, y: 2, z: 3 } } },
    threeCamera: { position: { z: 5 }, fov: 50 },
    basePositionOffset: { x: 0.1, y: -0.2, z: 0.3 },
    THREE: { MathUtils: { degToRad: degrees => degrees * Math.PI / 180 } },
    dims: { width: 1179, height: 2556 },
    outgoing: makePivot(),
    incoming: makePivot(),
    outgoingSettings: { positionMode: 'canvas', centerX: 0.92, centerY: 0.68, scale: 82, rotation: -34, rotation3D: { x: 4, y: 5, z: 6 } },
    incomingSettings: { positionMode: 'canvas', centerX: -0.08, centerY: 0.68, scale: 82, rotation: -34, rotation3D: { x: 4, y: 5, z: 6 } },
  };
  runInNewContext(`${applyTransform}
applyThreeDPlacementTransform(outgoing, outgoingSettings, dims, 0, 2, 'iphone');
applyThreeDPlacementTransform(incoming, incomingSettings, dims, 1, 2, 'iphone');`, context);
  nearlyEqual(context.outgoing.position.values[0], context.incoming.position.values[0], 'world x');
  nearlyEqual(context.outgoing.position.values[1], context.incoming.position.values[1], 'world y');
  assert.equal(context.outgoing.scale.value, context.incoming.scale.value);
  assert.deepEqual(jsonClone(context.outgoing.rotation.values), jsonClone(context.incoming.rotation.values));
});

test('main and side-preview paths pass composed items to renderer entry points that consume them', () => {
  const mainPreview = extractFunction(editorSource, 'updateCanvas');
  const sidePreview = extractFunction(editorSource, 'renderScreenshotToCanvas');
  assert.match(mainPreview, /const items = getThreeDRenderItems\(/);
  assert.match(mainPreview, /renderThreeJSToCanvas\([\s\S]*?items/);
  assert.match(sidePreview, /const items = getThreeDRenderItems\(/);
  assert.match(sidePreview, /renderThreeJSForScreenshot\([\s\S]*?items/);

  const mainRenderer = functionParameters(rendererSource, 'renderThreeJSToCanvas');
  assert.ok(mainRenderer.names.length >= 4, 'main renderer must accept composed render items');
  const mainItems = mainRenderer.names[3];
  assert.ok((mainRenderer.source.match(new RegExp(`\\b${mainItems}\\b`, 'g')) || []).length >= 2,
    'main renderer must consume its composed render items');

  const sideRenderer = functionParameters(rendererSource, 'renderThreeJSForScreenshot');
  assert.ok(sideRenderer.names.length >= 5, 'side renderer must accept composed render items');
  const sideItems = sideRenderer.names[4];
  assert.ok((sideRenderer.source.match(new RegExp(`\\b${sideItems}\\b`, 'g')) || []).length >= 2,
    'side renderer must consume its composed render items');

  const composedRenderer = extractFunction(rendererSource, 'renderThreeDItemsToCanvas');
  assert.match(composedRenderer, /item\.viewport\?\.screenCount/);
  assert.match(composedRenderer, /item\.viewport\?\.screenIndex/);
  assert.equal(/state\.screenshots\.length/.test(composedRenderer), false,
    'device projection must not depend on the project screen count');
});

test('bundled model configuration is valid GLB v2 and async loads reject stale callbacks', () => {
  const configBlock = rendererSource.slice(
    rendererSource.indexOf('const deviceConfigs ='),
    rendererSource.indexOf('// Frame color presets per device'),
  );
  const modelPaths = [...configBlock.matchAll(/modelPath:\s*['"]([^'"]+\.glb)['"]/g)].map(match => match[1]);
  assert.ok(modelPaths.length >= 2, 'expected the bundled iPhone and Samsung models');
  assert.equal(new Set(modelPaths).size, modelPaths.length, 'model paths must be unique');

  for (const modelPath of modelPaths) {
    assert.equal(modelPath.startsWith('/'), false, `${modelPath} must be repository-relative`);
    assert.equal(modelPath.split('/').includes('..'), false, `${modelPath} must not escape the repository`);
    const modelUrl = new URL(`../${modelPath}`, import.meta.url);
    assert.equal(existsSync(modelUrl), true, `missing model asset: ${modelPath}`);
    assert.ok(statSync(modelUrl).size > 128, `${modelPath} is unexpectedly small`);
    const bytes = readFileSync(modelUrl);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF', `${modelPath} magic`);
    assert.equal(bytes.readUInt32LE(4), 2, `${modelPath} version`);
    assert.equal(bytes.readUInt32LE(8), bytes.length, `${modelPath} declared length`);
  }

  for (const name of ['loadPhoneModel', 'switchPhoneModel']) {
    const source = extractFunction(rendererSource, name);
    assert.match(source, /const requestId = \+\+phoneModelLoadRequestId;/, `${name} request token`);
    assert.ok((source.match(/requestId !== phoneModelLoadRequestId/g) || []).length >= 2,
      `${name} must guard both success and failure callbacks against stale loads`);
  }
});

test('3D failures are visible, file launches are actionable, and renderer failures stay contained', () => {
  const reportUnavailable = extractFunction(rendererSource, 'reportThreeDUnavailable');
  assert.match(reportUnavailable, /window\.location\?\.protocol === 'file:'/);
  assert.match(reportUnavailable, /http:\/\/localhost:8000\//);
  assert.match(reportUnavailable, /showTemplateToast/);

  const initialize = extractFunction(rendererSource, 'initThreeJS');
  assert.match(initialize, /new THREE\.WebGLRenderer/);
  assert.match(initialize, /catch \(error\)/);
  assert.match(initialize, /reportThreeDUnavailable\(currentDeviceModel, error\)/);

  const switchModel = extractFunction(rendererSource, 'switchPhoneModel');
  assert.match(switchModel, /if \(!isThreeJSRendererReady\(\)\)/);

  const prepare = extractFunction(editorSource, 'prepareScreenshotForExport');
  assert.match(prepare, /!isThreeJSRendererReady\(\)/);
  assert.match(prepare, /The 3D renderer is unavailable/);
});

test('3D export validates every device source and waits for every required model', () => {
  const prepare = extractFunction(editorSource, 'prepareScreenshotForExport');
  assert.match(prepare, /\(screenshot\.devices \|\| \[\]\)\.forEach/);
  assert.match(prepare, /getDeviceSourceImage\(/);
  const itemsIndex = prepare.indexOf('getThreeDRenderItems(');
  const deviceTypesIndex = prepare.indexOf('const deviceTypes =');
  const waitIndex = prepare.indexOf('await Promise.all(deviceTypes.map(deviceType => waitForPhoneModel(deviceType)))');
  assert.ok(itemsIndex >= 0, 'export must inspect the composed 3D items');
  assert.ok(deviceTypesIndex > itemsIndex, 'export must derive the models used by the composition');
  assert.ok(waitIndex > deviceTypesIndex, 'export must await every model before drawing');
});
