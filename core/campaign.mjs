import { getTemplate, listTemplates } from './templates.mjs';
import { cloudSupportMessage } from './cloud-support.mjs';

export const SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE = Object.freeze({ id: 'iphone-6.9', width: 1320, height: 2868 });
export class CampaignError extends Error {
  constructor(message, code = 'INVALID_CAMPAIGN', status = 400, details = []) {
    super(message); this.name = 'CampaignError'; this.code = code; this.status = status; this.statusCode = status; this.details = details;
  }
}
export const clone = value => structuredClone(value);
export const hasCampaignLocks = doc => [doc.locks, ...doc.scenes.map(scene => scene.locks), ...doc.deviceGroups.map(group => group.locks)].some(locks => Object.values(locks || {}).some(Boolean));
const uid = prefix => `${prefix}_${globalThis.crypto.randomUUID()}`;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const appearanceKeys = ['frame', 'shadow', 'cornerRadius'];
const geometryKeys = ['positionMode', 'centerX', 'centerY', 'scale', 'x', 'y', 'rotation', 'perspective', 'opacity', 'hidden', 'crop'];
export const DEFAULT_BACKGROUND = Object.freeze({ type: 'solid', solid: '#E9E8F7', gradient: { angle: 135, stops: [{ color: '#E9E8F7', position: 0 }, { color: '#CEC9F8', position: 100 }] }, imageFit: 'cover', imageBlur: 0, overlayColor: '#000000', overlayOpacity: 0, noise: false, noiseIntensity: 10 });
export const DEFAULT_DEVICE = Object.freeze({ scale: 72, x: 50, y: 57, rotation: 0, perspective: 0, opacity: 100, cornerRadius: 24, use3D: false, shadow: { enabled: true, color: '#000000', blur: 40, opacity: 30, x: 0, y: 20 }, frame: { enabled: false, color: '#17171B', width: 12, opacity: 100 } });
export const DEFAULT_TEXT = Object.freeze({ headlineEnabled: true, headlines: { en: '' }, headlineLanguages: ['en'], currentHeadlineLang: 'en', headlineFont: 'AppScreen Sans', headlineSize: 100, headlineWeight: '700', headlineColor: '#17171B', headlineItalic: false, headlineUnderline: false, headlineStrikethrough: false, headlineGradient: false, position: 'top', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', lineHeight: 110, perLanguageLayout: false, languageSettings: {}, subheadlineEnabled: false, subheadlines: { en: '' }, subheadlineLanguages: ['en'], currentSubheadlineLang: 'en', subheadlineFont: 'AppScreen Sans', subheadlineSize: 50, subheadlineWeight: '400', subheadlineColor: '#17171B', subheadlineOpacity: 75 });

function merge(base, patch) {
  const result = clone(base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new CampaignError('Unsafe property');
    result[key] = plain(value) && plain(result[key]) ? merge(result[key], value) : clone(value);
  }
  return result;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, clone(value[key])]));
const allKeys = object => Object.entries(object || {}).flatMap(([key, value]) => [key, ...(plain(value) ? allKeys(value) : [])]);
const stripRuntimeMedia = object => {
  if (!object || typeof object !== 'object') return object;
  if (Array.isArray(object)) return object.map(stripRuntimeMedia);
  return Object.fromEntries(Object.entries(object).filter(([key]) => !['image', 'imageSrc', 'src'].includes(key)).map(([key, value]) => [key, stripRuntimeMedia(value)]));
};

function assertJson(value, path = 'document', depth = 0) {
  if (depth > 30) throw new CampaignError('Document is nested too deeply');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new CampaignError(`Non-finite number at ${path}`);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new CampaignError(`Non-serializable value at ${path}`);
  if (typeof value === 'string' && value.length > 250000) throw new CampaignError(`Oversized text at ${path}; upload binary assets separately`);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new CampaignError(`Unsafe property at ${path}`);
    if (['src', 'imageSrc'].includes(key) && typeof child === 'string' && child) throw new CampaignError('Images must reference uploaded assets, not URLs or binary data');
    assertJson(child, `${path}.${key}`, depth + 1);
  }
}

