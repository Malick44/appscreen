import { escapeHTML as e } from "./utils.mjs";
import { resourceId, messageTime } from "./engagement.mjs";

const DELIVERY = {
  "review-needed": "Delivery needs review",
  failed: "Failed",
  bounced: "Bounced",
  complained: "Complaint received",
  suppressed: "Suppressed",
  delayed: "Delayed",
  accepted: "Accepted · no final evidence",
};
const REVIEWS = {
  open: "Open review",
  investigating: "Investigating",
  "closed-no-resend": "Closed · no resend",
};
const CONFIRMATION = "RECORD EMAIL REVIEW";
const integer = (value, minimum = 0, maximum = 2147483647) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const own = (object, key) => Object.hasOwn(object, key);

export function emailIncidentFilter(value) {
  return ["open", "reviewed", "all"].includes(value) ? value : "open";
}

// A deliberately narrow projection: never render private fields from a response.
export function normalizeEmailIncident(value) {
  if (
    !resourceId(value?.id) || !resourceId(value.workspaceId) ||
    !own(DELIVERY, value.status) || !own(REVIEWS, value.reviewState) ||
    !integer(value.attempts) || !integer(value.deliveryVersion, 1) ||
    !integer(value.reviewVersion) || typeof value.previousReviewStale !== "boolean" ||
    ![value.createdAt, value.updatedAt].every((date) =>
      typeof date === "string" && Number.isFinite(Date.parse(date))) ||
    !(value.errorCode === null ||
      (typeof value.errorCode === "string" && /^[A-Z0-9_]{1,100}$/.test(value.errorCode)))
  ) throw new Error("The email evidence response was incomplete. Reload the queue before reviewing it.");
  return Object.fromEntries([
    "id", "workspaceId", "status", "errorCode", "attempts", "createdAt", "updatedAt",
    "deliveryVersion", "reviewVersion", "reviewState", "previousReviewStale",
  ].map((key) => [key, value[key]]));
}

export function normalizeEmailIncidents(value) {
  if (!Array.isArray(value?.incidents) ||
    !(value.nextCursor === null || (typeof value.nextCursor === "string" &&
      /^[A-Za-z0-9_-]{1,1000}$/.test(value.nextCursor))))
    throw new Error("The incident queue response was incomplete. Reload to try again.");
  const incidents = value.incidents.map(normalizeEmailIncident);
  if (new Set(incidents.map((item) => item.id)).size !== incidents.length)
    throw new Error("The incident queue contained duplicate evidence. Reload to try again.");
  return { incidents, nextCursor: value.nextCursor };
}

export function normalizeEmailReport(value) {
  if (typeof value?.sendingEnabled !== "boolean" || !integer(value.openIncidents) ||
      !integer(value.reviewRequired) || !Number.isFinite(value.oldestPendingSeconds) ||
      value.oldestPendingSeconds < 0 || !Array.isArray(value.counts))
    throw new Error("The email summary could not be read.");
  return {
    sendingEnabled: value.sendingEnabled,
    openIncidents: value.openIncidents,
    reviewRequired: value.reviewRequired,
    oldestPendingSeconds: value.oldestPendingSeconds,
  };
}

function reviewPayload(value) {
  const reason = typeof value?.reason === "string" ? value.reason.trim() : "";
  if (!["investigating", "closed-no-resend"].includes(value?.disposition))
    throw new Error("Choose a staff decision.");
  if (reason.length < 10 || reason.length > 1000)
    throw new Error("Add a review reason between 10 and 1,000 characters. Do not include personal data or credentials.");
  if (!integer(value.expectedDeliveryVersion, 1, 2147483646) || !integer(value.expectedReviewVersion, 0, 2147483646) ||
    typeof value.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{8,200}$/.test(value.idempotencyKey) || value.confirmation !== CONFIRMATION)
    throw new Error("This review is missing its original evidence or retry identity. Reload the queue.");
  return {
    disposition: value.disposition, reason,
    expectedDeliveryVersion: value.expectedDeliveryVersion,
    expectedReviewVersion: value.expectedReviewVersion,
    idempotencyKey: value.idempotencyKey, confirmation: CONFIRMATION,
  };
}

function normalizePending(value) {
  const incident = normalizeEmailIncident(value?.incident);
  const payload = reviewPayload(value.payload);
  if (payload.expectedDeliveryVersion !== incident.deliveryVersion ||
    payload.expectedReviewVersion !== incident.reviewVersion)
    throw new Error("The saved review does not match its evidence. Do not submit a new review until this tab’s pending request is recovered.");
  return { incident, payload };
}

