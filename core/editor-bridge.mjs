import { fromLegacyState, toLegacyState, assertCampaign, CampaignError } from './campaign.mjs';
import { renderLegacyScene, ensureRenderResources, loadImage } from './render.mjs';

const urls = new Map(), assetIds = new Map(), sourceImages = new Map();
let baseline = null, suppressChanges = 0, changeTimer, lastSnapshot = '';
const runtime = window.AppScreenEditorRuntime;
if (!runtime) throw new Error('The editor runtime must load before its cloud bridge');
function snapshot() { return runtime.snapshot(); }
function remember(src, assetId) { if (src && assetId) { assetIds.set(src, assetId); urls.set(assetId, src); } }
function imageReference(src, name, kind, extra = {}) { return { src, name, kind, assetId: assetIds.get(src) || null, ...extra }; }

export const bridge = {
  ready: true,
  get currentDocument() { return baseline ? structuredClone(baseline) : null; },
  getAssetReferences() {
    const result = [];
    for (const scene of snapshot().screenshots) {
      for (const [locale, image] of Object.entries(scene.localizedImages || {})) if (image.src) result.push(imageReference(image.src, image.name || scene.name, 'source', { sceneId: scene.id, locale, assetId: image.assetId || assetIds.get(image.src) || null }));
      if (!(scene.localizedImages && Object.keys(scene.localizedImages).length) && (scene.src || scene.image?.src)) result.push(imageReference(scene.src || scene.image.src, scene.name, 'source', { sceneId: scene.id }));
      if (scene.background?.imageSrc) result.push(imageReference(scene.background.imageSrc, `${scene.name} background`, 'background', { sceneId: scene.id }));
      for (const element of scene.elements || []) if (element.src || element.image?.src) result.push(imageReference(element.src || element.image.src, element.name || 'Graphic', 'element', { sceneId: scene.id, elementId: element.id }));
    }
    return result;
  },
  registerAssets(map) {
    for (const [src, value] of (map instanceof Map ? map : new Map(Object.entries(map || {})))) remember(src, typeof value === 'string' ? value : value.id || value.assetId);
  },
  exportDocument({ assetMap, name } = {}) {
    if (assetMap) bridge.registerAssets(assetMap);
    const value = snapshot();
    const references = new Map(assetIds);
    for (const scene of value.screenshots) for (const [locale, image] of Object.entries(scene.localizedImages || {})) {
      if (image.assetId && urls.get(image.assetId) === image.src) references.set(`${scene.id}:${locale}`, image.assetId);
    }
    return fromLegacyState(value, { id: baseline?.id || value.id, name: name || baseline?.name || value.name, baseDocument: baseline, assetMap: references });
  },
  async importDocument(doc, { resolveAsset = async id => urls.get(id), expectedRevision, preserveSelection = false } = {}) {
    assertCampaign(doc);
    await runtime.ready;
    if (expectedRevision !== undefined && baseline && expectedRevision !== baseline.revision) throw new CampaignError('Editor revision changed', 'REVISION_CONFLICT', 409);
    const fingerprint = expectedRevision !== undefined && baseline?.id === doc.id ? JSON.stringify(bridge.exportDocument()) : null;
    const resolver = async assetId => {
      const result = await resolveAsset(assetId), src = typeof result === 'string' ? result : result?.url;
      if (!src) throw new Error(`Missing URL for asset ${assetId}`);
      remember(src, assetId); return src;
    };
    suppressChanges++;
    try {
      await ensureRenderResources(doc);
      const legacy = await toLegacyState(doc, resolver);
      await Promise.all(doc.sources.map(async source => {
        for (const [locale, assetId] of Object.entries({ [doc.locale]: source.assetId, ...source.localizedAssets })) sourceImages.set(`${source.id}:${locale}`, await loadImage(await resolver(assetId)));
      }));
      for (const scene of legacy.screenshots) {
        for (const localized of Object.values(scene.localizedImages)) localized.image = await loadImage(localized.src);
        scene.image = scene.localizedImages[doc.locale]?.image || Object.values(scene.localizedImages)[0]?.image;
        if (scene.background.imageSrc) scene.background.image = await loadImage(scene.background.imageSrc);
        for (const element of scene.elements) if (element.src) element.image = await loadImage(element.src);
      }
      if (fingerprint && JSON.stringify(bridge.exportDocument()) !== fingerprint) throw new CampaignError('The editor changed while this revision was loading. Your edits were preserved.', 'REVISION_CONFLICT', 409);
      baseline = structuredClone(doc);
      runtime.replace(legacy, { name: doc.name, preserveSelection });
      lastSnapshot = JSON.stringify(bridge.exportDocument());
      window.dispatchEvent(new CustomEvent('app-screen-document-loaded', { detail: { document: structuredClone(doc) } }));
      return doc;
    } finally { suppressChanges--; }
  },
  acknowledgeSave(document) {
    assertCampaign(document);
    if (snapshot().id !== document.id) return false;
    baseline = { ...(baseline || document), revision: document.revision, id: document.id };
    runtime.setCloudMetadata(baseline);
    return true;
  },
  getSourceImage(sourceId, locale) { return sourceImages.get(`${sourceId}:${locale}`) || sourceImages.get(`${sourceId}:${baseline?.locale || 'en'}`); },
  notifyChange() {
    if (suppressChanges || !baseline) return;
    if (snapshot().id !== baseline.id) {
      baseline = null; runtime.setCloudMetadata(null); clearTimeout(changeTimer);
      window.dispatchEvent(new Event('app-screen-document-detached'));
      return;
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      try {
        const document = bridge.exportDocument(), serialized = JSON.stringify(document);
        if (serialized === lastSnapshot) return;
        lastSnapshot = serialized;
        window.dispatchEvent(new CustomEvent('app-screen-document-change', { detail: { document } }));
      } catch (error) { window.dispatchEvent(new CustomEvent('app-screen-document-change', { detail: { error: { code: error.code, message: error.message }, needsUpload: error.code === 'UNUPLOADED_ASSET' } })); }
    }, 350);
  },
};

window.AppScreenSharedRender = { renderLegacyScene };
window.AppScreenCloudBridge = bridge;
window.dispatchEvent(new Event('app-screen-bridge-ready'));