export function validateCampaign(doc) {
  const issues = [];
  try { assertJson(doc); } catch (error) { issues.push(error.message); }
  if (doc?.schemaVersion !== SCHEMA_VERSION) issues.push(`Expected schemaVersion ${SCHEMA_VERSION}`);
  if (!doc?.id || typeof doc.name !== 'string' || doc.name.length > 160) issues.push('Campaign needs id and name (up to 160 characters)');
  if (!Number.isInteger(doc?.revision) || doc.revision < 0) issues.push('Campaign revision must be a non-negative integer');
  const p = doc?.profile;
  if (!p || !Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 320 || p.height < 320 || p.width > 8000 || p.height > 8000 || p.width * p.height > 22000000) issues.push('Invalid output profile');
  for (const key of ['sources', 'scenes', 'deviceGroups', 'appearanceGroups']) if (!Array.isArray(doc?.[key])) issues.push(`${key} must be an array`);
  if (issues.length) return { valid: false, issues, errors: issues };
  if (doc.scenes.length > 30 || doc.sources.length > 100) issues.push('Campaign exceeds supported scene/source count');
  const ids = list => new Set(list.map(item => item.id));
  for (const key of ['sources', 'scenes', 'deviceGroups', 'appearanceGroups']) if (ids(doc[key]).size !== doc[key].length || doc[key].some(item => typeof item.id !== 'string' || !item.id || item.id.length > 160)) issues.push(`${key} need unique string ids`);
  const sourceIds = ids(doc.sources), groupIds = ids(doc.deviceGroups), appearanceIds = ids(doc.appearanceGroups);
  const range = (value, minimum, maximum, label) => { if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)) issues.push(`Invalid ${label}`); };
  for (const source of doc.sources) if (!source.assetId || typeof source.assetId !== 'string') issues.push(`Missing asset for source ${source.id}`);
  for (const group of doc.deviceGroups) {
    if (!plain(group.geometry) || typeof group.geometry.scale !== 'number') issues.push(`Missing geometry for device ${group.id}`);
    if (!sourceIds.has(group.sourceId)) issues.push(`Missing source for device ${group.id}`);
    if (!appearanceIds.has(group.appearanceGroupId)) issues.push(`Missing appearance for device ${group.id}`);
    if (group.geometry?.scale <= 0 || group.geometry?.scale > 500) issues.push(`Invalid scale for device ${group.id}`);
    for (const key of ['centerX', 'centerY']) range(group.geometry?.[key], -100, 100, `${key} for ${group.id}`);
    for (const key of ['x', 'y', 'rotation', 'perspective']) range(group.geometry?.[key], -1000, 1000, `${key} for ${group.id}`);
    range(group.geometry?.opacity, 0, 100, `opacity for ${group.id}`);
    if (group.geometry?.crop) {
      const crop = group.geometry.crop;
      for (const key of ['x', 'y', 'width', 'height']) range(crop[key], 0, 100, `crop ${key} for ${group.id}`);
      if ((crop.width ?? 100) <= 0 || (crop.height ?? 100) <= 0 || (crop.x || 0) + (crop.width ?? 100) > 100 || (crop.y || 0) + (crop.height ?? 100) > 100) issues.push(`Crop exceeds source for ${group.id}`);
    }
  }
  for (const appearance of doc.appearanceGroups) {
    range(appearance.cornerRadius, 0, 1000, 'corner radius');
    range(appearance.frame?.width, 0, 200, 'border width');
    range(appearance.frame?.opacity, 0, 100, 'border opacity');
    range(appearance.shadow?.opacity, 0, 100, 'shadow opacity');
    range(appearance.shadow?.blur, 0, 500, 'shadow blur');
  }
  for (const scene of doc.scenes) {
    if (!sourceIds.has(scene.sourceId)) issues.push(`Missing source for scene ${scene.id}`);
    if (!Array.isArray(scene.devices) || scene.devices.length > 30) issues.push(`Invalid devices for scene ${scene.id}`);
    for (const device of scene.devices || []) if (!groupIds.has(device.groupId)) issues.push(`Missing group for device ${device.id}`);
    if (!scene.background || !scene.text || !scene.screenshot) issues.push(`Missing scene settings for ${scene.id}`);
    if (!['solid', 'gradient', 'image'].includes(scene.background?.type)) issues.push(`Unsupported background type for ${scene.id}`);
    if (scene.background?.type === 'gradient' && (!Array.isArray(scene.background.gradient?.stops) || !scene.background.gradient.stops.length || scene.background.gradient.stops.some(stop => typeof stop.color !== 'string' || typeof stop.position !== 'number' || stop.position < 0 || stop.position > 100))) issues.push(`Invalid background gradient for ${scene.id}`);
    for (const field of ['headlines', 'subheadlines']) if (scene.text?.[field] && (!plain(scene.text[field]) || Object.values(scene.text[field]).some(value => typeof value !== 'string' || value.length > 10000))) issues.push(`Invalid ${field} for ${scene.id}`);
    if ((scene.elements || []).length > 100 || (scene.popouts || []).length > 50) issues.push(`Too many elements for ${scene.id}`);
    for (const key of ['headlineSize', 'subheadlineSize']) range(scene.text?.[key], 8, 600, key);
    range(scene.text?.lineHeight, 50, 300, 'line height');
    range(scene.background?.noiseIntensity, 0, 100, 'noise intensity');
    range(scene.background?.imageBlur, 0, 300, 'background blur');
    if (scene.devices && ids(scene.devices).size !== scene.devices.length) issues.push(`Duplicate device IDs in ${scene.id}`);
  }
  return { valid: !issues.length, issues, errors: issues };
}
export function assertCampaign(doc) {
  const result = validateCampaign(doc);
  if (!result.valid) throw new CampaignError('Invalid campaign document', 'INVALID_CAMPAIGN', 400, result.issues);
  return doc;
}

