import '../templates.js';
import { getCloudRenderSupport } from './cloud-support.mjs';

export const TEMPLATE_CATALOG_VERSION = globalThis.AppScreenTemplates.version;
export function listTemplates({ includeScenes = false } = {}) {
  return structuredClone(globalThis.AppScreenTemplates.templates).map(template => includeScenes ? { ...template, ...getCloudRenderSupport(template) } : {
    id: template.id, name: template.name, description: template.description || template.category,
    category: template.category, version: template.version, type: template.type || 'single',
    screenCount: template.screenCount || 1, palette: template.palette,
    ...getCloudRenderSupport(template),
    previewUrl: `/api/templates/${encodeURIComponent(template.id)}/preview`,
  });
}
export function getTemplate(id) {
  const template = globalThis.AppScreenTemplates.templates.find(item => item.id === id);
  return template ? { ...structuredClone(template), ...getCloudRenderSupport(template) } : null;
}
