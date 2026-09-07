export function escapeHTML(value = "") {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

export function safeURL(value, { external = true } = {}) {
  if (typeof value !== "string" || !value.trim() || /[\\\r\n]/.test(value))
    return "";
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      external &&
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {}
  return "";
}

export function localReturnPath(value, fallback = "/app") {
  return typeof value === "string" &&
    /^\/(?!\/)/.test(value) &&
    !/[\\\r\n]/.test(value)
    ? value
    : fallback;
}

export function formatDate(value) {
  if (!value) return "Just created";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
}

export function formatCredits(value) {
  const amount =
    typeof value === "number" ? value : (value?.available ?? value?.balance);
  return Number.isFinite(Number(amount)) &&
    amount !== null &&
    amount !== undefined
    ? new Intl.NumberFormat().format(Number(amount))
    : "—";
}

export function validateFileMetadata(file, maxBytes = 15 * 1024 * 1024) {
  if (!["image/png", "image/jpeg"].includes(file.type))
    return "Use a PNG or JPEG screenshot.";
  if (file.size > maxBytes)
    return `Keep each screenshot under ${Math.round(maxBytes / 1024 / 1024)} MB.`;
  if (!file.size) return "This file is empty. Choose a different screenshot.";
  return null;
}

export const TERMINAL_STATES = new Set([
  "ready",
  "completed",
  "succeeded",
  "review-needed",
  "needs-input",
  "needs_input",
  "failed",
  "cancelled",
]);
export const STAGES = [
  "queued",
  "analyzing",
  "planning",
  "composing",
  "rendering",
  "checking",
  "repairing",
  "ready",
];
export const STAGE_LABELS = {
  queued: "Waiting to start",
  analyzing: "Understanding your screenshots",
  planning: "Planning your story",
  composing: "Designing your campaign",
  designing: "Designing your campaign",
  rendering: "Rendering your screens",
  checking: "Checking the design",
  repairing: "Refining the details",
  ready: "Your draft is ready",
  completed: "Your draft is ready",
  succeeded: "Your draft is ready",
  "review-needed": "Your draft needs a review",
  "needs-input": "A little more information is needed",
  needs_input: "A little more information is needed",
  failed: "This job needs attention",
  cancelling: "Stopping generation",
  cancelled: "Generation cancelled",
};

export function jobState(job) {
  const status = job?.status || job?.state || "queued";
  return job?.cancelRequested && !TERMINAL_STATES.has(status)
    ? "cancelling"
    : status;
}
export function stageLabel(job) {
  if (jobState(job) === "cancelling") return STAGE_LABELS.cancelling;
  if (
    ["needs-input", "needs_input"].includes(jobState(job)) &&
    jobRevisionId(job)
  )
    return "Your draft needs a review";
  return (
    job?.stageLabel ||
    STAGE_LABELS[job?.stage] ||
    STAGE_LABELS[jobState(job)] ||
    "Working on your campaign"
  );
}
export function revisionId(revision) {
  return revision?.id || revision?.revisionId || null;
}
export function jobRevisionId(job) {
  return (
    job?.result?.revisionId || job?.outputRevisionId || job?.revisionId || null
  );
}
export function getPreviews(value) {
  const raw =
    value?.previews ||
    value?.result?.previews ||
    value?.artifacts?.previews ||
    [];
  return Array.isArray(raw)
    ? raw.map((item, index) =>
        typeof item === "string"
          ? { url: item, sceneId: String(index + 1) }
          : item,
      )
    : [];
}

export function normalizePlans(plans) {
  if (Array.isArray(plans)) return plans;
  return plans && typeof plans === "object"
    ? Object.entries(plans).map(([id, plan]) => ({ id, ...plan }))
    : [];
}

export function planPrice(plan) {
  if (plan.priceLabel) return String(plan.priceLabel);
  const amount = plan.priceAmount ?? plan.unitAmount ?? plan.amount;
  if (!Number.isFinite(amount)) return "Pricing is being prepared";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: plan.currency || "USD",
      maximumFractionDigits: amount % 100 ? 2 : 0,
    }).format(amount / 100);
  } catch {
    return "Pricing is being prepared";
  }
}
