/** This rehearsal can create fresh synthetic databases only, never restore over
 * an operator-supplied database or copy an existing customer recovery point. */
export function restoreDrillInputs(env, runId) {
  if (env.APPSCREEN_RESTORE_DRILL_CONFIRM !== 'synthetic-only') throw new Error('Confirm the isolated synthetic rehearsal explicitly.');
  let url;
  try { url = new URL(env.TEST_DATABASE_URL || ''); } catch { throw new Error('A loopback dedicated test database is required.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/(?:^|[_/-])test(?:[_/-]|$)/.test(decodeURIComponent(url.pathname)) || url.search || url.hash) {
    throw new Error('Use a loopback dedicated test database without connection overrides.');
  }
  const container = env.RESTORE_DRILL_POSTGRES_CONTAINER || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new Error('Choose the exact local PostgreSQL container.');
  if (!/^[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid synthetic rehearsal identity.');
  const user = decodeURIComponent(url.username);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(user)) throw new Error('A simple local PostgreSQL role name is required.');
  const sourceName = `appscreen_restore_test_source_${runId}`, targetName = `appscreen_restore_test_target_${runId}`;
  const connection = name => { const value = new URL(url); value.pathname = `/${name}`; return value.href; };
  return { container, user, adminUrl: url.href, adminName: decodeURIComponent(url.pathname.slice(1)), sourceName, targetName, sourceUrl: connection(sourceName), targetUrl: connection(targetName) };
}

export function quoteDatabaseIdentifier(value) {
  if (!/^appscreen_restore_test_(source|target)_[a-f0-9]{12}$/.test(value)) throw new Error('Only newly generated rehearsal database names are accepted.');
  return `"${value}"`;
}
