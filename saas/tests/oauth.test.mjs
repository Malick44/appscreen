import test from "node:test";
import assert from "node:assert/strict";
import {
  safeOAuthRedirect,
  oauthConsentMarkup,
  oauthReconnectMarkup,
  reconnectSelection,
} from "../oauth.mjs";

test("OAuth redirects allow HTTPS and loopback HTTP but reject executable and insecure remote URLs", () => {
  assert.equal(
    safeOAuthRedirect("https://client.example.test/callback?code=example"),
    "https://client.example.test/callback?code=example",
  );
  assert.equal(
    safeOAuthRedirect("http://127.0.0.1:8080/callback"),
    "http://127.0.0.1:8080/callback",
  );
  for (const value of [
    "javascript:alert(1)",
    "/callback",
    "//example.test/callback",
    "http://remote.example.test",
    "https://name:secret@example.test",
    "data:text/html,test",
    "https://example.test\\evil",
  ])
    assert.equal(safeOAuthRedirect(value), "", value);
});

test("reconnect requires an explicit existing connection and its current version", () => {
  const data = {
    connections: [
      { id: "c1", name: "<unsafe>", version: 3, scopes: ["projects:read"] },
      { id: "c2", name: "Other agent", version: 8, scopes: ["projects:read"] },
    ],
  };
  assert.deepEqual(reconnectSelection(data, "c1"), {
    id: "c1",
    expectedVersion: 3,
  });
  assert.throws(() => reconnectSelection(data, "all"));
  const html = oauthReconnectMarkup(data);
  assert.match(html, /type="radio"/);
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /Reset selected connection/);
  assert.match(html, /Other connections are not reset/);
});
test("OAuth approval escapes client metadata and never preselects paid AI access", () => {
  const html = oauthConsentMarkup({
    client: { name: "<script>alert(1)</script>" },
    workspace: { name: "QA & test" },
    redirectUri: "https://client.example.test/callback",
    identityScopes: ["openid", "<b>profile</b>"],
    consentNonce: "private-nonce",
    permissions: [
      { scope: "projects:read", label: "Read projects", defaultSelected: true },
      { scope: "ai:run", label: "Paid AI", defaultSelected: true },
    ],
    expiresAt: "2026-09-04T12:00:00Z",
  });
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /QA &amp; test/);
  assert.match(html, /&lt;b&gt;profile&lt;\/b&gt;/);
  assert.match(html, /value="projects:read" checked/);
  assert.doesNotMatch(html, /value="ai:run" checked/);
  assert.doesNotMatch(html, /private-nonce/);
  assert.match(html, /Allow selected access/);
  assert.match(html, /Cancel connection/);
});
