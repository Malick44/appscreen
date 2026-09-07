import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import type { AppServices } from './services.js';
import { invariant } from './errors.js';

/** Shared traversal: localized captures and decorative layers belong in backups too. */
export function collectCampaignAssetIds(document: any): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && value) ids.add(value); };
  for (const source of document.sources || []) {
    add(source.assetId);
    for (const value of Object.values(source.localizedAssets || {})) {
      if (typeof value === 'string') add(value);
      else if (value && typeof value === 'object') add((value as any).assetId);
    }
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'assetId' || key === 'sourceAssetId') add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  for (const scene of document.scenes || []) visit(scene);
  return [...ids].sort();
}

export function isAllowedRenderRequest(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.search && (
      url.pathname === '/render/index.html' || url.pathname === '/templates.js' ||
      url.pathname === '/img/laurel-simple-left.svg' || url.pathname === '/img/laurel-detailed-left.svg' ||
      /^\/core\/[a-zA-Z0-9_-]+\.mjs$/.test(url.pathname) ||
      /^\/render\/fonts\/[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname)
    );
  } catch { return false; }
}

export function createRenderer(services: AppServices) {
  let browser: Browser | null = null;
  let starting: Promise<Browser> | null = null;
  return {
    async render(document: any, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
      invariant(document.scenes?.length > 0 && document.scenes.length <= 10, 'EXPORT_SCREEN_COUNT', 'Store campaigns must contain between one and ten screens.');
      if (!browser?.isConnected()) {
        starting ??= chromium.launch({ headless: true, chromiumSandbox: true }).finally(() => { starting = null; });
        browser = await starting;
      }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(30_000);
      const stop = () => { void page.close().catch(() => {}); };
      const deadline = setTimeout(stop, options.timeoutMs ?? 120_000);
      options.signal?.addEventListener('abort', stop, { once: true });
      if (options.signal?.aborted) stop();
      const assets: Record<string, string> = {};
      try {
        for (const id of collectCampaignAssetIds(document)) {
          const a = await services.db.query('SELECT * FROM assets WHERE id=$1 AND project_id=$2', [id, document.id]);
          invariant(a.rowCount, 'ASSET_MISSING', 'A screenshot or decorative image is missing from this project.');
          const bytes = await services.storage.read(a.rows[0].storage_key);
          assets[id] = `data:${a.rows[0].mime_type};base64,${bytes.toString('base64')}`;
        }
        const origin = new URL(services.config.baseUrl).origin;
        await page.route('**/*', route => isAllowedRenderRequest(route.request().url(), origin) ? route.continue() : route.abort('blockedbyclient'));
        await page.goto(`${origin}/render/index.html`, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForFunction(() => !!(window as any).AppScreenRenderer, null, { timeout: 15_000 });
        const scenes = [], issues: any[] = [];
        for (const scene of document.scenes) {
          const output: any = await page.evaluate(async ({ document, sceneId, assets }) => {
            return (window as any).AppScreenRenderer.render({ document, sceneId, assets });
          }, { document, sceneId: scene.id, assets });
          const data = output.dataUrl || output.png || output.image;
          invariant(typeof data === 'string' && data.startsWith('data:image/png;base64,'), 'RENDER_FAILED', 'Renderer did not return a PNG.');
          const png = await sharp(Buffer.from(data.split(',')[1], 'base64')).flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer();
          const meta = await sharp(png).metadata();
          invariant(meta.width === document.profile.width && meta.height === document.profile.height && !meta.hasAlpha, 'EXPORT_INVALID', 'Export did not match the requested output profile.');
          scenes.push({ sceneId: scene.id, png, width: meta.width!, height: meta.height! });
          issues.push(...(output.qa?.issues || output.issues || []));
        }
        const thumbWidth = 264, thumbHeight = Math.round(264 * document.profile.height / document.profile.width), gap = 12;
        const thumbs = await Promise.all(scenes.map(s => sharp(s.png).resize(thumbWidth, thumbHeight).toBuffer()));
        const contactSheet = await sharp({ create: { width: scenes.length * (thumbWidth + gap) + gap, height: thumbHeight + gap * 2, channels: 3, background: '#111422' } })
          .composite(thumbs.map((input, i) => ({ input, left: gap + i * (thumbWidth + gap), top: gap }))).png().toBuffer();
        return { scenes, contactSheet, issues };
      } finally { clearTimeout(deadline); options.signal?.removeEventListener('abort', stop); await page.close(); }
    },
    async close() { if (browser) await browser.close(); browser = null; },
  };
}
