import test from "node:test";
import assert from "node:assert/strict";
import { verifyPasswordAccess } from "../auth.mjs";

async function setup({ href, initialize }) {
  let listener;
  globalThis.window = {
    location: { href },
    supabase: { createClient: () => ({ auth }) },
  };
  globalThis.history = {
    state: {},
    replaceState: (_state, _title, value) => {
      window.location.href = new URL(value, window.location.href).href;
    },
  };
  const auth = {
    onAuthStateChange: (callback) => {
      listener = callback;
    },
    initialize: () =>
      initialize({
        emit: (event) => listener(event),
        cleanCode: () => {
          const url = new URL(window.location.href);
          url.searchParams.delete("code");
          history.replaceState({}, "", url.href);
        },
      }),
    getSession: async () => ({
      data: { session: { access_token: "TEST_ONLY_SESSION" } },
      error: null,
    }),
    getUser: async () => ({
      data: { user: { id: "existing-user" } },
      error: null,
    }),
  };
  const module = await import(`../session.js?qa=${Math.random()}`);
  await module.configureSession({
    auth: {
      provider: "supabase",
      url: "https://auth.example.test",
      publishableKey: "TEST_PUBLIC_KEY",
    },
  });
  return { module, auth };
}
test("SDK initialization errors are retained as safe codes and block a stale-session reset", async () => {
  const { module, auth } = await setup({
    href: "https://app.example.test/reset-password?code=TEST_PRIVATE&returnTo=%2Fapp",
    initialize: async () => ({
      error: { code: "otp_expired", message: "TEST_PRIVATE details" },
    }),
  });
  const state = module.authCallbackState();
  assert.equal(state.error.code, "otp_expired");
  assert.doesNotMatch(JSON.stringify(state), /TEST_PRIVATE/);
  assert.equal(new URL(window.location.href).searchParams.has("code"), false);
  assert.equal(
    new URL(window.location.href).searchParams.get("appscreen_link_error"),
    "1",
  );
  assert.equal((await verifyPasswordAccess(auth, state)).allowed, false);
});
test("a callback code not consumed by SDK initialization is a missing-verifier failure", async () => {
  const { module, auth } = await setup({
    href: "https://app.example.test/reset-password?code=TEST_PRIVATE",
    initialize: async () => ({ error: null }),
  });
  assert.equal(module.authCallbackState().error.code, "pkce_verifier_missing");
  assert.equal(
    (await verifyPasswordAccess(auth, module.authCallbackState())).allowed,
    false,
  );
});
test("a consumed recovery callback with a verified user permits the password flow", async () => {
  const { module, auth } = await setup({
    href: "https://app.example.test/reset-password?code=TEST_PRIVATE",
    initialize: async ({ emit, cleanCode }) => {
      cleanCode();
      emit("PASSWORD_RECOVERY");
      return { error: null };
    },
  });
  assert.equal(module.authCallbackState().error, null);
  assert.equal(module.authCallbackState().recoveryEvent, true);
  assert.equal(
    (await verifyPasswordAccess(auth, module.authCallbackState())).allowed,
    true,
  );
});

test("refreshing a failed callback cannot silently use the previous account session", async () => {
  const { module, auth } = await setup({
    href: "https://app.example.test/reset-password?appscreen_link_error=1",
    initialize: async () => ({ error: null }),
  });
  assert.equal(module.authCallbackState().error.code, "LINK_INVALID");
  assert.equal(
    (await verifyPasswordAccess(auth, module.authCallbackState())).allowed,
    false,
  );
});
