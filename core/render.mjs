import { assertCampaign, resolveDevice, DEFAULT_TEXT, DEFAULT_DEVICE, toLegacyState } from './campaign.mjs';
import { drawBackgroundToContext, drawScreenshotToContext, drawTextToContext, drawElementsToContext, drawPopoutsToContext, laurelImages, wrapText } from './canvas-primitives.mjs';
import { getDeviceBounds, measureTextBounds, createTextDeviceInspector } from './layout-qa.mjs';
import { getCloudRenderSupport, cloudSupportMessage } from './cloud-support.mjs';
export { getDeviceBounds } from './layout-qa.mjs';

export const RENDERER_VERSION = 1;
const images = new Map();
let fontReady;

export function seededRandom(seed = 1729) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}
export function drawNoise(context, dims, intensity = 10, seed = 1729) {
  const pixels = context.getImageData(0, 0, dims.width, dims.height);
  const random = seededRandom(seed), amount = intensity / 100 * 50;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const delta = (random() - 0.5) * amount;
    for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = Math.max(0, Math.min(255, pixels.data[i + channel] + delta));
  }
  context.putImageData(pixels, 0, 0);
}

export async function loadImage(src) {
  if (src && typeof src !== 'string' && (src.width || src.naturalWidth)) return src;
  if (!src || typeof src !== 'string') throw new Error('Missing image source');
  if (!/^(https?:|data:image\/|blob:|\/)/.test(src)) throw new Error('Unsupported image URL');
  if (!images.has(src)) images.set(src, new Promise((resolve, reject) => {
    const image = new Image(); image.crossOrigin = 'anonymous';
    image.onload = () => image.decode().then(() => resolve(image), reject);
    image.onerror = () => { images.delete(src); reject(new Error('Image could not be decoded')); };
    image.src = src;
  }));
  return images.get(src);
}

export async function ensureRenderResources(doc) {
  if (!fontReady) fontReady = (async () => {
    const face = new FontFace('AppScreen Sans', 'url(/render/fonts/InterVariable.woff2)', { weight: '100 900', style: 'normal' });
    await face.load(); document.fonts.add(face);
    await Promise.all(['laurel-simple-left', 'laurel-detailed-left'].map(async key => { laurelImages[key] = await loadImage(`/img/${key}.svg`); }));
  })().catch(error => { fontReady = null; throw error; });
  await fontReady;
  const requests = new Set();
  for (const scene of doc.scenes || []) {
    const text = scene.text || {};
    for (const prefix of ['headline', 'subheadline']) requests.add(`${text[`${prefix}Italic`] ? 'italic ' : ''}${text[`${prefix}Weight`] || 400} ${text[`${prefix}Size`] || 50}px ${text[`${prefix}Font`] || 'AppScreen Sans'}`);
    for (const element of scene.elements || []) if (element.type === 'text') requests.add(`${element.fontWeight || 400} ${element.fontSize || 50}px ${element.font || 'AppScreen Sans'}`);
  }
  await Promise.all([...requests].map(font => document.fonts.load(font)));
  await document.fonts.ready;
}

function localizedText(scene, locale) {
  return { ...DEFAULT_TEXT, ...scene.text, currentHeadlineLang: locale, currentSubheadlineLang: locale, currentLayoutLang: locale };
}

// Synchronous composition is shared by the editor and export worker after resources decode.
export function renderLegacyScene(context, dims, scene, { locale = 'en', getImage = () => scene.image, seed = 1729, canonicalAppearance = false } = {}) {
  context.save(); context.clearRect(0, 0, dims.width, dims.height);
  const bg = scene.background;
  drawBackgroundToContext(context, dims, bg);
  if (bg.noise) drawNoise(context, dims, bg.noiseIntensity, seed);
  const elements = (scene.elements || []).map(el => ({ ...el, text: el.texts?.[locale] || el.texts?.en || el.text || '' }));
  drawElementsToContext(context, dims, elements, 'behind-screenshot');
  const settings = { ...DEFAULT_DEVICE, ...scene.screenshot };
  if (settings.use3D) throw new Error('3D scenes require the interactive 3D renderer and are not supported by this export worker');
  const devices = scene.devices?.length ? scene.devices : [{ ...settings, sourceId: scene.sourceId }];
  for (const device of devices) {
    if (device.hidden) continue;
    const image = getImage(device);
    if (!image) throw new Error(`Source image is missing for ${device.name || device.id || 'device'}`);
    context.save(); context.globalAlpha = (device.opacity ?? settings.opacity ?? 100) / 100;
    drawScreenshotToContext(context, dims, image, { ...settings, ...device, frame: canonicalAppearance ? device.frame || settings.frame : settings.frame, shadow: canonicalAppearance ? device.shadow || settings.shadow : settings.shadow, cornerRadius: canonicalAppearance ? device.cornerRadius ?? settings.cornerRadius : settings.cornerRadius });
    context.restore();
  }
  drawElementsToContext(context, dims, elements, 'above-screenshot');
  drawPopoutsToContext(context, dims, scene.popouts || [], getImage({ sourceId: scene.sourceId }), settings);
  drawTextToContext(context, dims, localizedText(scene, locale));
  drawElementsToContext(context, dims, elements, 'above-text');
  context.restore();
}

