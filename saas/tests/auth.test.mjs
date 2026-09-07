import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectAuthURL,
  cleanAuthURL,
  recoveryRedirect,
  authErrorMessage,
  verifyPasswordAccess,
  requestRecoveryEmail,
  updateRecoveredPassword,
} from "../auth.mjs";

test("auth callback inspection and cleanup never retain tokens or codes in UI state or URLs", () => {
  const url =
    "https://app.example.test/reset-password?code=SECRET&returnTo=%2Fapp&sb_flow_id=FLOW#error=access_denied&error_description=PRIVATE";
  const state = inspectAuthURL(url);
  assert.equal(state.hasCode, true);
  assert.equal(state.hasError, true);
  assert.doesNotMatch(JSON.stringify(state), /SECRET|PRIVATE|FLOW/);
  assert.equal(cleanAuthURL(url), "/reset-password?returnTo=%2Fapp");
  assert.equal(
    cleanAuthURL("https://app.example.test/help#agents"),
    "/help#agents",
  );
  assert.equal(
    recoveryRedirect("https://app.example.test", "//evil.test"),
    "https://app.example.test/reset-password?returnTo=%2Fapp",
  );
});
test("expired callback blocks password access even with an existing authenticated session", async () => {
  let calls = 0;
  const access = await verifyPasswordAccess(
    {
      getUser: async () => {
        calls++;
        return { data: { user: { id: "old-user" } }, error: null };
      },
    },
    { error: { code: "otp_expired" } },
  );
  assert.equal(access.allowed, false);
  assert.equal(calls, 0);
  assert.match(access.message, /expired/);
});
test("password form access requires a verified account response, not a locally present token", async () => {
  assert.equal((await verifyPasswordAccess(null)).allowed, false);
  assert.equal(
    (
      await verifyPasswordAccess({
        getUser: async () => ({ data: { user: null }, error: null }),
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await verifyPasswordAccess({
        getUser: async () => ({
          data: { user: { id: "u1", email: "qa@example.test" } },
          error: null,
        }),
      })
    ).allowed,
    true,
  );
});
test("recovery acceptance is reported only after SDK success and does not reveal account existence", async () => {
  let received;
  const result = await requestRecoveryEmail(
    {
      resetPasswordForEmail: async (...args) => {
        received = args;
        return { data: {}, error: null };
      },
    },
    " qa@example.test ",
    "https://app.example.test/reset-password",
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(received[0], "qa@example.test");
  await assert.rejects(
    requestRecoveryEmail(
      {
        resetPasswordForEmail: async () => ({
          error: { code: "over_email_send_rate_limit" },
        }),
      },
      "qa@example.test",
      "https://app.example.test/reset-password",
    ),
  );
  assert.match(
    authErrorMessage({ code: "over_email_send_rate_limit" }, "recover"),
    /Wait/,
  );
});
test("password update rejects mismatch and expired sessions before mutation", async () => {
  let updates = 0;
  const auth = {
    getUser: async () => ({ data: { user: null }, error: null }),
    updateUser: async () => {
      updates++;
    },
  };
  await assert.rejects(
    updateRecoveredPassword(auth, {
      password: "long-test-password",
      confirmPassword: "different-value",
    }),
    { code: "PASSWORD_MISMATCH" },
  );
  await assert.rejects(
    updateRecoveredPassword(auth, {
      password: "long-test-password",
      confirmPassword: "long-test-password",
    }),
    { code: "SESSION_REQUIRED" },
  );
  assert.equal(updates, 0);
});
test("password success requires the matching provider-confirmed user, not merely a finished request", async () => {
  const auth = {
    getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
    updateUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
  };
  const values = {
    password: "long-test-password",
    confirmPassword: "long-test-password",
  };
  assert.deepEqual(await updateRecoveredPassword(auth, values), {
    updated: true,
  });
  await assert.rejects(
    updateRecoveredPassword(
      { ...auth, updateUser: async () => ({ data: {}, error: null }) },
      values,
    ),
    { code: "INVALID_RESPONSE" },
  );
  await assert.rejects(
    updateRecoveredPassword(
      {
        ...auth,
        updateUser: async () => ({ error: { code: "same_password" } }),
      },
      values,
    ),
  );
  assert.match(
    authErrorMessage({ code: "same_password" }, "reset"),
    /different/,
  );
  assert.doesNotMatch(
    authErrorMessage({ message: "SECRET token from URL" }, "callback"),
    /SECRET/,
  );
});