// Tab-only storage, scoped to the authorized user AND their active workspace.
// Persist before dispatch, so a reload cannot silently manufacture a new key.
export function createEmailReviewStore(storage, userId, workspaceId) {
  if (!resourceId(userId) || !resourceId(workspaceId))
    throw new Error("A verified staff session is required to retain a review safely.");
  const prefix = `appscreen.email-review:${userId}:${workspaceId}:`;
  return {
    list() {
      const pending = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const value = normalizePending(JSON.parse(storage.getItem(key)));
        if (key !== prefix + value.incident.id) throw new Error("The saved review identity is incomplete.");
        pending.push(value);
      }
      return pending;
    },
    put(value) {
      const pending = normalizePending(value);
      const key = prefix + pending.incident.id;
      const serialized = JSON.stringify(pending);
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw new Error("Review storage was unavailable.");
    },
    remove(id) { storage.removeItem(prefix + resourceId(id)); },
  };
}

export function clearEmailReviewStorage(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith("appscreen.email-review:")) keys.push(key);
  }
  for (const key of keys) {
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error("Saved staff notes could not be cleared.");
  }
}

export function createEmailReview(request, store, evidence, makeKey = () => crypto.randomUUID()) {
  const incident = normalizeEmailIncident(evidence);
  const pending = store.list().find((item) => item.incident.id === incident.id);
  let current = {
    incident: pending?.incident || incident,
    payload: pending?.payload || null,
    phase: pending ? "uncertain" : "draft",
    message: pending ? "This tab has an unconfirmed review. Retry its exact saved decision and reason to check the original outcome." : "",
  };
  const snapshot = () => structuredClone(current);
  return {
    snapshot,
    prepare(values) {
      if (current.phase !== "draft") return snapshot();
      current.payload = reviewPayload({ ...values,
        expectedDeliveryVersion: current.incident.deliveryVersion,
        expectedReviewVersion: current.incident.reviewVersion,
        idempotencyKey: makeKey(), confirmation: CONFIRMATION,
      });
      current.phase = "confirm";
      current.message = "";
      return snapshot();
    },
    edit() {
      if (current.phase === "confirm") current.phase = "draft";
      return snapshot();
    },
    async record(confirmed) {
      if (!["confirm", "uncertain", "storage-error"].includes(current.phase)) return snapshot();
      if (confirmed !== true) {
        current.message = "Confirm that this records a staff decision only before continuing.";
        return snapshot();
      }
      try { store.put({ incident: current.incident, payload: current.payload }); }
      catch {
        current.phase = "storage-error";
        current.message = "This tab cannot retain a safe retry. No new request was sent. Restore browser session storage, then retry; an earlier outcome may still be unknown.";
        return snapshot();
      }
      current.phase = "saving";
      current.message = "Recording the staff review…";
      try {
        const response = await request(`/api/operator/email/incidents/${encodeURIComponent(current.incident.id)}/review`, {
          method: "POST", body: structuredClone(current.payload),
        });
        const receipt = normalizeEmailIncident(response?.incident);
        if (receipt.id !== current.incident.id || receipt.workspaceId !== current.incident.workspaceId ||
          receipt.deliveryVersion !== current.payload.expectedDeliveryVersion ||
          receipt.reviewVersion !== current.payload.expectedReviewVersion + 1 ||
          receipt.reviewState !== current.payload.disposition || receipt.previousReviewStale)
          throw new Error("The response did not confirm the exact review.");
        current.phase = "saved";
        current.message = "Staff review recorded. Delivery evidence and suppression are unchanged. No email or notification was sent. Reload the queue for current evidence; this receipt may describe an earlier review.";
        try { store.remove(current.incident.id); }
        catch { current.message += " The saved retry could not be cleared from this tab; retrying it only checks this same receipt."; }
      } catch (error) {
        if (error.status === 403 || error.code === "OPERATOR_REQUIRED" || error.status === 401) {
          current.phase = "forbidden";
          current.message = "Staff access is no longer available. No further reviews can be submitted. Sign in with authorized staff access to check the saved request.";
        } else if (["EMAIL_INCIDENT_CHANGED", "EMAIL_INCIDENT_NOT_ACTIVE", "EMAIL_INCIDENT_NOT_FOUND"].includes(error.code)) {
          current.phase = "stale";
          current.message = error.code === "EMAIL_INCIDENT_CHANGED"
            ? "The delivery evidence or staff review changed. This decision was not recorded. Reload the queue and review the latest evidence."
            : "This email is no longer an active incident. This decision was not recorded. Reload the queue for current evidence.";
          try { store.remove(current.incident.id); } catch {}
        } else {
          current.phase = "uncertain";
          current.message = "The review outcome is unconfirmed. Its decision, reason, and retry identity are frozen in this tab. Retry the same review to check the outcome; do not create another decision.";
        }
      }
      return snapshot();
    },
  };
}

