import { escapeHTML as e, safeURL, formatDate } from "./utils.mjs";

export function safeOAuthRedirect(value) {
  const safe = safeURL(value);
  if (!safe || safe.startsWith("/")) return "";
  const url = new URL(safe);
  return url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    ? url.href
    : "";
}

export function oauthConsentMarkup(data) {
  const callback = safeOAuthRedirect(data.redirectUri);
  if (!callback)
    throw new Error(
      "This client’s callback address is not supported. Return to your agent and check its connection settings.",
    );
  const callbackURL = new URL(callback);
  const permissions = Array.isArray(data.permissions) ? data.permissions : [];
  return `<section class="auth-wrap consent-wrap"><p class="eyebrow">AppScreen agent connection</p><h1>Choose what your agent can do.</h1><p>Only approve an app you recognize and trust.</p><div class="panel"><dl class="consent-details"><div><dt>Requesting app</dt><dd>${e(data.client?.name || "Unnamed client")}</dd></div><div><dt>Returns to</dt><dd><code>${e(callbackURL.host)}</code><small>${e(callbackURL.origin + callbackURL.pathname)}</small></dd></div><div><dt>Your workspace</dt><dd>${e(data.workspace?.name || "Your workspace")}</dd></div></dl><p class="help-text">App names and callback addresses are supplied by the requesting client. AppScreen does not endorse them.</p>${data.identityScopes?.length ? `<div class="notice"><strong>Account identity requested</strong><p>${data.identityScopes.map((scope) => e(scope)).join(" · ")}</p><small>These identity permissions are part of this sign-in request. Cancel if you do not want to share them.</small></div>` : ""}<form id="oauth-consent-form"><fieldset><legend>Workspace permissions</legend><div class="consent-permissions">${permissions.map((permission) => `<label class="check"><input type="checkbox" name="scopes" value="${e(permission.scope)}" ${permission.defaultSelected && permission.scope !== "ai:run" ? "checked" : ""}><span><strong>${e(permission.label || permission.scope)}</strong><small>${e(permission.description || "")}${permission.scope === "ai:run" ? " This can spend your AppScreen AI credits. Leave off for direct editing only." : ""}</small></span></label>`).join("")}</div></fieldset><p class="help-text">Access lasts up to 30 days and can be revoked under Agent connections. Uploaded screenshots and campaign content may be read or changed according to the permissions you choose.</p><p class="help-text">Approval request expires ${e(formatDate(data.expiresAt))}. Your account password and provider keys are never shared with the agent.</p><p class="inline-error" id="oauth-error" role="alert"></p><div class="actions"><button class="button primary" type="submit" name="action" value="approve">Allow selected access</button><button class="button quiet" type="submit" name="action" value="deny" formnovalidate>Cancel connection</button></div></form></div><p class="auth-links"><a href="/app/connections" data-link>Manage existing connections</a></p></section>`;
}

export function oauthReconnectMarkup(data) {
  const connections = Array.isArray(data.connections) ? data.connections : [];
  return `<section class="auth-wrap consent-wrap"><p class="eyebrow">Reconnect your agent</p><h1>Choose the connection to reset.</h1><p class="notice warning">The sign-in provider reused an older approval. AppScreen has not expanded its permissions or extended its expiry.</p><p>Reset only the connection you intend to reconnect. Its current AppScreen access is revoked during reset. Other connections are not reset.</p>${connections.length ? `<div class="panel"><form id="oauth-reconnect-form"><fieldset><legend>Existing connections for this client</legend><div class="consent-permissions">${connections.map((connection) => `<label class="check"><input type="radio" name="connectionId" value="${e(connection.id)}" required><span><strong>${e(connection.name || "Unnamed connection")}</strong><small>${e(connection.id)}<br>${e((connection.scopes || []).join(" · "))}<br>${connection.revokedAt ? "Revoked" : `Expires ${e(formatDate(connection.expiresAt))}`}</small></span></label>`).join("")}</div></fieldset><hr><label class="check"><input type="checkbox" name="confirmation" required><span>I want to reset this one selected connection. I will restart authorization from my agent afterward.</span></label><p class="inline-error" id="oauth-reconnect-error" role="alert"></p><button type="submit" class="button danger">Reset selected connection</button><p id="oauth-reconnect-status" class="help-text mt20" role="status"></p></form></div>` : '<p class="notice">No matching AppScreen connection was returned. Return to your agent and start a new connection, or ask your service operator for help.</p>'}<p class="auth-links"><a href="/app/connections" data-link>Manage agent connections</a></p></section>`;
}
export function reconnectSelection(data, id) {
  const connection = data.connections?.find(
    (connection) => connection.id === id,
  );
  if (
    !connection ||
    !Number.isInteger(connection.version) ||
    connection.version < 1
  )
    throw new Error(
      "Choose a current connection from this list. Refresh if it has changed.",
    );
  return { id: connection.id, expectedVersion: connection.version };
}
