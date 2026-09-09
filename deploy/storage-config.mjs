/** Resolve one complete credential pair. A storage override must never inherit
 * the Auth administrator credential, even when both services share an origin.
 * This module is shared by startup verification and runtime storage access.
 * @param {Record<string, string | undefined>} env
 * @param {{ requireConfigured?: boolean }} [options]
 */
export function resolveStorageConfig(env, { requireConfigured = env.NODE_ENV === 'production' } = {}) {
  const overrideUrl = env.SUPABASE_STORAGE_URL || '';
  const overrideKey = env.SUPABASE_STORAGE_SERVICE_ROLE_KEY || '';
  const overridden = Boolean(overrideUrl || overrideKey);
  if (overridden && (!overrideUrl || !overrideKey.trim())) {
    throw new Error('Configure SUPABASE_STORAGE_URL and SUPABASE_STORAGE_SERVICE_ROLE_KEY together. Partial storage overrides are rejected.');
  }
  const url = overridden ? overrideUrl : (env.SUPABASE_URL || '');
  const key = overridden ? overrideKey : (env.SUPABASE_SERVICE_ROLE_KEY || '');
  if ((requireConfigured && (!url || !key.trim())) || (key && !url)) {
    throw new Error('Private storage requires a complete Supabase URL and service-role credential pair. Configure both SUPABASE_STORAGE_URL and SUPABASE_STORAGE_SERVICE_ROLE_KEY, or the legacy SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY pair.');
  }
  // Explicit split configurations are canonical HTTPS origins, even in development.
  // Keep existing HTTPS gateway paths/trailing slashes valid for legacy deployments.
  // Legacy localhost development without a storage credential still uses files.
  if (url && (overridden || requireConfigured || env.NODE_ENV === 'production')) {
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
        && (overridden ? parsed.pathname === '/' && url === parsed.origin : url === url.trim());
    } catch { /* Never include credentials or other configuration values in errors. */ }
    if (!valid) throw new Error(overridden
      ? 'Private storage requires a canonical HTTPS origin without credentials, path, query, fragment or trailing slash.'
      : 'Private storage requires an HTTPS Supabase URL without credentials, query, fragment or surrounding whitespace.');
  }
  return { url, key };
}