function action(label, name, id = "", disabled = false) {
  return `<button type="button" class="button" data-email-action="${name}"${id ? ` data-id="${e(id)}"` : ""}${disabled ? " disabled" : ""}>${e(label)}</button>`;
}
function reference(id) { return id.slice(0, 8).toUpperCase(); }

export function emailOperationsMarkup(view) {
  const filter = emailIncidentFilter(view.filter);
  const blocked = !!view.pendingError || !!view.error || !!view.reloadRequired;
  const report = view.report;
  return `<p class="notice email-review-boundary">Record a staff decision, not a delivery fix. Reviews never send email, send notifications, change delivery evidence, or remove suppression.</p>
    <section class="panel email-health" aria-label="Email status summary">${report ? `<div><span class="help-text">Staff reviews still open</span><strong>${e(report.openIncidents)}</strong></div><div><span class="help-text">Delivery needs review</span><strong>${e(report.reviewRequired)}</strong></div><div><span class="help-text">Oldest pending email</span><strong>${e(report.oldestPendingSeconds ? `${Math.ceil(report.oldestPendingSeconds / 60)} min` : "None")}</strong></div><p class="help-text mb0">${report.sendingEnabled ? "Email sending is enabled. This page does not send email." : "Email sending is disabled. This page does not enable or send email."}</p>` : `<p class="help-text mb0" role="status">${view.loading ? "Loading email summary…" : "Email summary unavailable. Reload to try again; any queue evidence below is separate."}</p>`}</section>
    <section class="email-pending" aria-label="Unconfirmed staff reviews">${view.pendingError ? `<p class="notice error" role="alert">Saved reviews could not be recovered from this tab. New reviews are blocked so an unconfirmed request is not duplicated. Restore session storage, then reload.</p>` : view.pending?.length ? `<div class="notice warning"><h2>Unconfirmed reviews in this tab</h2><p>These exact requests are retained until their outcomes are confirmed, even if an incident leaves this view. Reasons stay in this tab’s session storage until confirmed, sign-out, or this tab is closed.</p><div class="actions">${view.pending.map(({ incident }) => action(`Check review ${reference(incident.id)}`, "resume", incident.id, view.loading)).join("")}</div></div>` : ""}</section>
    <div class="email-queue-toolbar"><div class="field"><label for="email-incident-filter">Staff review state</label><select id="email-incident-filter"${view.loading ? " disabled" : ""}><option value="open"${filter === "open" ? " selected" : ""}>Open / investigating</option><option value="reviewed"${filter === "reviewed" ? " selected" : ""}>Closed for current evidence</option><option value="all"${filter === "all" ? " selected" : ""}>All current incidents</option></select></div>${action("Reload queue", "reload", "", view.loading)}</div>
    <p class="help-text" id="email-queue-scope">Only emails currently needing attention appear here—not a full delivery history. New evidence can reopen a review or remove the email from this queue.</p>
    <p id="email-queue-feedback" class="${view.error ? "notice error" : "help-text"}" role="${view.error ? "alert" : "status"}" tabindex="-1">${e(view.error || view.feedback || (view.loading ? "Loading current email evidence…" : `${view.incidents.length} incident${view.incidents.length === 1 ? "" : "s"} shown`))}</p>
    <div class="email-incident-list" aria-describedby="email-queue-scope"${view.loading ? ' aria-busy="true"' : ""}>${view.incidents.length ? view.incidents.map((incident) => emailIncidentMarkup(incident, blocked || view.loading, view.pending?.some((item) => item.incident.id === incident.id))).join("") : !view.loading && !view.error ? `<section class="panel"><h2>No ${filter === "reviewed" ? "closed reviews for current evidence" : filter === "all" ? "current email incidents" : "open staff reviews"}</h2><p class="mb0">${filter === "open" ? "Closed reviews remain available in the state filter while their email still needs attention. This does not confirm delivery." : "Reload to check for new delivery evidence. This queue is not a delivery history."}</p></section>` : ""}</div>
    ${view.nextCursor ? `<div class="actions mt20">${action(view.loadingMore ? "Loading more…" : "Load more incidents", "more", "", view.loading || view.loadingMore)}</div>` : ""}`;
}