function addLayout(doc, template, count) {
  const layouts = template.type === 'sequence' ? template.scenes : [template];
  const appearance = { id: uid('appearance'), ...pick(merge(DEFAULT_DEVICE, layouts[0].devices?.[0] || {}), appearanceKeys) };
  doc.appearanceGroups.push(appearance);
  const groupBySourceScene = new Map();
  for (let index = 0; index < count; index++) {
    let layout = clone(layouts[Math.min(index, layouts.length - 1)]);
    if (index >= layouts.length && template.type === 'sequence') {
      const cycle = layouts.at(-1).devices.find(device => device.continueToNext)?.continuationCycle || [];
      const current = cycle[index % (cycle.length || 1)] || layouts[0].devices.at(-1);
      layout = { ...clone(layouts[index % layouts.length]), devices: [{ ...clone(layouts[0].devices[0]), ...clone(current), sourceOffset: 0 }] };
      const prior = doc.deviceGroups.find(group => group.id === groupBySourceScene.get(index - 1));
      if (prior) layout.devices.unshift({ ...prior.geometry, centerX: prior.geometry.centerX - index, sourceOffset: -1 });
    }
    const source = doc.sources[index % doc.sources.length];
    const scene = { id: uid('scene'), name: `Screen ${index + 1}`, sourceId: source.id, background: merge(DEFAULT_BACKGROUND, layout.background), screenshot: merge(DEFAULT_DEVICE, pick(appearance, appearanceKeys)), text: merge(DEFAULT_TEXT, layout.text), devices: [], elements: (layout.shapes || []).map(shape => ({ ...clone(shape), id: uid('element'), type: 'shape', shapeType: shape.type, name: shape.type })), popouts: (layout.popouts || []).map(popout => ({ ...clone(popout), id: uid('popout'), templatePopout: true })), locks: {} };
    scene.text.currentHeadlineLang = scene.text.currentSubheadlineLang = doc.locale;
    scene.text.headlines = { [doc.locale]: '' }; scene.text.subheadlines = { [doc.locale]: '' };
    for (const device of layout.devices || [DEFAULT_DEVICE]) {
      const sourceIndex = Math.max(0, index + (device.sourceOffset || 0));
      let group = doc.deviceGroups.find(item => item.id === groupBySourceScene.get(sourceIndex));
      if (!group || !(device.sourceOffset < 0)) {
        const settings = merge(DEFAULT_DEVICE, device);
        group = { id: uid('device'), sourceId: doc.sources[sourceIndex % doc.sources.length].id, appearanceGroupId: appearance.id, geometry: pick(settings, geometryKeys), seamLocked: template.type === 'sequence', locks: {} };
        if (group.geometry.positionMode === 'canvas') group.geometry.centerX += index;
        doc.deviceGroups.push(group);
        if ((device.sourceOffset || 0) === 0) groupBySourceScene.set(index, group.id);
      }
      scene.devices.push({ id: uid('placement'), groupId: group.id, name: `Device ${scene.devices.length + 1}` });
    }
    doc.scenes.push(scene);
  }
}

export function createCampaign({ id = uid('campaign'), name = 'Untitled campaign', assets = [], brief = {}, templateId, templateMode = 'auto', screenCount, profile = DEFAULT_PROFILE, locale = 'en' } = {}) {
  if (!['auto', 'exact', 'inspiration'].includes(templateMode)) throw new CampaignError('Unknown template mode');
  if (!assets.length) throw new CampaignError('Upload at least one real screenshot before designing', 'SOURCES_REQUIRED');
  const selectedTemplate = templateId || (screenCount >= 3 || assets.length >= 3 ? 'tidal-relay' : 'lavender-stage-top');
  const template = getTemplate(selectedTemplate);
  if (!template) throw new CampaignError('Template not found', 'TEMPLATE_NOT_FOUND', 404);
  if (!template.cloudCompatible) throw new CampaignError(cloudSupportMessage(template), 'UNSUPPORTED_TEMPLATE', 422, template.cloudLimitations);
  const count = screenCount ?? Math.min(8, assets.length);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new CampaignError('Choose between 1 and 30 screens');
  const doc = { schemaVersion: SCHEMA_VERSION, rendererVersion: 1, id, name, revision: 0, profile: clone(profile), locale, locales: [locale], brief: clone(brief), template: { id: template.id, version: template.version, mode: templateMode }, locks: {}, sources: assets.map(asset => ({ id: asset.sourceId || uid('source'), assetId: asset.assetId || asset.id, name: asset.name || 'Screenshot', width: asset.width, height: asset.height, localizedAssets: clone(asset.localizedAssets || {}) })), scenes: [], deviceGroups: [], appearanceGroups: [], seed: 1729 };
  addLayout(doc, template, count);
  return assertCampaign(stripRuntimeMedia(doc));
}

export function resolveDevice(doc, sceneId, deviceId) {
  const index = doc.scenes.findIndex(scene => scene.id === sceneId);
  const scene = doc.scenes[index];
  const placement = scene?.devices.find(device => device.id === deviceId);
  const group = doc.deviceGroups.find(item => item.id === placement?.groupId);
  if (!group) throw new CampaignError('Device not found', 'NOT_FOUND', 404);
  const appearance = doc.appearanceGroups.find(item => item.id === group.appearanceGroupId);
  const geometry = clone(group.geometry);
  if (geometry.positionMode === 'canvas') geometry.centerX -= index;
  return { ...pick(scene.screenshot, Object.keys(DEFAULT_DEVICE)), ...geometry, ...pick(appearance, appearanceKeys), id: placement.id, name: placement.name, sourceId: group.sourceId, groupId: group.id, appearanceGroupId: appearance.id, seamLocked: group.seamLocked, hidden: placement.hidden ?? geometry.hidden ?? false };
}

