// Explicit local integration test. Creates a labeled development-only QA workspace.
// It never enables AI, buys a plan, requests deletion, or prints credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultDraft, briefPayload } from "../brief.mjs";

const base = new URL(
  process.env.APPSCREEN_QA_BASE_URL || "http://127.0.0.1:8001",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
  "This smoke test only runs against loopback development servers.",
);
let token;
async function request(
  path,
  { method = "GET", body, authenticated = true } = {},
) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  return { response, data };
}
async function ok(path, options) {
  const { response, data } = await request(path, options);
  assert.ok(
    response.ok,
    `${options?.method || "GET"} ${path}: ${response.status} ${data.error?.code || ""}`,
  );
  return data;
}
const config = await ok("/api/config", { authenticated: false });
assert.equal(
  config.auth?.provider,
  "development",
  "Explicit development authentication is required.",
);
const email = `saas-contract-qa-${Date.now()}@example.test`;
token = (
  await ok("/api/dev/session", {
    method: "POST",
    authenticated: false,
    body: { email },
  })
).token;
assert.equal(typeof token, "string");
const session = await ok("/api/session");
assert.equal(session.user.email, email);
const { project } = await ok("/api/projects", {
  method: "POST",
  body: {
    name: "QA · Brief and connection contract",
    idempotencyKey: randomUUID(),
  },
});
const templates = (await ok("/api/templates")).templates;
const template = templates.find((item) => item.cloudCompatible !== false);
assert.ok(template, "Cloud-compatible template available");
const draft = {
  ...defaultDraft({ project, assets: [] }),
  appName: "",
  promise: "Verify cloud preferences survive a refresh.",
  audience: "Internal synthetic QA only",
  templateId: template.id,
  templateMode: "inspiration",
  locks: ["positions", "connections"],
  screenCount: 6,
};
const payload = briefPayload(draft);
const saved = await ok(`/api/projects/${project.id}`, {
  method: "PATCH",
  body: { ...payload, expectedUpdatedAt: project.updatedAt },
});
assert.notEqual(saved.project.updatedAt, project.updatedAt);
const loaded = await ok(`/api/projects/${project.id}`);
const restored = defaultDraft(loaded);
assert.equal(restored.appName, "");
assert.equal(restored.promise, draft.promise);
assert.equal(restored.templateId, template.id);
assert.equal(restored.templateMode, "inspiration");
assert.deepEqual(restored.locks.sort(), ["connections", "positions"]);
const conflict = await request(`/api/projects/${project.id}`, {
  method: "PATCH",
  body: { ...payload, expectedUpdatedAt: project.updatedAt },
});
assert.equal(conflict.response.status, 409);
assert.equal(conflict.data.error.code, "PROJECT_CONFLICT");
const preview = await fetch(
  new URL(`/api/templates/${encodeURIComponent(template.id)}/preview`, base),
  { signal: AbortSignal.timeout(15000) },
);
assert.equal(preview.status, 200);
assert.match(preview.headers.get("content-type"), /image\/svg\+xml/);
assert.match(await preview.text(), /<svg/);
const connection = await ok("/api/connections", {
  method: "POST",
  body: {
    name: "QA · temporary read-only connection",
    scopes: ["projects:read"],
    days: 1,
  },
});
assert.equal(typeof connection.token, "string");
assert.ok(
  (await ok("/api/connections")).connections.some(
    (item) => item.id === connection.id,
  ),
);
await ok(`/api/connections/${connection.id}`, { method: "DELETE" });
assert.ok(
  (await ok("/api/connections")).connections.find(
    (item) => item.id === connection.id,
  )?.revokedAt,
);
await ok("/api/usage");
console.log(
  "PASS: real development sign-in, brief/template/lock persistence, optimistic conflict, template preview, scoped connection creation/revocation, and usage contracts.",
);
console.log(`Synthetic QA project: ${project.id}`);
