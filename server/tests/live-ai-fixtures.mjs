import sharp from 'sharp';
import { createCampaign, resolveDevice, validateCampaign } from '../../core/campaign.mjs';
import { LIVE_AI_FIXTURE_VERSION, canonicalJSON, requireCheck } from '../../deploy/live-ai-smoke-guards.mjs';

export const FIXTURE_PROFILE = Object.freeze({ id: 'iphone-6.9', width: 1320, height: 2868 });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuid = new RegExp(`^${UUID}$`, 'i');

export const FIXTURE_BRIEF = Object.freeze({
  appName: 'FocusBoard — synthetic evaluation',
  promise: 'Keep everyday tasks, projects and focus sessions in one simple planner.',
  audience: 'People who prefer a clear daily plan.', style: 'Elegant, calm and readable', brandColors: ['#78D8BB', '#162333'],
  confirmedFacts: ['This is a fictional synthetic task-planning app, not a real commercial product.', 'Today shows a task checklist.', 'Projects organize tasks into named groups.', 'Week shows scheduled tasks by day.', 'Focus shows a 25-minute session timer.', 'Progress shows completed tasks for this week.'],
});
const screens = [
  { title: 'Today', subtitle: 'A clear plan for your day', eyebrow: 'MONDAY, SEPTEMBER 7', metric: '3 tasks left', rows: ['Write a project outline', 'Review the launch checklist', 'Plan tomorrow'], footer: 'Today / Projects / Focus' },
  { title: 'Projects', subtitle: 'Keep related work together', eyebrow: 'YOUR WORKSPACE', metric: '4 projects', rows: ['Launch planning', 'Learning notes', 'Home projects', 'Personal goals'], footer: 'Today / Projects / Focus' },
  { title: 'This week', subtitle: 'Make room for what matters', eyebrow: 'WEEKLY PLAN', metric: 'Monday — Friday', rows: ['Monday / Write the outline', 'Tuesday / Review the draft', 'Wednesday / Make a plan', 'Friday / Weekly review'], footer: 'Today / Week / Progress' },
  { title: 'Focus', subtitle: 'One task at a time', eyebrow: 'FOCUS SESSION', metric: '25:00', rows: ['Write a project outline', 'Start focus session', 'Session length / 25 minutes'], footer: 'Today / Projects / Focus' },
  { title: 'Progress', subtitle: 'See the work you finished', eyebrow: 'YOUR WEEK', metric: '12 tasks completed', rows: ['Monday / 3 completed', 'Tuesday / 4 completed', 'Wednesday / 2 completed', 'Thursday / 3 completed'], footer: 'Today / Week / Progress' },
];
// Rebuilt from trusted code, not a writable preparation manifest or database
// hash. Only UUID identities vary; all text, fields, layout and asset metadata
// must match this factory before any credential may be read.
export function fixedManualDocument({ runId, projectId, assetIds }) {
  requireCheck(uuid.test(runId) && uuid.test(projectId) && assetIds.length === 5 && new Set(assetIds).size === 5 && assetIds.every(id => uuid.test(id)), 'FIXTURE_IDENTITIES_INVALID');
  const document = createCampaign({ id: projectId, name: `SYNTHETIC FocusBoard evaluation ${runId.slice(0, 8)}`, assets: assetIds.map((id, index) => ({ id, sourceId: id, name: `synthetic-focusboard-${index + 1}.png`, width: 1179, height: 2556 })), brief: FIXTURE_BRIEF, templateId: 'tidal-relay', templateMode: 'exact', screenCount: 5, profile: FIXTURE_PROFILE, locale: 'en' });
  const headlines = ['Plan your day', 'Projects', 'Make room for\nyour priorities', 'One task at a time', 'Progress'];
  document.scenes.forEach((scene, index) => { scene.text.headlines.en = headlines[index]; scene.text.headlineSize = scene.text.position === 'bottom' ? 72 : 92; scene.text.subheadlineEnabled = false; });
  return document;
}
export function normalizedFixtureDocument(document) {
  requireCheck(validateCampaign(document).valid, 'FIXTURE_DOCUMENT_INVALID');
  const result = structuredClone(document), identities = new Map();
  const register = (objects, prefix, label) => objects.forEach((object, index) => {
    requireCheck(new RegExp(`^${prefix}_${UUID}$`, 'i').test(object.id) && !identities.has(object.id), 'FIXTURE_IDENTITIES_INVALID');
    identities.set(object.id, `${label}-${index}`);
  });
  register(result.scenes, 'scene', 'scene');
  register(result.deviceGroups, 'device', 'group');
  register(result.appearanceGroups, 'appearance', 'appearance');
  result.scenes.forEach((scene, index) => { register(scene.devices, 'placement', `scene-${index}-placement`); register(scene.elements, 'element', `scene-${index}-element`); });
  const remap = value => {
    if (Array.isArray(value)) return value.map(remap);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ['id', 'groupId', 'appearanceGroupId'].includes(key) && identities.has(child) ? identities.get(child) : remap(child)]));
  };
  if ('revisionId' in result) { requireCheck(uuid.test(result.revisionId), 'FIXTURE_IDENTITIES_INVALID'); delete result.revisionId; }
  return remap(result);
}
export function assertFixedManualDocument(document, identities) {
  requireCheck(canonicalJSON(normalizedFixtureDocument(document)) === canonicalJSON(normalizedFixtureDocument(fixedManualDocument(identities))), 'NONFIXTURE_DOCUMENT_DENIED');
}
export function connectedFixtureGeometry(document) {
  const groups = new Map(document.deviceGroups.map((group, index) => [group.id, index]));
  const approvedSources = new Set(document.sources.map(source => source.id));
  const geometryKeys = ['positionMode', 'centerX', 'centerY', 'scale', 'x', 'y', 'rotation', 'perspective', 'opacity', 'hidden', 'crop', 'seamLocked'];
  const placements = document.scenes.map(scene => scene.devices.map(placement => {
    const device = resolveDevice(document, scene.id, placement.id);
    requireCheck(approvedSources.has(device.sourceId), 'NONFIXTURE_DEVICE_SOURCE_DENIED');
    return { group: groups.get(device.groupId), ...Object.fromEntries(geometryKeys.filter(key => device[key] !== undefined).map(key => [key, device[key]])) };
  }));
  const handoffs = document.scenes.flatMap((left, index) => {
    const right = document.scenes[index + 1]; if (!right) return [];
    return left.devices.flatMap(device => {
      const match = right.devices.find(next => next.groupId === device.groupId); if (!match) return [];
      const a = resolveDevice(document, left.id, device.id), b = resolveDevice(document, right.id, match.id);
      requireCheck(Math.abs(a.centerX - b.centerX - 1) < 1e-9, 'BROKEN_DEVICE_HANDOFF');
      for (const key of ['centerY', 'scale', 'rotation', 'sourceId', 'appearanceGroupId', 'frame']) requireCheck(canonicalJSON(a[key]) === canonicalJSON(b[key]), 'BROKEN_DEVICE_HANDOFF');
      return [{ left: index, right: index + 1, group: groups.get(a.groupId) }];
    });
  });
  return { placements, handoffs };
}
// Fixed code-native fixtures. No caller can inject text, paths, images or real
// screenshots. All typography/images are regenerated before a live admission.
export async function syntheticLiveAISources() {
  return Promise.all(screens.map(async (screen, index) => {
    const rows = screen.rows.map((line, row) => `<rect x="78" y="${780 + row * 255}" width="1023" height="194" rx="24" fill="#243749"/><rect x="114" y="${842 + row * 255}" width="54" height="54" rx="13" fill="${row === 0 ? '#78D8BB' : '#3F5A69'}"/><text x="208" y="${880 + row * 255}" font-size="43" fill="#F1F8F6">${line}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1179" height="2556"><rect width="1179" height="2556" fill="#162333"/><g font-family="sans-serif"><rect width="1179" height="134" fill="#78D8BB"/><text x="78" y="87" fill="#162333" font-size="38" font-weight="700">SYNTHETIC DEMO / FOCUSBOARD / ${index + 1}</text><text x="78" y="266" fill="#78D8BB" font-size="33" letter-spacing="2">${screen.eyebrow}</text><text x="78" y="420" fill="#F1F8F6" font-size="114" font-weight="700">${screen.title}</text><text x="78" y="505" fill="#BDCED4" font-size="43">${screen.subtitle}</text><rect x="78" y="572" width="1023" height="130" rx="28" fill="#36544E"/><text x="122" y="657" fill="#A9ECD7" font-size="${index === 3 ? 72 : 47}" font-weight="700">${screen.metric}</text>${rows}<text x="78" y="2228" fill="#BDCED4" font-size="34">Fictional interface for AI evaluation only</text><rect x="0" y="2320" width="1179" height="236" fill="#243749"/><text x="78" y="2400" fill="#BDCED4" font-size="38">${screen.footer}</text><rect x="406" y="2488" width="367" height="14" rx="7" fill="#BDCED4"/></g></svg>`;
    const bytes = await sharp(Buffer.from(svg)).flatten({ background: '#162333' }).removeAlpha().png().toBuffer();
    return { index: index + 1, name: `synthetic-focusboard-${index + 1}.png`, bytes, fixtureVersion: LIVE_AI_FIXTURE_VERSION, width: 1179, height: 2556 };
  }));
}