function guardLocks(doc, scene, group, keys, respectLocks) {
  if (!respectLocks) return;
  const locks = [doc.locks, scene?.locks, group?.locks].filter(Boolean);
  const categories = new Set(keys);
  if (keys.some(key => geometryKeys.includes(key))) categories.add('positions');
  if (keys.some(key => /color|solid|gradient|fill/i.test(key))) categories.add('colors');
  if (keys.some(key => /font|size|weight|lineHeight|align/i.test(key))) categories.add('typography');
  if (keys.some(key => appearanceKeys.includes(key))) categories.add('appearance');
  if (keys.some(key => ['seamLocked', 'connections', 'overflow'].includes(key))) categories.add('overflow');
  if (doc.template?.mode === 'exact' && (categories.has('positions') || categories.has('template') || categories.has('overflow'))) throw new CampaignError('The exact template layout is locked. Change to inspiration mode to move devices.', 'LOCKED', 409);
  if (locks.some(lock => lock.all || [...categories].some(key => lock[key]))) throw new CampaignError('This property is locked', 'LOCKED', 409);
}

export function applyOperations(document, operations, { respectLocks = true, expectedRevision } = {}) {
  assertCampaign(document);
  if (expectedRevision !== undefined && expectedRevision !== document.revision) throw new CampaignError('The campaign changed. Reload the latest revision before applying edits.', 'REVISION_CONFLICT', 409);
  if (!Array.isArray(operations) || operations.length > 200) throw new CampaignError('Provide up to 200 operations');
  const doc = clone(document);
  for (const operation of operations) {
    assertJson(operation);
    const op = operation.op || operation.type;
    const scene = doc.scenes.find(item => item.id === operation.sceneId);
    const patch = operation.patch || {};
    if (op === 'set_locks') {
      const target = operation.deviceId ? doc.deviceGroups.find(item => item.id === resolveDevice(doc, operation.sceneId, operation.deviceId).groupId) : operation.sceneId ? scene : doc;
      if (!target) throw new CampaignError('Lock target not found', 'NOT_FOUND', 404);
      target.locks = merge(target.locks, patch); continue;
    }
    if (op === 'set_template_mode') {
      if (!['auto', 'exact', 'inspiration'].includes(operation.mode)) throw new CampaignError('Invalid template mode');
      guardLocks(doc, null, null, ['templateMode'], respectLocks); doc.template.mode = operation.mode; continue;
    }
    if (op === 'update_campaign') {
      for (const key of Object.keys(patch)) if (!['name', 'brief', 'locale', 'locales'].includes(key)) throw new CampaignError(`Cannot update campaign ${key}`);
      guardLocks(doc, null, null, Object.keys(patch), respectLocks); Object.assign(doc, merge(pick(doc, Object.keys(patch)), patch)); continue;
    }
    if (op === 'add_source') {
      guardLocks(doc, null, null, ['sources'], respectLocks);
      if (!operation.assetId) throw new CampaignError('Source needs an uploaded asset');
      doc.sources.push({ id: operation.sourceId || uid('source'), assetId: operation.assetId, name: operation.name || 'Screenshot', localizedAssets: clone(operation.localizedAssets || {}) }); continue;
    }
    if (op === 'add_scene') {
      guardLocks(doc, null, null, ['scenes', 'positions'], respectLocks);
      if (!doc.sources.some(source => source.id === operation.sourceId)) throw new CampaignError('Choose an existing source');
      const previous = doc.scenes.at(-1), index = doc.scenes.length;
      const template = getTemplate(doc.template.id);
      const layouts = template?.scenes || [];
      const layout = layouts[index % (layouts.length || 1)] || template || {};
      const previousGroup = doc.deviceGroups.find(group => group.id === previous?.devices.at(-1)?.groupId);
      const newScene = { id: uid('scene'), name: operation.name || `Screen ${index + 1}`, sourceId: operation.sourceId, background: clone(previous?.background || DEFAULT_BACKGROUND), screenshot: clone(previous?.screenshot || DEFAULT_DEVICE), text: merge(previous?.text || DEFAULT_TEXT, { headlines: { [doc.locale]: '' }, subheadlines: { [doc.locale]: '' } }), devices: [], elements: clone(previous?.elements || []).map(element => ({ ...element, id: uid('element') })), popouts: [], locks: {} };
      if (previousGroup?.seamLocked) newScene.devices.push({ id: uid('placement'), groupId: previousGroup.id, name: 'Incoming device' });
      const settings = merge(DEFAULT_DEVICE, layout.devices?.find(device => (device.sourceOffset || 0) === 0) || {});
      const group = { id: uid('device'), sourceId: operation.sourceId, appearanceGroupId: previousGroup?.appearanceGroupId || doc.appearanceGroups[0].id, geometry: pick(settings, geometryKeys), seamLocked: template?.type === 'sequence', locks: {} };
      if (group.geometry.positionMode === 'canvas') group.geometry.centerX += index;
      doc.deviceGroups.push(group); newScene.devices.push({ id: uid('placement'), groupId: group.id, name: 'Primary device' });
      doc.scenes.push(newScene); continue;
    }
    if (op === 'apply_template') {
      guardLocks(doc, null, null, ['template', 'positions', 'colors', 'typography'], respectLocks);
      for (const existing of doc.scenes) guardLocks(doc, existing, null, ['template', 'positions', 'colors', 'typography'], respectLocks);
      const template = getTemplate(operation.templateId);
      if (!template) throw new CampaignError('Template not found', 'NOT_FOUND', 404);
      if (!template.cloudCompatible) throw new CampaignError(cloudSupportMessage(template), 'UNSUPPORTED_TEMPLATE', 422, template.cloudLimitations);
      const oldScenes = doc.scenes; doc.scenes = []; doc.deviceGroups = []; doc.appearanceGroups = [];
      addLayout(doc, template, oldScenes.length);
      doc.scenes.forEach((item, index) => { item.id = oldScenes[index].id; item.sourceId = oldScenes[index].sourceId; item.name = oldScenes[index].name; item.locks = oldScenes[index].locks; item.text.headlines = oldScenes[index].text.headlines; item.text.subheadlines = oldScenes[index].text.subheadlines; });
      doc.template = { id: template.id, version: template.version, mode: operation.mode || doc.template.mode }; continue;
    }
    if (op === 'reorder_scenes') {
      guardLocks(doc, null, null, ['order', 'positions'], respectLocks);
      if (!Array.isArray(operation.sceneIds) || new Set(operation.sceneIds).size !== doc.scenes.length || operation.sceneIds.some(id => !doc.scenes.some(s => s.id === id))) throw new CampaignError('Reorder must include every scene exactly once');
      // Keep each canonical placement attached to its first owning screen. Connected groups remain continuous.
      const origins = new Map(doc.deviceGroups.map(group => [group.id, doc.scenes.findIndex(s => s.devices.some(d => d.groupId === group.id))]));
      const old = doc.scenes; doc.scenes = operation.sceneIds.map(id => old.find(s => s.id === id));
      for (const group of doc.deviceGroups) if (group.geometry.positionMode === 'canvas') {
        const oldIndex = origins.get(group.id), originId = old[oldIndex]?.id, nextIndex = doc.scenes.findIndex(s => s.id === originId);
        group.geometry.centerX += nextIndex - oldIndex;
        if (group.seamLocked) {
          const placements = old.flatMap((s, index) => s.devices.filter(d => d.groupId === group.id).map(d => ({ placement: clone(d), offset: index - oldIndex })));
          for (const s of doc.scenes) s.devices = s.devices.filter(d => d.groupId !== group.id);
          for (const { placement, offset } of placements) if (doc.scenes[nextIndex + offset]) doc.scenes[nextIndex + offset].devices.push(placement);
        }
      }
      continue;
    }
    if (!scene) throw new CampaignError('Scene not found', 'NOT_FOUND', 404);
    if (op === 'update_scene') {
      for (const key of Object.keys(patch)) if (!['name', 'sourceId'].includes(key)) throw new CampaignError(`Cannot update scene ${key}`);
      guardLocks(doc, scene, null, Object.keys(patch), respectLocks); Object.assign(scene, patch); continue;
    }
    if (op === 'update_device') {
      for (const key of Object.keys(patch)) if (![...geometryKeys, 'sourceId', 'name', 'seamLocked'].includes(key)) throw new CampaignError(`Unsupported device property ${key}`);
      const device = resolveDevice(doc, scene.id, operation.deviceId), group = doc.deviceGroups.find(item => item.id === device.groupId);
      guardLocks(doc, scene, group, Object.keys(patch), respectLocks);
      if (group.seamLocked) for (const linked of doc.scenes.filter(s => s.devices.some(d => d.groupId === group.id))) guardLocks(doc, linked, group, Object.keys(patch), respectLocks);
      const geometry = pick(patch, geometryKeys);
      if (geometry.centerX !== undefined && (geometry.positionMode || group.geometry.positionMode) === 'canvas') geometry.centerX += doc.scenes.indexOf(scene);
      group.geometry = merge(group.geometry, geometry);
      if (patch.sourceId) group.sourceId = patch.sourceId;
      if (patch.name) scene.devices.find(d => d.id === operation.deviceId).name = patch.name;
      if (patch.seamLocked === false && group.seamLocked) {
        const otherPlacements = doc.scenes.flatMap((s, index) => s.devices.filter(d => d.groupId === group.id && d.id !== operation.deviceId).map(d => ({ s, d, index })));
        for (const { d } of otherPlacements) { const detached = clone(group); detached.id = uid('device'); detached.seamLocked = false; doc.deviceGroups.push(detached); d.groupId = detached.id; }
      }
      if (patch.seamLocked !== undefined) group.seamLocked = patch.seamLocked;
      continue;
    }
    if (op === 'update_appearance') {
      for (const key of Object.keys(patch)) if (!appearanceKeys.includes(key)) throw new CampaignError(`Unsupported appearance ${key}`);
      const device = resolveDevice(doc, scene.id, operation.deviceId || scene.devices[0]?.id);
      const appearance = doc.appearanceGroups.find(item => item.id === device.appearanceGroupId);
      for (const affected of doc.scenes.filter(s => s.devices.some(d => doc.deviceGroups.find(g => g.id === d.groupId)?.appearanceGroupId === appearance.id))) guardLocks(doc, affected, null, [...allKeys(patch), 'appearance'], respectLocks);
      Object.assign(appearance, merge(appearance, patch)); continue;
    }
    if (['update_text', 'update_background'].includes(op)) {
      const key = op === 'update_text' ? 'text' : 'background';
      guardLocks(doc, scene, null, [key, ...allKeys(patch)], respectLocks); scene[key] = merge(scene[key], patch); continue;
    }
    if (['add_device', 'duplicate_device', 'remove_device'].includes(op)) {
      guardLocks(doc, scene, null, ['positions', 'devices'], respectLocks);
      if (op === 'remove_device') { if (!scene.devices.some(d => d.id === operation.deviceId)) throw new CampaignError('Device not found'); scene.devices = scene.devices.filter(d => d.id !== operation.deviceId); continue; }
      const model = op === 'duplicate_device' ? resolveDevice(doc, scene.id, operation.deviceId) : merge(DEFAULT_DEVICE, patch);
      const group = { id: uid('device'), sourceId: operation.sourceId || model.sourceId || scene.sourceId, appearanceGroupId: model.appearanceGroupId || doc.deviceGroups.find(g => g.id === scene.devices[0]?.groupId)?.appearanceGroupId || doc.appearanceGroups[0].id, geometry: pick(model, geometryKeys), locks: {}, seamLocked: false };
      if (group.geometry.positionMode === 'canvas') group.geometry.centerX += doc.scenes.indexOf(scene);
      doc.deviceGroups.push(group); scene.devices.push({ id: uid('placement'), groupId: group.id, name: operation.name || 'New device' }); continue;
    }
    if (['add_element', 'update_element', 'remove_element', 'add_popout', 'update_popout', 'remove_popout'].includes(op)) {
      const key = op.endsWith('popout') ? 'popouts' : 'elements'; guardLocks(doc, scene, null, [key, ...Object.keys(patch)], respectLocks);
      if (op.startsWith('add_')) scene[key].push({ ...clone(patch), id: uid(key === 'elements' ? 'element' : 'popout') });
      else { const index = scene[key].findIndex(item => item.id === (operation.elementId || operation.popoutId)); if (index < 0) throw new CampaignError('Element not found'); if (op.startsWith('remove_')) scene[key].splice(index, 1); else scene[key][index] = merge(scene[key][index], patch); }
      continue;
    }
    throw new CampaignError(`Unsupported operation ${op}`);
  }
  const used = new Set(doc.scenes.flatMap(s => s.devices.map(d => d.groupId)));
  doc.deviceGroups = doc.deviceGroups.filter(g => used.has(g.id));
  doc.revision = document.revision + 1;
  return assertCampaign(stripRuntimeMedia(doc));
}

