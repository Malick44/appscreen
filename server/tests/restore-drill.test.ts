import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreDrillInputs, quoteDatabaseIdentifier } from '../../deploy/restore-drill-guards.mjs';

const safe = { APPSCREEN_RESTORE_DRILL_CONFIRM: 'synthetic-only', TEST_DATABASE_URL: 'postgresql://local:fixture@127.0.0.1:55432/appscreen_test', RESTORE_DRILL_POSTGRES_CONTAINER: 'appscreen-fixture-db' };
test('restore rehearsal requires explicit synthetic-only confirmation and a loopback test database', () => {
  for (const change of [
    { APPSCREEN_RESTORE_DRILL_CONFIRM: undefined }, { APPSCREEN_RESTORE_DRILL_CONFIRM: 'production' },
    { TEST_DATABASE_URL: 'postgresql://local:fixture@database.example/appscreen_test' },
    { TEST_DATABASE_URL: 'postgresql://local:fixture@127.0.0.1/appscreen' },
    { TEST_DATABASE_URL: 'postgresql://local:fixture@127.0.0.1/contest' },
    { TEST_DATABASE_URL: 'https://local:fixture@127.0.0.1/appscreen_test' },
    { TEST_DATABASE_URL: `${safe.TEST_DATABASE_URL}?host=external.example` },
    { RESTORE_DRILL_POSTGRES_CONTAINER: '--privileged' },
  ]) assert.throws(() => restoreDrillInputs({ ...safe, ...change }, 'abcdef012345'));
  const result = restoreDrillInputs(safe, 'abcdef012345');
  assert.equal(new URL(result.sourceUrl).pathname, '/appscreen_restore_test_source_abcdef012345');
  assert.notEqual(result.sourceUrl, result.targetUrl);
  assert.equal(result.adminName, 'appscreen_test');
});
test('restore rehearsal cannot accept a broad, existing or injected restore target', () => {
  for (const name of ['appscreen', 'appscreen_test', 'postgres', 'appscreen_restore_test_target_a; DROP DATABASE appscreen', 'appscreen_restore_test_target_123', '']) assert.throws(() => quoteDatabaseIdentifier(name));
  assert.equal(quoteDatabaseIdentifier('appscreen_restore_test_target_abcdef012345'), '"appscreen_restore_test_target_abcdef012345"');
  assert.throws(() => restoreDrillInputs(safe, 'bad-run-id'));
});
