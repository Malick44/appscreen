import test from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_PREFERENCES_PATH,
  normalizeEmailPreferences,
  createEmailPreferences,
  emailPreferencesMarkup,
} from "../email.mjs";

const preference = (values = {}) => ({
  enabled: false,
  version: 0,
  sendingAvailable: true,
  updatedAt: null,
  ...values,
});
const receipt = (values = {}) => preference({
  enabled: true,
  version: 1,
  updatedAt: "2026-09-04T10:00:00.000Z",
  ...values,
});
const control = (html, id) => html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];

test("preferences reject ambiguous capability, consent, and version values", () => {
  assert.deepEqual(normalizeEmailPreferences(preference()), preference());
  for (const value of [
    null,
    {},
    preference({ enabled: "false" }),
    preference({ sendingAvailable: "true" }),
    preference({ version: -1 }),
    preference({ version: Number.MAX_SAFE_INTEGER + 1 }),
    preference({ updatedAt: "invalid" }),
    preference({ updatedAt: undefined }),
  ])
    assert.throws(() => normalizeEmailPreferences(value));
  assert.deepEqual(
    normalizeEmailPreferences({ ...preference(), recipient: "extra@example.test" }),
    preference(),
  );
});

test("only explicit save writes boolean consent and expected version; pending writes cannot duplicate", async () => {
  const calls = [], states = [];
  let finish;
  const editor = createEmailPreferences(async (path, options) => {
    calls.push({ path, options });
    if (options.method === "POST")
      return new Promise((resolve) => { finish = resolve; });
    return preference();
  }, (view) => states.push(view.status));
  assert.equal(editor.snapshot().enabled, false);
  await editor.load();
  editor.change(true);
  assert.equal(calls.length, 1);
  assert.equal(editor.snapshot().status, "dirty");
  const save = editor.save();
  assert.equal(editor.snapshot().status, "saving");
  editor.change(false);
  await editor.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, EMAIL_PREFERENCES_PATH);
  assert.deepEqual(calls[1].options.body, { enabled: true, expectedVersion: 0 });
  finish(receipt());
  await save;
  assert.equal(editor.snapshot().status, "saved");
  assert.equal(editor.snapshot().preferences.enabled, true);
  assert.deepEqual(states, ["loading", "idle", "dirty", "saving", "saved"]);
  await editor.save();
  assert.equal(calls.length, 2);
});

test("unavailable delivery forbids enabling but allows explicitly saving an existing opt-out", async () => {
  for (const initiallyEnabled of [false, true]) {
    const writes = [];
    const editor = createEmailPreferences(async (path, options) => {
      if (options.method === "POST") {
        writes.push(options.body);
        return receipt({ enabled: false, sendingAvailable: false, version: 3 });
      }
      return preference({ enabled: initiallyEnabled, sendingAvailable: false, version: 2 });
    });
    await editor.load();
    const initial = emailPreferencesMarkup(editor.snapshot());
    assert.match(initial, /Email delivery is not configured/);
    assert.match(initial, /AppScreen is not sending these emails/);
    if (!initiallyEnabled) {
      assert.match(control(initial, "email-preferences-enabled"), /disabled/);
      editor.change(true);
      await editor.save();
      assert.deepEqual(writes, []);
      assert.equal(editor.snapshot().enabled, false);
    } else {
      assert.doesNotMatch(control(initial, "email-preferences-enabled"), /disabled/);
      editor.change(false);
      const dirty = emailPreferencesMarkup(editor.snapshot());
      assert.match(control(dirty, "email-preferences-enabled"), /disabled/);
      assert.doesNotMatch(control(dirty, "email-preferences-save"), /disabled/);
      editor.change(true);
      assert.equal(editor.snapshot().enabled, false);
      await editor.save();
      assert.deepEqual(writes, [{ enabled: false, expectedVersion: 2 }]);
      assert.equal(editor.snapshot().status, "saved");
    }
  }
});