// Conversion returns serializable editor state. Image decoding belongs to the browser bridge.
export async function toLegacyState(doc, assetResolver = async id => id) {
  assertCampaign(doc);
  const sourceData = new Map();
  await Promise.all(doc.sources.map(async source => {
    const localizedImages = {};
    for (const [locale, assetId] of Object.entries({ [doc.locale]: source.assetId, ...source.localizedAssets })) localizedImages[locale] = { src: await assetResolver(assetId), name: source.name, assetId };
    sourceData.set(source.id, localizedImages);
  }));
  const screenshots = await Promise.all(doc.scenes.map(async scene => {
    const localizedImages = sourceData.get(scene.sourceId);
    const source = doc.sources.find(s => s.id === scene.sourceId);
    const devices = scene.devices.map(placement => {
      const device = resolveDevice(doc, scene.id, placement.id);
      const sourceScene = doc.scenes.find(s => s.sourceId === device.sourceId);
      return { ...device, sourceScreenshotId: sourceScene?.id, sourceAssetId: doc.sources.find(s => s.id === device.sourceId)?.assetId, placementLinkId: device.seamLocked ? device.groupId : undefined, deviceStyleGroupId: device.appearanceGroupId, sourceOffset: 0 };
    });
    const screenshot = merge(scene.screenshot, devices.length ? pick(devices[0], appearanceKeys) : {});
    const background = clone(scene.background);
    if (background.assetId) background.imageSrc = await assetResolver(background.assetId);
    const elements = await Promise.all(scene.elements.map(async el => ({ ...clone(el), ...(el.assetId ? { src: await assetResolver(el.assetId) } : {}) })));
    return { ...clone(scene), name: scene.name || source.name, src: localizedImages[doc.locale]?.src || '', localizedImages, screenshot, background, elements, devices, overrides: { background: true, screenshot: true, text: true } };
  }));
  return { id: doc.id, cloudDocument: clone(doc), formatVersion: 2, screenshots, selectedIndex: 0, outputDevice: doc.profile.id, customWidth: doc.profile.width, customHeight: doc.profile.height, currentLanguage: doc.locale, projectLanguages: doc.locales || [doc.locale], defaults: { background: clone(DEFAULT_BACKGROUND), screenshot: clone(DEFAULT_DEVICE), text: clone(DEFAULT_TEXT), elements: [], popouts: [] } };
}

