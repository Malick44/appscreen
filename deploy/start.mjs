import { assertBrowserSandbox } from './verify-browser.mjs';
import { verifyConfiguredStorage } from './ensure-storage.mjs';

const mode = process.argv[2];
if (!['web', 'worker'].includes(mode)) throw new Error('Choose web or worker.');
if (process.env.APPSCREEN_EMBEDDED_WORKER === 'true') throw new Error('Container deployment requires a separate worker.');
if (process.env.NODE_ENV === 'production') await verifyConfiguredStorage();
if (mode === 'worker') {
  await assertBrowserSandbox();
  await import('../server/worker-main.ts');
} else await import('../server/main.ts');
