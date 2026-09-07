import { escapeHTML as e } from "./utils.mjs";

export const EMAIL_PREFERENCES_PATH = "/api/notifications/email-preferences";

export function normalizeEmailPreferences(value) {
  if (
    typeof value?.enabled !== "boolean" ||
    typeof value.sendingAvailable !== "boolean" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    (value.updatedAt !== null &&
      (typeof value.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt))))
  )
    throw new Error("The email preference response was incomplete.");
  return {
    enabled: value.enabled,
    version: value.version,
    sendingAvailable: value.sendingAvailable,
    updatedAt: value.updatedAt,
  };
}

// All writes require an explicit save. A conflict must be reloaded and reviewed.
export function createEmailPreferences(request, onChange = () => {}) {
  let current = {
    preferences: null,
    enabled: false,
    status: "loading",
    error: "",
    reloadRequired: false,
  };
  let pending = false;
  const snapshot = () => ({
    ...current,
    preferences: current.preferences ? { ...current.preferences } : null,
  });
  const update = (values) => {
    current = { ...current, ...values };
    onChange(snapshot());
  };
  return {
    snapshot,
    async load() {
      if (pending) return;
      pending = true;
      update({ status: "loading", error: "" });
      try {
        const preferences = normalizeEmailPreferences(
          await request(EMAIL_PREFERENCES_PATH, { timeout: 10000 }),
        );
        update({
          preferences,
          enabled: preferences.enabled,
          status: "idle",
          reloadRequired: false,
        });
      } catch {
        update({
          status: "error",
          reloadRequired: true,
          error: "Email preferences could not load. Retry loading to check your saved choice.",
        });
      } finally {
        pending = false;
      }
    },
    change(enabled) {
      if (
        pending ||
        current.status === "error" ||
        current.reloadRequired ||
        !current.preferences ||
        typeof enabled !== "boolean" ||
        (enabled && !current.preferences.sendingAvailable)
      )
        return;
      update({
        enabled,
        status: enabled === current.preferences.enabled ? "idle" : "dirty",
        error: "",
      });
    },
    async save() {
      if (
        pending ||
        current.reloadRequired ||
        !current.preferences ||
        !["dirty", "error"].includes(current.status) ||
        current.enabled === current.preferences.enabled ||
        (current.enabled && !current.preferences.sendingAvailable)
      )
        return;
      const body = {
        enabled: current.enabled,
        expectedVersion: current.preferences.version,
      };
      pending = true;
      update({ status: "saving", error: "" });
      try {
        const preferences = normalizeEmailPreferences(
          await request(EMAIL_PREFERENCES_PATH, {
            method: "POST",
            body,
            timeout: 10000,
          }),
        );
        if (
          preferences.enabled !== body.enabled ||
          preferences.version <= body.expectedVersion
        )
          throw new Error("The saved preference was not confirmed.");
        update({ preferences, enabled: preferences.enabled, status: "saved" });
      } catch (error) {
        const conflict =
          error?.code === "EMAIL_PREFERENCES_CHANGED" || error?.status === 409;
        const unavailable = error?.code === "EMAIL_SENDING_UNAVAILABLE";
        update({
          status: "error",
          reloadRequired: conflict || unavailable,
          error: conflict
            ? "Your saved preference changed in another session. Reload preferences and review the current choice before saving again."
            : unavailable
              ? "Email delivery is no longer available. Reload preferences to check the service and your saved choice."
              : "Saving was not confirmed. Retry saving your choice, or reload preferences to check what was saved.",
        });
      } finally {
        pending = false;
      }
    },
  };
}

export function emailPreferencesMarkup(view) {
  const { preferences, enabled, status, error, reloadRequired } = view;
  const loading = status === "loading";
  const saving = status === "saving";
  const ready =
    preferences &&
    !loading &&
    !saving &&
    !reloadRequired;
  const canEdit =
    ready && status !== "error" && (preferences.sendingAvailable || enabled);
  const canSave =
    ready &&
    enabled !== preferences.enabled &&
    (!enabled || preferences.sendingAvailable) &&
    ["dirty", "error"].includes(status);
  const message = loading
    ? "Loading email preferences…"
    : saving
      ? "Saving preferences…"
      : status === "saved"
        ? "Email preferences saved."
        : status === "dirty"
          ? "You have an unsaved change."
          : status === "error"
            ? ""
            : `Email notices are ${preferences?.enabled ? "on" : "off"}.`;
  return `<section class="panel email-preferences" aria-labelledby="email-preferences-title" ${loading || saving ? 'aria-busy="true"' : ""}><div class="email-preferences-intro"><h2 id="email-preferences-title">Email preferences</h2><p class="help-text">Send new campaign, support, and billing notices to your verified account email. Authentication and recovery emails are managed separately.</p></div>${preferences?.sendingAvailable === false ? '<p id="email-delivery-unavailable" class="notice warning"><strong>Email delivery is not configured.</strong> AppScreen is not sending these emails. You can turn off a saved preference; enabling email is unavailable.</p>' : ""}<form id="email-preferences-form"><div class="email-preferences-row"><label class="check email-preferences-choice" for="email-preferences-enabled"><input id="email-preferences-enabled" name="enabled" type="checkbox" ${enabled ? "checked" : ""} ${canEdit ? "" : "disabled"} aria-describedby="email-preferences-detail${preferences?.sendingAvailable === false ? " email-delivery-unavailable" : ""}"><span>Email me workspace updates<small id="email-preferences-detail">Only new notices after you opt in. Turning this off cannot recall emails already sent.</small></span></label><button id="email-preferences-save" class="button primary" type="submit" ${canSave ? "" : "disabled"} ${saving ? 'aria-busy="true"' : ""}>${saving ? "Saving preferences…" : status === "error" && !reloadRequired ? "Retry saving preferences" : "Save preferences"}</button></div><p id="email-preferences-status" class="help-text email-preferences-status" role="status" aria-live="polite">${e(message)}</p><p class="inline-error" role="alert">${e(error)}</p>${status === "error" ? `<button id="email-preferences-reload" type="button" class="button quiet">${preferences ? "Reload preferences" : "Retry loading preferences"}</button>` : ""}</form></section>`;
}