export function fromLegacyState(state, { id = state.id || uid('campaign'), name = 'Untitled campaign', assetMap = {}, baseDocument = state.cloudDocument } = {}) {
  const lookup = (src, fallback) => src ? (assetMap instanceof Map ? assetMap.get(src) : assetMap[src]) : fallback;
  const doc = baseDocument ? clone(baseDocument) : { schemaVersion: SCHEMA_VERSION, rendererVersion: 1, id, name, revision: 0, template: { id: 'custom', mode: 'inspiration' }, locks: {}, brief: {}, seed: 1729 };
  doc.id = id; doc.name = name; doc.profile = { id: state.outputDevice || DEFAULT_PROFILE.id, width: state.customWidth || DEFAULT_PROFILE.width, height: state.customHeight || DEFAULT_PROFILE.height }; doc.locale = state.currentLanguage || 'en'; doc.locales = state.projectLanguages || [doc.locale];
  const existingSources = new Map((doc.sources || []).map(source => [source.id, source]));
  doc.sources = []; doc.scenes = []; doc.deviceGroups = []; doc.appearanceGroups = [];
  const sourceByScreen = new Map();
  for (const screenshot of state.screenshots) {
    const old = existingSources.get(screenshot.sourceId);
    const localizedAssets = {};
    for (const [locale, image] of Object.entries(screenshot.localizedImages || {})) { const assetId = lookup(`${screenshot.id}:${locale}`) || lookup(image.src, image.assetId || old?.localizedAssets?.[locale]); if (assetId) localizedAssets[locale] = assetId; }
    const assetId = localizedAssets[doc.locale] || lookup(screenshot.src || screenshot.image?.src, old?.assetId);
    if (!assetId) throw new CampaignError('Upload local images before saving this project to the cloud', 'UNUPLOADED_ASSET');
    const source = { ...old, id: old && old.assetId !== assetId ? uid('source') : screenshot.sourceId || uid('source'), assetId, name: old?.name || screenshot.name, localizedAssets };
    if (!doc.sources.some(item => item.id === source.id)) doc.sources.push(source);
    sourceByScreen.set(screenshot.id, source.id);
  }
  // Keep source assets not assigned to a scene: an independent device can still reference them.
  for (const source of existingSources.values()) if (!doc.sources.some(item => item.id === source.id)) doc.sources.push(source);
  const sanitizeMedia = object => {
    const result = clone(Object.fromEntries(Object.entries(object || {}).filter(([key]) => key !== 'image')));
    const src = result.imageSrc || result.src;
    if (src) { result.assetId = lookup(src, result.assetId); if (!result.assetId) throw new CampaignError('Upload decorative images before cloud saving', 'UNUPLOADED_ASSET'); }
    delete result.src; delete result.imageSrc; return result;
  };
  state.screenshots.forEach((screenshot, index) => {
    const baseSettings = merge(DEFAULT_DEVICE, screenshot.screenshot);
    const appearanceId = screenshot.devices?.[0]?.deviceStyleGroupId || screenshot.screenshot?.deviceStyleGroupId || `appearance_${screenshot.id}`;
    if (!doc.appearanceGroups.some(item => item.id === appearanceId)) doc.appearanceGroups.push({ id: appearanceId, ...pick(baseSettings, appearanceKeys) });
    const devices = (screenshot.devices?.length ? screenshot.devices : [{ ...baseSettings, id: `device_${screenshot.id}` }]).map(device => {
      const groupId = device.seamLocked !== false && device.placementLinkId ? device.placementLinkId : device.groupId || `group_${device.id}`;
      if (!doc.deviceGroups.some(item => item.id === groupId)) {
        const geometry = pick(merge(baseSettings, device), geometryKeys); if (geometry.positionMode === 'canvas') geometry.centerX += index;
    const sourceId = sourceByScreen.get(device.sourceScreenshotId) || device.sourceId || sourceByScreen.get(state.screenshots[index + (device.sourceOffset || 0)]?.id) || sourceByScreen.get(screenshot.id);
        const prior = baseDocument?.deviceGroups?.find(g => g.id === groupId);
        doc.deviceGroups.push({ id: groupId, sourceId, appearanceGroupId: appearanceId, geometry, seamLocked: !!device.placementLinkId && device.seamLocked !== false, locks: clone(prior?.locks || {}) });
      }
      return { id: device.id || uid('placement'), name: device.name || 'Device', groupId, hidden: device.hidden || false };
    });
    doc.scenes.push({ id: screenshot.id, name: screenshot.name, sourceId: sourceByScreen.get(screenshot.id), background: sanitizeMedia(screenshot.background), screenshot: baseSettings, text: clone(screenshot.text), elements: (screenshot.elements || []).map(sanitizeMedia), popouts: clone(screenshot.popouts || []), devices, locks: clone(screenshot.locks || {}) });
  });
  return assertCampaign(doc);
}

