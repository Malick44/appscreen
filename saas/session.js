import { inspectAuthURL, cleanAuthURL } from "./auth.mjs";

let config;
let client;
let initialized;
const DEV_TOKEN_KEY = "appscreen.dev.token";
const callbackState = {
  ...inspectAuthURL(window.location.href),
  error: null,
  recoveryEvent: false,
};

export async function configureSession(value) {
  config = value;
  if (config.auth?.provider !== "supabase") return;
  if (initialized) return initialized;
  initialized = (async () => {
    if (!window.supabase?.createClient) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/saas/vendor/supabase.js";
        script.onload = resolve;
        script.onerror = () =>
          reject(
            new Error(
              "Account tools could not load. Refresh the page to try again.",
            ),
          );
        document.head.append(script);
      });
    }
    client = window.supabase.createClient(
      config.auth.url,
      config.auth.publishableKey,
      {
        auth: {
          storageKey: "appscreen.auth",
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      },
    );
    client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") callbackState.recoveryEvent = true;
    });
    const result = await client.auth.initialize();
    callbackState.error = result.error
      ? {
          code: result.error.code || result.error.name || "LINK_INVALID",
          status: result.error.status,
        }
      : null;
    if (!callbackState.error && callbackState.hasError)
      callbackState.error = { code: "LINK_INVALID" };
    // A code left in the URL was not exchanged (usually a missing same-browser PKCE verifier).
    if (
      !callbackState.error &&
      callbackState.hasCode &&
      new URL(window.location.href).searchParams.has("code")
    )
      callbackState.error = { code: "pkce_verifier_missing" };
    if (!callbackState.error && callbackState.hasTokens)
      callbackState.error = { code: "LINK_INVALID" };
    if (callbackState.hasAuthParameters) {
      const cleaned = new URL(
        cleanAuthURL(window.location.href),
        window.location.href,
      );
      // Keep a non-secret failure marker across refreshes so an expired link cannot fall back to an unrelated existing session.
      if (callbackState.error)
        cleaned.searchParams.set("appscreen_link_error", "1");
      history.replaceState(
        history.state,
        "",
        cleaned.pathname + cleaned.search + cleaned.hash,
      );
    }
    await client.auth.getSession();
  })();
  return initialized;
}

export async function getAccessToken() {
  if (config?.auth?.provider === "development")
    return sessionStorage.getItem(DEV_TOKEN_KEY);
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token || null;
}

export function setDevelopmentToken(token) {
  if (config?.auth?.provider !== "development")
    throw new Error("Development sign-in is not enabled.");
  sessionStorage.setItem(DEV_TOKEN_KEY, token);
}

export async function signOut() {
  sessionStorage.removeItem(DEV_TOKEN_KEY);
  if (client) {
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }
}

export function authClient() {
  return client;
}
export function authCallbackState() {
  return { ...callbackState };
}
window.AppScreenSession = { getAccessToken };
