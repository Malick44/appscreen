import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStorageConfig } from './storage-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Config expansion only: no daemon/build/start, dotenv, actual keys or database.
const fixture = {
  PATH: process.env.PATH,
  APP_BASE_URL: 'https://appscreen.example.test',
  DATABASE_URL: 'postgresql://fixture:fixture@database.invalid/fixture',
  APPSCREEN_SIGNING_SECRET: 'synthetic-deployment-test-'.repeat(3),
  SUPABASE_URL: 'https://fixture.supabase.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-server-only',
  OPENAI_API_KEY: 'must-not-be-inherited',
  STRIPE_SECRET_KEY: 'must-not-be-inherited',
  APPSCREEN_ENABLE_AI: 'true',
  APPSCREEN_EMAIL_ENABLED: 'true',
  APPSCREEN_MCP_OAUTH: 'true',
  APPSCREEN_DEV_AUTH: 'true',
};
const available = spawnSync('docker', ['compose', 'version'], { env: fixture, encoding: 'utf8', timeout: 10_000 }).status === 0;
const options = { skip: available ? false : 'Docker Compose CLI required for non-mutating configuration validation' };
function inspect(env = fixture) {
  return spawnSync('docker', ['compose', '--project-directory', root, '--env-file', '/dev/null', '-f', `${root}docker-compose.saas.yml`, 'config', '--format', 'json'], { env, encoding: 'utf8', timeout: 10_000 });
}

test('SaaS Compose resolves distinct processes with identical safe runtime configuration', options, () => {
  const result = inspect();
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(services).sort(), ['web', 'worker']);
  assert.deepEqual(services.web.environment, services.worker.environment);
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.build.context, root.replace(/\/$/, ''));
    assert.equal(service.build.dockerfile, 'Dockerfile.saas');
    assert.equal(service.build.args, undefined);
    assert.deepEqual(service.command, ['node', '--import', 'tsx', 'deploy/start.mjs', name]);
    assert.equal(service.environment.APP_BASE_URL, fixture.APP_BASE_URL);
    assert.equal(service.environment.DATABASE_URL, fixture.DATABASE_URL);
    assert.equal(service.environment.APPSCREEN_SIGNING_SECRET, fixture.APPSCREEN_SIGNING_SECRET);
    assert.equal(service.environment.NODE_ENV, 'production');
    assert.equal(service.environment.SUPABASE_AUTH_VERIFICATION, 'jwks');
    for (const setting of ['APPSCREEN_DEV_AUTH', 'APPSCREEN_EMBEDDED_WORKER', 'APPSCREEN_ENABLE_AI', 'APPSCREEN_MCP_OAUTH', 'APPSCREEN_EMAIL_ENABLED']) assert.equal(service.environment[setting], 'false', setting);
    for (const setting of ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRO_PRICE_ID', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET']) assert.equal(service.environment[setting], '', setting);
    assert.equal(service.ports, undefined, 'Only the managed HTTPS proxy may publish the web service');
    assert.equal(service.privileged, undefined);
    assert.equal(service.cap_add, undefined);
    assert.equal(service.volumes, undefined, 'No unreviewed host/user data mounts');
    assert.equal(service.restart, 'unless-stopped');
  }
  assert.deepEqual(services.web.expose, ['8001']);
  assert.equal(services.worker.expose, undefined);
  assert.equal(services.worker.shm_size, '1073741824');
  assert.equal(services.worker.healthcheck.disable, true);
  assert.equal(services.web.healthcheck.test[0], 'CMD');
  assert.match(services.web.healthcheck.test.at(-1), /response\.json\(\)/);
  assert.match(services.web.healthcheck.test.at(-1), /status !== 'ok'/);
});

test('SaaS Compose passes an explicit self-hosted verification mode to both processes', options, () => {
  const result = inspect({ ...fixture, SUPABASE_AUTH_VERIFICATION: 'auth-server' });
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  for (const service of Object.values(services)) {
    assert.equal(service.environment.SUPABASE_AUTH_VERIFICATION, 'auth-server');
    assert.equal(service.environment.APPSCREEN_MCP_OAUTH, 'false');
    assert.equal(service.environment.APPSCREEN_DEV_AUTH, 'false');
  }
});

test('SaaS Compose refuses unset or empty mandatory production settings before any deployment', options, () => {
  for (const setting of ['APP_BASE_URL', 'DATABASE_URL', 'APPSCREEN_SIGNING_SECRET', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']) {
    for (const value of [undefined, '']) {
      const env = { ...fixture, [setting]: value };
      if (value === undefined) delete env[setting];
      const result = inspect(env);
      assert.notEqual(result.status, 0, `${setting} must not be optional`);
      assert.ok(result.stderr.includes(setting), `Missing ${setting} should be explained`);
      assert.equal(result.stdout.trim(), '');
    }
  }
});

test('SaaS Compose keeps isolated Auth and shared Storage credentials distinct', options, () => {
  const result = inspect({ ...fixture, SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_STORAGE_URL: 'https://storage.example.test', SUPABASE_STORAGE_SERVICE_ROLE_KEY: 'fixture-storage-only' });
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  for (const { environment: env } of Object.values(services)) {
    assert.equal(env.SUPABASE_URL, fixture.SUPABASE_URL);
    assert.equal(env.SUPABASE_PUBLISHABLE_KEY, fixture.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, '');
    assert.deepEqual(resolveStorageConfig(env), { url: 'https://storage.example.test', key: 'fixture-storage-only' });
  }
});

test('SaaS expanded settings reject absent or partial Storage credentials at startup', options, () => {
  for (const overrides of [
    { SUPABASE_SERVICE_ROLE_KEY: '' },
    { SUPABASE_STORAGE_URL: 'https://storage.example.test' },
    { SUPABASE_STORAGE_SERVICE_ROLE_KEY: 'fixture-storage-only' },
  ]) {
    const result = inspect({ ...fixture, ...overrides });
    assert.equal(result.status, 0, result.stderr);
    const { services } = JSON.parse(result.stdout);
    for (const { environment: env } of Object.values(services)) assert.throws(() => resolveStorageConfig(env), /Private storage requires|together/);
  }
});