export function emailIncidentMarkup(incident, disabled = false, pending = false) {
  const item = normalizeEmailIncident(incident);
  return `<article class="panel email-incident" id="email-incident-${e(item.id)}" aria-labelledby="email-title-${e(item.id)}"><h2 id="email-title-${e(item.id)}" tabindex="-1">Email incident <span class="operator-id">${e(reference(item.id))}</span></h2><div class="email-incident-columns"><section aria-label="Delivery evidence"><h3>Delivery evidence</h3><p class="badge email-delivery-status">${e(DELIVERY[item.status])}</p><dl class="operator-details"><div><dt>Evidence version</dt><dd>${e(item.deliveryVersion)}</dd></div><div><dt>Attempts</dt><dd>${e(item.attempts)}</dd></div><div><dt>Last error code</dt><dd class="operator-id">${e(item.errorCode || "None recorded")}</dd></div><div><dt>Created</dt><dd>${e(messageTime(item.createdAt))}</dd></div><div><dt>Evidence updated</dt><dd>${e(messageTime(item.updatedAt))}</dd></div><div><dt>Workspace</dt><dd class="operator-id">${e(item.workspaceId)}</dd></div><div><dt>Incident</dt><dd class="operator-id">${e(item.id)}</dd></div></dl></section><section class="email-staff-decision" aria-label="Staff decision"><h3>Staff decision</h3><p class="badge">${e(REVIEWS[item.reviewState])}</p><p class="help-text">Review version ${e(item.reviewVersion)} · separate from delivery</p>${item.previousReviewStale ? '<p class="notice warning">New delivery evidence reopened this review. The previous decision does not cover this evidence.</p>' : ""}<p>${item.reviewState === "closed-no-resend" ? "Staff review is closed for this evidence only. The delivery condition and any suppression remain unchanged." : item.reviewState === "investigating" ? "Staff investigation is open. Recording this decision did not change delivery or send another email." : "No staff decision covers the current evidence. Review the metadata and record the next staff decision."}</p>${action(pending ? "Check unconfirmed review" : "Review incident", pending ? "resume" : "review", item.id, disabled)}</section></div></article>`;
}

export function emailReviewMarkup(view) {
  const { incident, payload, phase } = view;
  const draft = phase === "draft";
  const saving = phase === "saving";
  const terminal = ["saved", "stale", "forbidden"].includes(phase);
  return `<form id="email-review-form" class="email-review-form"${saving ? ' aria-busy="true"' : ""}><p class="eyebrow">Staff decision only</p><h2 id="modal-title">${phase === "saved" ? "Staff review recorded" : "Review email incident"}</h2><p class="operator-id">Incident ${e(incident.id)} · evidence ${e(incident.deliveryVersion)} · review ${e(incident.reviewVersion)}</p><p>Closing a review does not resolve delivery, remove suppression, or resend email. No notification is sent.</p>${draft ? `<div class="field"><label for="email-review-disposition">Staff decision</label><select id="email-review-disposition" name="disposition"><option value="investigating"${payload?.disposition === "investigating" ? " selected" : ""}>Investigating</option><option value="closed-no-resend"${payload?.disposition === "closed-no-resend" ? " selected" : ""}>Close staff review · no resend</option></select></div><div class="field"><label for="email-review-reason">Review reason</label><textarea id="email-review-reason" name="reason" required minlength="10" maxlength="1000" rows="4" aria-describedby="email-reason-help">${e(payload?.reason || "")}</textarea><p id="email-reason-help" class="help-text">10–1,000 characters. Do not include personal data, email addresses, message content, or credentials. The reason is recorded in the staff audit trail and temporarily retained in this tab for a safe retry.</p></div>` : phase !== "forbidden" ? `<dl class="operator-details"><div><dt>Decision</dt><dd>${e(REVIEWS[payload.disposition])}</dd></div><div><dt>Reason</dt><dd class="email-review-reason">${e(payload.reason)}</dd></div></dl>${!terminal ? '<label class="check email-review-confirm"><input id="email-review-confirmed" name="confirmed" type="checkbox" required><span>I confirm: RECORD EMAIL REVIEW. This records the staff decision above only; it does not change delivery or send email.</span></label>' : ""}` : ""}<p id="email-review-feedback" class="${["uncertain", "storage-error", "stale", "forbidden"].includes(phase) ? "notice warning" : "help-text"}" role="${["uncertain", "storage-error", "stale", "forbidden"].includes(phase) ? "alert" : "status"}" tabindex="-1">${e(view.message)}</p><div class="actions">${!terminal ? `<button class="button primary" type="submit"${saving ? " disabled" : ""}>${draft ? "Continue to confirmation" : saving ? "Recording review…" : phase === "uncertain" ? "Retry record review" : "Record review"}</button>` : ""}${phase === "confirm" ? action("Edit decision", "edit") : ""}${["saved", "stale"].includes(phase) ? action("Reload queue", "reload-close") : ""}${action(terminal ? "Close" : ["uncertain", "storage-error"].includes(phase) ? "Close · keep pending review" : "Cancel", "close", "", saving)}</div></form>`;
}