test("failed save retries the exact intended preference and optimistic version", async () => {
  const bodies = [];
  const editor = createEmailPreferences(async (path, options) => {
    if (options.method !== "POST") return preference();
    bodies.push(options.body);
    if (bodies.length === 1) throw Object.assign(new Error("private error"), { code: "CONNECTION_FAILED" });
    return receipt();
  });
  await editor.load();
  editor.change(true);
  await editor.save();
  assert.equal(editor.snapshot().status, "error");
  assert.equal(editor.snapshot().enabled, true);
  const html = emailPreferencesMarkup(editor.snapshot());
  assert.match(html, /Retry saving preferences/);
  assert.match(html, /Reload preferences/);
  assert.doesNotMatch(html, /private error/);
  assert.match(control(html, "email-preferences-enabled"), /disabled/);
  editor.change(false);
  assert.equal(editor.snapshot().enabled, true, "An uncertain write is retried or reloaded before changing intent.");
  await editor.save();
  assert.deepEqual(bodies, [
    { enabled: true, expectedVersion: 0 },
    { enabled: true, expectedVersion: 0 },
  ]);
  assert.equal(editor.snapshot().status, "saved");
});

test("stale or unavailable saves require a read and another explicit choice, without automatic writes", async () => {
  for (const failure of [
    { code: "EMAIL_PREFERENCES_CHANGED", status: 409 },
    { code: "EMAIL_SENDING_UNAVAILABLE", status: 503 },
  ]) {
    let reads = 0, writes = 0;
    const editor = createEmailPreferences(async (path, options) => {
      if (options.method !== "POST")
        return preference({ version: reads++ ? 2 : 0 });
      writes++;
      throw failure;
    });
    await editor.load();
    editor.change(true);
    await editor.save();
    assert.equal(editor.snapshot().reloadRequired, true);
    const html = emailPreferencesMarkup(editor.snapshot());
    assert.match(control(html, "email-preferences-enabled"), /disabled/);
    assert.match(control(html, "email-preferences-save"), /disabled/);
    assert.match(html, /Reload preferences/);
    await editor.save();
    assert.equal(writes, 1);
    await editor.load();
    assert.equal(editor.snapshot().enabled, false);
    assert.equal(editor.snapshot().preferences.version, 2);
    assert.equal(writes, 1);
    assert.equal(editor.snapshot().status, "idle");
  }
});

test("unconfirmed receipts never show a saved state and load failures are recoverable", async () => {
  let reads = 0;
  const editor = createEmailPreferences(async (path, options) => {
    if (options.method === "POST") return preference();
    if (reads++ === 0) throw new Error("PRIVATE_API_TRACE");
    return preference();
  });
  await editor.load();
  const error = emailPreferencesMarkup(editor.snapshot());
  assert.match(error, /Retry loading preferences/);
  assert.doesNotMatch(error, /PRIVATE_API_TRACE/);
  await editor.load();
  editor.change(true);
  await editor.save();
  assert.equal(editor.snapshot().status, "error");
  assert.doesNotMatch(emailPreferencesMarkup(editor.snapshot()), /Email preferences saved/);
});

test("customer copy limits scope and exposes loading, unsaved, saved, and accessible statuses", async () => {
  const editor = createEmailPreferences(async (path, options) =>
    options.method === "POST" ? receipt() : preference());
  const loading = emailPreferencesMarkup(editor.snapshot());
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading email preferences/);
  assert.match(loading, /verified account email/);
  assert.match(loading, /new campaign, support, and billing notices/);
  assert.match(loading, /Authentication and recovery emails are managed separately/);
  assert.match(loading, /Only new notices after you opt in/);
  assert.match(loading, /cannot recall emails already sent/);
  assert.doesNotMatch(loading, /type="email"|name="recipient"/);
  assert.match(loading, /role="status" aria-live="polite"/);
  await editor.load();
  assert.match(emailPreferencesMarkup(editor.snapshot()), /Email notices are off/);
  editor.change(true);
  assert.match(emailPreferencesMarkup(editor.snapshot()), /unsaved change/);
  await editor.save();
  assert.match(emailPreferencesMarkup(editor.snapshot()), /Email preferences saved/);
});
