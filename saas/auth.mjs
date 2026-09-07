import { localReturnPath } from "./utils.mjs";

const AUTH_URL_KEYS = [
  "code",
  "error",
  "error_code",
  "error_description",
  "access_token",
  "refresh_token",
  "provider_token",
  "provider_refresh_token",
  "token_hash",
  "token_type",
  "expires_in",
  "expires_at",
  "type",
  "sb_flow_id",
  "appscreen_link_error",
];

export function inspectAuthURL(value) {
  const url = new URL(value);
  const params = new URLSearchParams(url.search);
  for (const [key, value] of new URLSearchParams(url.hash.slice(1)))
    params.set(key, value);
  return {
    hasCode: params.has("code"),
    hasTokens: params.has("access_token") || params.has("token_hash"),
    hasError:
      params.has("appscreen_link_error") ||
      params.has("error") ||
      params.has("error_code") ||
      params.has("error_description"),
    recoveryHint: params.get("type") === "recovery",
    hasAuthParameters: AUTH_URL_KEYS.some((key) => params.has(key)),
  };
}
export function cleanAuthURL(value) {
  const url = new URL(value);
  const hash = new URLSearchParams(url.hash.slice(1));
  const authHash = AUTH_URL_KEYS.some((key) => hash.has(key));
  for (const key of AUTH_URL_KEYS) {
    url.searchParams.delete(key);
    if (authHash) hash.delete(key);
  }
  if (authHash) url.hash = hash.toString();
  return url.pathname + url.search + url.hash;
}
export function recoveryRedirect(origin, returnTo) {
  return `${origin}/reset-password?returnTo=${encodeURIComponent(localReturnPath(returnTo))}`;
}
export function authErrorMessage(error, operation = "login") {
  const code = error?.code || error?.name || "";
  if (/pkce|verifier/i.test(code))
    return "This recovery link needs the browser that requested it. Open the newest email in that browser, or request a fresh link here.";
  if (
    [
      "otp_expired",
      "flow_state_not_found",
      "flow_state_expired",
      "LINK_INVALID",
    ].includes(code)
  )
    return "This link is invalid, expired, or already used. Request a fresh link and open the newest email.";
  if (
    [
      "session_not_found",
      "refresh_token_not_found",
      "refresh_token_already_used",
      "AuthSessionMissingError",
      "reauthentication_needed",
      "SESSION_REQUIRED",
    ].includes(code)
  )
    return "Your password-change session has expired. Request a fresh recovery link or sign in again.";
  if (
    [
      "over_email_send_rate_limit",
      "over_request_rate_limit",
      "over_sms_send_rate_limit",
    ].includes(code) ||
    error?.status === 429
  )
    return "Too many requests were made. Wait before requesting another email, then try again.";
  if (code === "same_password")
    return "Choose a password different from your current password.";
  if (code === "weak_password")
    return "Choose a stronger password with at least 12 characters that meets your account provider’s password rules.";
  if (code === "email_not_confirmed")
    return "Confirm your email address before signing in. Check the confirmation email and its spam-folder location.";
  if (code === "invalid_credentials")
    return "The email or password is incorrect. Check both, or request a recovery link.";
  if (code === "PASSWORD_MISMATCH")
    return "The passwords do not match. Enter the same new password in both fields.";
  if (code === "PASSWORD_LENGTH")
    return "Use a new password between 12 and 200 characters.";
  if (["TypeError", "AuthRetryableFetchError"].includes(code))
    return "The account provider could not be reached. Check your connection and try again.";
  if (operation === "callback")
    return "This sign-in link could not be verified. Request a new email and try again.";
  if (operation === "recover")
    return "The recovery email request was not accepted. Check the address and connection, then try again.";
  if (operation === "reset")
    return "The password update was not confirmed. Try again or request a fresh recovery link.";
  if (operation === "signup")
    return "Account creation could not be confirmed. Check your details and try again.";
  return "Sign-in could not be completed. Check your details and try again.";
}
function authFailure(code, message) {
  return Object.assign(new Error(message || code), { code });
}
export async function verifyPasswordAccess(auth, callback = {}) {
  if (callback.error)
    return {
      allowed: false,
      message: authErrorMessage(callback.error, "callback"),
    };
  if (!auth)
    return {
      allowed: false,
      message: "Password recovery is not configured on this installation.",
    };
  try {
    const result = await auth.getUser();
    if (result.error || !result.data?.user?.id)
      return {
        allowed: false,
        message: authErrorMessage(
          result.error || authFailure("SESSION_REQUIRED"),
          "reset",
        ),
      };
    return {
      allowed: true,
      userId: result.data.user.id,
      email: result.data.user.email || "",
    };
  } catch (error) {
    return { allowed: false, message: authErrorMessage(error, "reset") };
  }
}
export async function requestRecoveryEmail(auth, email, redirectTo) {
  if (!auth) throw authFailure("AUTH_UNAVAILABLE");
  const result = await auth.resetPasswordForEmail(String(email || "").trim(), {
    redirectTo,
  });
  if (!result || result.error)
    throw result?.error || authFailure("INVALID_RESPONSE");
  return { accepted: true };
}
export async function updateRecoveredPassword(auth, values, callback = {}) {
  const password = String(values.password || "");
  if (password.length < 12 || password.length > 200)
    throw authFailure("PASSWORD_LENGTH");
  if (password !== values.confirmPassword)
    throw authFailure("PASSWORD_MISMATCH");
  const access = await verifyPasswordAccess(auth, callback);
  if (!access.allowed)
    throw Object.assign(authFailure("SESSION_REQUIRED"), {
      safeMessage: access.message,
    });
  const result = await auth.updateUser({ password });
  if (!result || result.error || !result.data?.user?.id)
    throw result?.error || authFailure("INVALID_RESPONSE");
  if (result.data.user.id !== access.userId)
    throw authFailure("INVALID_RESPONSE");
  return { updated: true };
}
