import test from "node:test";
import assert from "node:assert/strict";
import {
  staffMfaAllowed,
  listStaffFactors,
  qrImageData,
  enrollStaffFactor,
  verifyStaffFactor,
  staffMfaMarkup,
} from "../mfa.mjs";

test("staff step-up is visible only for a server marker with Supabase authentication", () => {
  assert.equal(
    staffMfaAllowed(
      { operatorMfaRequired: true },
      { auth: { provider: "supabase" } },
    ),
    true,
  );
  for (const session of [
    {},
    { role: "owner" },
    { operatorMfaRequired: "true" },
  ])
    assert.equal(
      staffMfaAllowed(session, { auth: { provider: "supabase" } }),
      false,
    );
  assert.equal(
    staffMfaAllowed(
      { operatorMfaRequired: true },
      { auth: { provider: "development" } },
    ),
    false,
  );
});
test("staff factors include only TOTP factors and never trust another factor kind", async () => {
  const factors = await listStaffFactors({
    listFactors: async () => ({
      data: {
        all: [
          { id: "t", factor_type: "totp", status: "verified" },
          { id: "u", factor_type: "totp", status: "unverified" },
          { id: "p", factor_type: "phone", status: "verified" },
        ],
      },
      error: null,
    }),
  });
  assert.deepEqual(
    factors.map((factor) => factor.id),
    ["t", "u"],
  );
});
test("authenticator enrollment uses only an image data URL, never raw SVG or remote QR links", async () => {
  assert.equal(qrImageData("https://example.test/secret-qr.svg"), "");
  assert.equal(
    qrImageData("data:image/svg+xml,<svg><script>alert(1)</script></svg>"),
    "",
  );
  const enrollment = await enrollStaffFactor({
    enroll: async () => ({
      data: {
        id: "f1",
        totp: {
          secret: "TESTTEST",
          qr_code:
            'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        },
      },
      error: null,
    }),
  });
  assert.match(enrollment.qr, /^data:image\/svg\+xml,%3Csvg/);
  assert.doesNotMatch(staffMfaMarkup([], enrollment), /<svg/);
  assert.match(staffMfaMarkup([], enrollment), /type="password" readonly/);
});
test("staff factor verification requires provider success and elevated assurance", async () => {
  let received;
  const mfa = {
    challengeAndVerify: async (values) => {
      received = values;
      return {
        data: { access_token: "TEST_ONLY", user: { id: "u1" } },
        error: null,
      };
    },
    getAuthenticatorAssuranceLevel: async () => ({
      data: { currentLevel: "aal2" },
      error: null,
    }),
  };
  assert.deepEqual(await verifyStaffFactor(mfa, "f1", "123456"), {
    verified: true,
  });
  assert.deepEqual(received, { factorId: "f1", code: "123456" });
  await assert.rejects(verifyStaffFactor(mfa, "f1", "123"), {
    code: "INVALID_MFA_CODE",
  });
  await assert.rejects(
    verifyStaffFactor(
      {
        ...mfa,
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: "aal1" },
          error: null,
        }),
      },
      "f1",
      "123456",
    ),
    /not confirmed/,
  );
  await assert.rejects(
    verifyStaffFactor(
      {
        ...mfa,
        challengeAndVerify: async () => ({
          error: { code: "mfa_verification_failed" },
        }),
      },
      "f1",
      "123456",
    ),
  );
});
