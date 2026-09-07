import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('importing configuration never loads a working-directory .env into fixture processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'appscreen-config-isolation-'));
  await writeFile(join(directory, '.env'), 'APPSCREEN_FIXTURE_DOTENV_SENTINEL=fixture-only\n', { mode: 0o600 });
  const env = { ...process.env }; delete env.APPSCREEN_FIXTURE_DOTENV_SENTINEL;
  const code = `await import(${JSON.stringify(new URL('../config.ts', import.meta.url).href)}); console.log(JSON.stringify({loaded:process.env.APPSCREEN_FIXTURE_DOTENV_SENTINEL!==undefined}));`;
  const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code], { cwd: directory, env, timeout: 15_000 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { loaded: false });
});

test('actual service and migration entrypoints still explicitly load their environment', async () => {
  for (const file of ['main.ts', 'worker-main.ts', 'migrate.ts']) {
    assert.match(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /^import 'dotenv\/config';/);
  }
});
