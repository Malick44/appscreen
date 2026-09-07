import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

export async function assertBrowserSandbox() {
  if (process.platform === 'linux' && process.getuid?.() === 0) throw new Error('Render worker must run as a non-root user.');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30_000 });
    const page = await browser.newPage({ viewport: { width: 96, height: 96 } });
    await page.setContent('<!doctype html><style>body{margin:0;background:#183c40}</style><canvas width="96" height="96"></canvas>');
    if ((await page.screenshot({ type: 'png' })).length < 100) throw new Error('Browser produced an empty render.');
    console.log(`Sandboxed Chromium ready (${browser.version()}).`);
  } catch {
    throw new Error('Sandboxed Chromium startup failed. Verify host user namespaces/seccomp and shared memory; do not disable the sandbox. See SAAS_SETUP.md.');
  } finally { await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await assertBrowserSandbox();
