import { escapeHTML as e } from "./utils.mjs";

export function staffMfaAllowed(session, config) {
  return (
    session?.operatorMfaRequired === true &&
    config?.auth?.provider === "supabase"
  );
}
export function mfaErrorMessage(error) {
  if (
    [
      "mfa_verification_failed",
      "mfa_challenge_expired",
      "INVALID_MFA_CODE",
    ].includes(error?.code)
  )
    return "The authenticator code is incorrect or expired. Use the current six-digit code and try again.";
  if (error?.status === 429)
    return "Too many verification attempts. Wait before trying another code.";
  if (error?.code === "mfa_factor_not_found")
    return "This authenticator is no longer available. Refresh the staff verification page.";
  return "Staff verification was not completed. Check your sign-in session and connection, then try again.";
}
export async function listStaffFactors(mfa) {
  const result = await mfa.listFactors();
  if (result.error) throw result.error;
  return (result.data?.all || []).filter(
    (factor) =>
      factor.factor_type === "totp" &&
      ["verified", "unverified"].includes(factor.status),
  );
}
export function qrImageData(value) {
  if (typeof value !== "string" || value.length > 1000000) return "";
  const match = value.match(
    /^data:image\/svg\+xml(?:;utf-8|;charset=utf-8)?,([\s\S]+)$/i,
  );
  if (!match) return "";
  let svg = match[1];
  if (!svg.includes("<")) {
    try {
      svg = decodeURIComponent(svg);
    } catch {
      return "";
    }
  }
  if (
    !/<svg[\s>]/i.test(svg) ||
    /<script|<foreignObject|(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)
  )
    return "";
  return "data:image/svg+xml," + encodeURIComponent(svg);
}
export async function enrollStaffFactor(mfa) {
  const result = await mfa.enroll({ factorType: "totp", issuer: "AppScreen" });
  if (result.error) throw result.error;
  if (!result.data?.id || !/^[A-Z2-7]+$/.test(result.data?.totp?.secret || ""))
    throw new Error("The authenticator setup was incomplete.");
  return {
    id: result.data.id,
    qr: qrImageData(result.data.totp.qr_code),
    secret: result.data.totp.secret,
  };
}
export async function verifyStaffFactor(mfa, factorId, rawCode) {
  const code = String(rawCode || "").replace(/\s/g, "");
  if (!factorId || !/^\d{6}$/.test(code))
    throw Object.assign(new Error("Enter the current six-digit code."), {
      code: "INVALID_MFA_CODE",
    });
  const result = await mfa.challengeAndVerify({ factorId, code });
  if (result.error) throw result.error;
  if (!result.data?.access_token || !result.data?.user?.id)
    throw new Error("The provider did not confirm a verified session.");
  const assurance = await mfa.getAuthenticatorAssuranceLevel();
  if (assurance.error) throw assurance.error;
  if (assurance.data?.currentLevel !== "aal2")
    throw new Error("The second factor was not confirmed.");
  return { verified: true };
}
export function staffMfaMarkup(factors = [], enrollment = null) {
  return `<section class="panel consent-wrap"><p class="eyebrow">Restricted staff access</p><h2>Verify with your authenticator.</h2><p>Operations requires your account password and a verified second factor. Completing this step does not grant operator privileges unless the server has already authorized your account.</p>${enrollment ? `<div class="notice warning">Keep this QR code and setup key private. AppScreen does not save an extra copy in this page’s local storage.</div><div class="mfa-setup">${enrollment.qr ? `<img class="mfa-qr" src="${e(enrollment.qr)}" alt="Private authenticator setup QR code">` : ""}<div><h3>Add AppScreen to your authenticator app</h3><p>Scan the QR code, or copy the manual setup key. Then enter the generated six-digit code below.</p><div class="field"><label for="staff-mfa-key">Manual setup key</label><input id="staff-mfa-key" type="password" readonly autocomplete="off" value="${e(enrollment.secret)}"></div><button class="button small" type="button" data-action="copy-mfa-key">Copy setup key</button></div></div>` : ""}${factors.length || enrollment ? `<form id="staff-mfa-form">${enrollment ? `<input type="hidden" name="factorId" value="${e(enrollment.id)}">` : `<div class="field"><label for="staff-mfa-factor">Authenticator</label><select id="staff-mfa-factor" name="factorId">${factors.map((factor, index) => `<option value="${e(factor.id)}">${e(factor.friendly_name || `Authenticator ${index + 1}`)}${factor.status === "unverified" ? " · unfinished setup" : ""}</option>`).join("")}</select></div>`}<div class="field"><label for="staff-mfa-code">Six-digit code</label><input id="staff-mfa-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" required placeholder="000000"></div><button type="submit" class="button primary">Verify staff access</button></form>` : '<p class="notice">No authenticator is enrolled. Set one up to continue to operations.</p>'}${!enrollment && !factors.some((factor) => factor.status === "verified") ? '<button type="button" class="button mt20" data-action="enroll-staff-mfa">Set up authenticator</button>' : ""}<p id="staff-mfa-error" class="inline-error mt20" role="alert"></p><p id="staff-mfa-status" class="help-text" role="status"></p><p class="help-text mb0">If a setup is unfinished, select it only if you already added its key to your authenticator. For a lost verified authenticator, contact the service operator; there is no bypass here.</p></section>`;
}