export async function renderScene(canvas, doc, sceneId, { resolveAsset, locale = doc.locale } = {}) {
  assertCampaign(doc);
  if (typeof resolveAsset !== 'function') throw new Error('An asset resolver is required');
  const scene = doc.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error('Scene not found');
  const resolvedDevices = scene.devices.map(device => resolveDevice(doc, sceneId, device.id));
  const support = getCloudRenderSupport({ ...scene, devices: resolvedDevices });
  if (!support.cloudCompatible) throw new Error(cloudSupportMessage(support));
  await ensureRenderResources(doc);
  const decoded = new Map();
  const loadAsset = async id => { if (!decoded.has(id)) decoded.set(id, await loadImage(await resolveAsset(id))); return decoded.get(id); };
  const neededSourceIds = new Set([scene.sourceId, ...scene.devices.map(device => resolveDevice(doc, sceneId, device.id).sourceId)]);
  const bySource = new Map();
  await Promise.all([...neededSourceIds].map(async id => {
    const source = doc.sources.find(item => item.id === id);
    bySource.set(id, await loadAsset(source.localizedAssets?.[locale] || source.assetId));
  }));
  const background = { ...scene.background };
  if (background.type === 'image') {
    if (!background.assetId) throw new Error('Background image is missing its asset reference');
    background.image = await loadAsset(background.assetId);
  }
  const elements = await Promise.all(scene.elements.map(async el => {
    const result = { ...el };
    if (el.assetId) result.image = await loadAsset(el.assetId);
    else if (el.type === 'icon' || el.type === 'graphic') throw new Error(`Element ${el.id} needs an uploaded image asset before cloud rendering`);
    return result;
  }));
  const hydrated = { ...scene, background, elements, devices: resolvedDevices };
  canvas.width = doc.profile.width; canvas.height = doc.profile.height;
  renderLegacyScene(canvas.getContext('2d'), doc.profile, hydrated, { locale, getImage: device => bySource.get(device.sourceId || scene.sourceId), seed: doc.seed || 1729, canonicalAppearance: true });
  return { sceneId, width: canvas.width, height: canvas.height, rendererVersion: RENDERER_VERSION, qa: inspectScene(canvas.getContext('2d'), doc, sceneId, bySource, locale) };
}

export function inspectScene(context, doc, sceneId, sources = new Map(), locale = doc.locale) {
  const scene = doc.scenes.find(item => item.id === sceneId), issues = [];
  const { width, height } = doc.profile;
  const text = localizedText(scene, locale);
  if (text.subheadlineOpacity <= 0) text.subheadlineEnabled = false;
  const layout = text.perLanguageLayout ? { ...text, ...text.languageSettings?.[locale] } : text;
  const maxWidth = width * ((text.blockWidth || 84) / 100);
  for (const prefix of ['headline', 'subheadline']) {
    if (text[`${prefix}Enabled`] === false || (prefix === 'subheadline' && !text.subheadlineEnabled)) continue;
    const copy = text[`${prefix}s`]?.[locale] || '';
    if (prefix === 'headline' && !copy.trim()) issues.push({ code: 'EMPTY_HEADLINE', severity: 'warning', sceneId, message: 'Add a benefit headline before publishing.' });
    if (/Enter Your Text|Lorem ipsum|Headline goes here/i.test(copy)) issues.push({ code: 'PLACEHOLDER_COPY', severity: 'error', sceneId, message: 'Placeholder text must be replaced.' });
    context.save(); context.font = `${text[`${prefix}Italic`] ? 'italic' : 'normal'} ${text[`${prefix}Weight`] || 400} ${layout[`${prefix}Size`] || 50}px ${text[`${prefix}Font`] || text.headlineFont || 'AppScreen Sans'}`;
    const words = copy.split(/\s+/), lines = wrapText(context, copy, maxWidth);
    if (words.some(word => context.measureText(word).width > maxWidth)) issues.push({ code: 'TEXT_OVERFLOW', severity: 'error', sceneId, message: `${prefix} has an unbreakable word wider than its text block.` });
    if (prefix === 'headline' && lines.length > 3) issues.push({ code: 'LONG_HEADLINE', severity: 'warning', sceneId, message: 'Headline wraps beyond three lines; shorten the copy or reduce size.' });
    // Actual rendered ink below determines clipping. Empty block margins and a
    // second approximation of bottom/multiline layout must not fail an export.
    context.restore();
  }
  const textBounds = measureTextBounds(context, doc.profile, text);
  for (const bounds of textBounds) if (bounds.left < 0 || bounds.top < 0 || bounds.right > width || bounds.bottom > height) issues.push({ code: 'TEXT_CLIPPED', severity: 'error', sceneId, message: 'Rendered text is clipped by the canvas edge.', bounds });
  const devices = scene.devices.map(placement => resolveDevice(doc, sceneId, placement.id));
  if (!devices.some(device => !device.hidden && (device.opacity ?? 100) > 0)) issues.push({ code: 'NO_VISIBLE_DEVICE', severity: 'error', sceneId, message: 'No device is visible.' });
  const inspector = createTextDeviceInspector(doc.profile, text, textBounds);
  try {
    for (const device of devices) {
      if (device.hidden || (device.opacity ?? 100) <= 0) continue;
      const image = sources.get(device.sourceId);
      if (image && (image.width < width * device.scale / 100 * 0.6)) issues.push({ code: 'LOW_RESOLUTION', severity: 'warning', sceneId, deviceId: device.id, message: 'This source may appear soft at export size.' });
      if (image) {
        const bounds = getDeviceBounds(doc.profile, image, device);
        if (bounds.right <= 0 || bounds.left >= width || bounds.bottom <= 0 || bounds.top >= height) issues.push({ code: 'DEVICE_OFF_CANVAS', severity: 'error', sceneId, deviceId: device.id, message: 'Device is outside the visible composition.', bounds });
        else if (inspector.overlaps(image, device, bounds)) issues.push({ code: 'TEXT_DEVICE_OVERLAP', severity: 'warning', sceneId, deviceId: device.id, message: 'Text touches the device or its border. Review whether the product and headline remain readable.' });
      }
    }
  } finally { inspector.dispose(); }
  return { passed: !issues.some(issue => issue.severity === 'error'), issues };
}