export { listTemplates };

export function assertDocumentEditAllowed(before, after, { allowLockChanges = false } = {}) {
  assertCampaign(before); assertCampaign(after);
  // JSONB storage can reorder object keys. Compare values semantically so an
  // unchanged shadow/frame cannot look like a geometry edit after an editor save.
  const same = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length && a.every((value, index) => same(value, b[index]));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  };
  const differences = (a, b) => Object.keys({ ...a, ...b }).filter(key => !same(a?.[key], b?.[key]));
  const changedKeys = (a, b, ignoreIds = false) => {
    const keys = [];
    for (const key of differences(a, b)) {
      if (ignoreIds && key === 'id') continue;
      if (a?.[key] && b?.[key] && typeof a[key] === 'object' && typeof b[key] === 'object') { const nested = changedKeys(a[key], b[key], ignoreIds); if (nested.length) keys.push(key, ...nested); }
      else keys.push(key);
    }
    return keys;
  };
  if (before.id !== after.id) throw new CampaignError('A revision cannot change project identity');
  if (!allowLockChanges && (!same(before.locks, after.locks) || before.template.mode !== after.template.mode)) throw new CampaignError('Use the explicit lock/template-mode operation to change constraints', 'LOCKED', 409);
  if (before.template.id !== after.template.id) guardLocks(before, null, null, ['template', 'positions', 'colors', 'typography'], true);
  const completeRegeneration = before.scenes.length === after.scenes.length && before.template.id === after.template.id && before.scenes.every(scene => !after.scenes.some(item => item.id === scene.id));
  const groupMapping = new Map(), reverseGroupMapping = new Map();
  if (!completeRegeneration && !same(before.scenes.map(s => s.id), after.scenes.map(s => s.id))) guardLocks(before, null, null, ['order', 'positions'], true);
  for (const [sceneIndex, prior] of before.scenes.entries()) {
    const next = after.scenes.find(scene => scene.id === prior.id) || (completeRegeneration ? after.scenes[sceneIndex] : null);
    if (!next) { guardLocks(before, prior, null, ['all', 'positions', 'text', 'colors', 'typography', 'devices'], true); continue; }
    if (!allowLockChanges && !same(prior.locks, next.locks)) throw new CampaignError('Use the explicit lock operation', 'LOCKED', 409);
    for (const key of ['text', 'background', 'elements', 'popouts']) if (!same(prior[key], next[key])) {
      const changed = changedKeys(prior[key], next[key], completeRegeneration && ['elements', 'popouts'].includes(key));
      if (changed.length) guardLocks(before, prior, null, [key, ...changed], true);
    }
    if (prior.sourceId !== next.sourceId) guardLocks(before, prior, null, ['sourceId', 'sources'], true);
    if (prior.devices.length !== next.devices.length || (!completeRegeneration && !same(prior.devices.map(d => d.id), next.devices.map(d => d.id)))) guardLocks(before, prior, null, ['positions', 'devices'], true);
    for (const [deviceIndex, placement] of prior.devices.entries()) {
      const oldDevice = resolveDevice(before, prior.id, placement.id), group = before.deviceGroups.find(g => g.id === placement.groupId);
      const nextPlacement = next.devices.find(d => d.id === placement.id) || (completeRegeneration ? next.devices[deviceIndex] : null);
      if (!nextPlacement) { guardLocks(before, prior, group, ['positions', 'devices'], true); continue; }
      const newDevice = resolveDevice(after, next.id, nextPlacement.id);
      if ((groupMapping.has(oldDevice.groupId) && groupMapping.get(oldDevice.groupId) !== newDevice.groupId) || (reverseGroupMapping.has(newDevice.groupId) && reverseGroupMapping.get(newDevice.groupId) !== oldDevice.groupId)) guardLocks(before, prior, group, ['overflow', 'connections'], true);
      groupMapping.set(oldDevice.groupId, newDevice.groupId); reverseGroupMapping.set(newDevice.groupId, oldDevice.groupId);
      if (!allowLockChanges && !same(group.locks, after.deviceGroups.find(g => g.id === newDevice.groupId)?.locks)) throw new CampaignError('Use the explicit lock operation', 'LOCKED', 409);
      const changed = differences(oldDevice, newDevice).filter(key => !['id', 'groupId', 'appearanceGroupId', 'name'].includes(key));
      if (changed.length) guardLocks(before, prior, group, [...changed, ...allKeys(pick(newDevice, changed))], true);
    }
  }
  return after;
}

export function applyTemplate(document, templateId, { mode = document.template?.mode || 'inspiration', sourceIds, sceneCount = document.scenes.length, respectLocks = true } = {}) {
  if (sceneCount !== document.scenes.length || sourceIds) {
    guardLocks(document, null, null, ['template', 'positions'], respectLocks);
    for (const scene of document.scenes) guardLocks(document, scene, null, ['template', 'positions'], respectLocks);
    const sources = sourceIds ? sourceIds.map(id => document.sources.find(source => source.id === id)) : document.sources;
    if (sources.some(source => !source)) throw new CampaignError('Unknown source');
    const result = createCampaign({ ...document, assets: sources.map(source => ({ ...source, sourceId: source.id })), templateId, templateMode: mode, screenCount: sceneCount });
    result.revision = document.revision + 1; result.locks = clone(document.locks); result.sources = clone(document.sources);
    return result;
  }
  return applyOperations(document, [{ op: 'apply_template', templateId, mode }], { respectLocks });
}
