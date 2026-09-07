import {
  escapeHTML as e,
  safeURL,
  localReturnPath,
  formatDate,
  formatCredits,
  validateFileMetadata,
  TERMINAL_STATES,
  STAGES,
  stageLabel,
  jobState,
  revisionId,
  jobRevisionId,
  getPreviews,
  normalizePlans,
  planPrice,
} from "./utils.mjs";
import {
  configureSession,
  getAccessToken,
  setDevelopmentToken,
  signOut,
  authClient,
  authCallbackState,
} from "./session.js";
import { api } from "./api.js";
import {
  SUPPORT_STATUSES,
  resourceId,
  normalizeNotifications,
  inboxMarkup,
  supportListMarkup,
  supportConversationMarkup,
  supportAccessMarkup,
  parseSupportReply,
  parseSupportStatus,
  supportReviewMarkup,
  supportErrorMessage,
  createActionIntent,
} from "./engagement.mjs";
import { reportDays, operationsReportMarkup } from "./report.mjs";
import {
  emailIncidentFilter,
  normalizeEmailIncidents,
  normalizeEmailReport,
  createEmailReviewStore,
  clearEmailReviewStorage,
  createEmailReview,
  emailOperationsMarkup,
  emailReviewMarkup,
} from "./email-operations.mjs";
import {
  createEmailPreferences,
  emailPreferencesMarkup,
} from "./email.mjs";
import {
  NOTICES_PATH,
  noticesFooterLink,
  loadLicenseNotices,
  thirdPartyNoticesMarkup,
} from "./notices.mjs";
import { validateArchiveDownload } from "./download.mjs";
import { createBackupImport } from "./backup-import.mjs";
import {
  deletionStatusMarkup,
  lifecycleActionKey,
  completeLifecycleAction,
  deletionCancellationTarget,
} from "./lifecycle.mjs";
import {
  staffMfaAllowed,
  mfaErrorMessage,
  listStaffFactors,
  enrollStaffFactor,
  verifyStaffFactor,
  staffMfaMarkup,
} from "./mfa.mjs";
import {
  authErrorMessage,
  verifyPasswordAccess,
  recoveryRedirect,
  requestRecoveryEmail,
  updateRecoveredPassword,
} from "./auth.mjs";
import { defaultDraft, briefPayload } from "./brief.mjs";
import {
  assessTemplateSelection,
  templateCompatibilityLabel,
} from "./template-selection.mjs";
import {
  safeOAuthRedirect,
  oauthConsentMarkup,
  oauthReconnectMarkup,
  reconnectSelection,
} from "./oauth.mjs";
import {
  operatorOverviewMarkup,
  operatorJobMarkup,
  parseCreditAdjustment,
  creditReviewMarkup,
  creditReceiptMarkup,
} from "./operator.mjs";

const root = document.querySelector("#app");
const modal = document.querySelector("#modal");
const state = {
  config: null,
  session: null,
  templates: [],
  project: null,
  route: "",
  routeVersion: 0,
  poll: null,
  drafts: new Map(),
  briefSaves: new Map(),
  operationKeys: new Map(),
  uploading: false,
  backupImport: null,
  oauthConsent: null,
  oauthReconnect: null,
  staffMfa: { factors: [], enrollment: null },
  deletionLifecycle: null,
  unreadCount: null,
  inbox: null,
  emailPreferences: null,
  emailOperations: null,
  supportList: null,
  supportDetail: null,
  supportIntents: new Map(),
};
const iconPaths = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  upload:
    '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  screens:
    '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2"/>',
  wand: '<path d="m4 20 12-12 4 4L8 24M14 2v4m-2-2h4M5 5v4M3 7h4M20 19v4m-2-2h4" transform="translate(0 -3)"/>',
  credit:
    '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20M6 15h4"/>',
  settings:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3v.1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  link: '<path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  logout: '<path d="M9 3H4v18h5m5-15 6 6-6 6M8 12h12"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  inbox: '<path d="M3 5h18v14H3zM3 12h5l2 3h4l2-3h5"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.arrow}</svg>`;
}
function brand() {
  return '<a class="brand" href="/" data-link><span class="brand-mark" aria-hidden="true">a</span>AppScreen</a>';
}
function button(label, action, options = {}) {
  return `<button type="button" class="button ${options.primary ? "primary" : options.danger ? "danger" : options.quiet ? "quiet" : ""} ${options.small ? "small" : ""}" data-action="${e(action)}" ${options.id ? `data-id="${e(options.id)}"` : ""} ${options.disabled ? "disabled" : ""}>${options.icon ? icon(options.icon) : ""}${e(label)}</button>`;
}
function notice(message, kind = "", id = "") {
  return `<div class="notice ${kind}" ${id ? `id="${id}"` : ""} ${kind === "error" ? 'role="alert"' : ""}>${message}</div>`;
}
function announce(message) {
  document.querySelector("#announcer").textContent = message;
}
function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast ${error ? "error" : ""}`;
  item.innerHTML = `<span>${e(message)}</span><button aria-label="Dismiss notification">×</button>`;
  item.querySelector("button").onclick = () => item.remove();
  document.querySelector("#toasts").append(item);
  setTimeout(() => item.remove(), error ? 14000 : 7000);
}
function busy(element, label) {
  const old = element.innerHTML;
  element.disabled = true;
  element.setAttribute("aria-busy", "true");
  element.textContent = label;
  return () => {
    element.disabled = false;
    element.removeAttribute("aria-busy");
    element.innerHTML = old;
  };
}
function operationKey(kind, data) {
  const fingerprint = `${kind}:${JSON.stringify(data)}`;
  if (!state.operationKeys.has(fingerprint))
    state.operationKeys.set(fingerprint, crypto.randomUUID());
  return state.operationKeys.get(fingerprint);
}
function publicHeader() {
  return `<header class="public-nav">${brand()}<nav class="nav-links" aria-label="Main navigation"><a href="/pricing" data-link>Pricing</a><a href="/help" data-link>How it works</a><a class="button quiet" href="${state.session ? "/app" : "/login"}" data-link>${state.session ? "My workspace" : "Sign in"}</a><a class="button primary" href="${state.session ? "/app" : "/signup"}" data-link>Start a campaign ${icon("arrow")}</a></nav></header>`;
}
function footer() {
  return `<footer class="public-footer"><span>AppScreen · Made for the app you made.</span><nav class="nav-links" aria-label="Footer"><a href="/help" data-link>Help</a><a href="/privacy" data-link>Privacy</a><a href="/terms" data-link>Terms</a>${noticesFooterLink()}<a href="/editor">Local editor</a></nav></footer>`;
}
function publicPage(content) {
  return `${publicHeader()}<main id="main" tabindex="-1">${content}</main>${footer()}`;
}
function shell(content, selected = "projects") {
  const nav = [
    ["projects", "/app", "grid", "Campaigns"],
    [
      "inbox",
      "/app/inbox",
      "inbox",
      `Inbox${Number.isInteger(state.unreadCount) && state.unreadCount > 0 ? ` · ${state.unreadCount}` : ""}`,
    ],
    ["billing", "/app/billing", "credit", "Usage & billing"],
    ["settings", "/app/settings", "settings", "Account"],
    ["connections", "/app/connections", "link", "Agent connections"],
    ["support", "/app/support", "help", "Support"],
    ["help", "/help", "help", "Help"],
  ];
  if (
    state.session?.operator === true ||
    state.session?.operatorMfaRequired === true
  )
    nav.splice(nav.length - 1, 0, [
      "operator",
      "/app/operator",
      "lock",
      state.session.operator ? "Operations" : "Staff verification",
    ]);
  return `<div class="workspace"><aside class="sidebar"><div class="sidebar-brand">${brand()}<a class="header-mobile button small quiet" href="/app/settings" data-link>Account</a></div><div><p class="workspace-name">${e(state.session?.workspace?.name || "Your workspace")}</p><nav class="side-links" aria-label="Workspace">${nav.map(([key, url, glyph, label]) => `<a class="side-link ${selected === key ? "active" : ""}" href="${url}" data-link ${selected === key ? 'aria-current="page"' : ""}>${icon(glyph)}${label}</a>`).join("")}</nav></div><div class="sidebar-bottom"><a href="/app/billing" data-link class="credit-mini"><strong>${formatCredits(state.session?.credits)}</strong>AI credits available</a><span class="account-name">${e(state.session?.user?.email || "Signed in")}</span>${button("Sign out", "sign-out", { icon: "logout", quiet: true })}${state.config.auth?.provider === "development" ? '<span class="connection-pill">Local development workspace</span>' : ""}</div></aside><main id="main" class="workspace-main" tabindex="-1">${content}</main></div>`;
}
function heading(title, subtitle, actions = "") {
  return `<div class="page-heading"><div><h1>${e(title)}</h1><p>${e(subtitle)}</p></div>${actions}</div>`;
}
function templateStudy(template = {}, index = 0) {
  const connected =
    template.connected ||
    template.overflow ||
    template.family === "overflow" ||
    /overflow|tidal|cascade|flow|wave|diagonal/i.test(
      `${template.id} ${template.name}`,
    );
  const url = safeURL(template.previewUrl || template.thumbnailUrl);
  return url
    ? `<img class="template-preview" src="${e(url)}" alt="${e(template.name)} layout preview" loading="lazy">`
    : `<div class="template-preview ${connected ? "overflow" : ""}" aria-hidden="true" style="--rotation:${[-8, 0, 10, -16, 18][index % 5]}deg">${[0, 1, 2].map(() => '<div class="template-scene"><i class="template-phone"></i></div>').join("")}</div>`;
}
function landing() {
  return publicPage(
    `<section class="hero"><div class="hero-heading"><div><p class="eyebrow">A design studio for your App Store story</p><h1>Your app does the work.<br><em>Let its screenshots<br>do the talking.</em></h1></div><div class="hero-copy"><p>Turn your real app captures into a coordinated campaign. Choose a template, let the agent shape the story, then make every detail yours.</p><a class="button primary" href="/signup" data-link>Create your first campaign ${icon("arrow")}</a><p class="hero-note">Real screenshots. Editable layouts. Your creative direction.</p></div></div><div class="campaign-study" aria-label="Illustrative three-screen connected layout. Your screenshots replace the empty device placeholders."><div class="study-scene"><span>One clear<br>benefit.</span><i class="study-device" aria-hidden="true"></i></div><div class="study-scene"><span>A story that<br>flows.</span><i class="study-device" aria-hidden="true"></i><i class="study-device second" aria-hidden="true"></i></div><div class="study-scene"><span>Every detail.<br>Still yours.</span><i class="study-device" aria-hidden="true"></i><i class="study-device second" aria-hidden="true"></i></div></div><div class="study-caption"><span>CONNECTED LAYOUT STUDY · YOUR SCREENSHOTS GO HERE</span><span>ONE CAMPAIGN, NOT A COLLECTION OF TEMPLATES</span></div></section><section class="public-section"><div class="section-lead"><p class="eyebrow">From capture to campaign</p><h2>Creative help.<br>Without giving up control.</h2></div><div class="feature-grid"><article class="feature">${icon("upload")}<h3>Start with what’s real.</h3><p>Upload your phone captures and tell the agent what makes your app useful. Your actual product stays at the center.</p></article><article class="feature">${icon("screens")}<h3>Set the direction.</h3><p>Pick a template or let the agent choose. Keep its positions exactly, or use the layout as a starting point.</p></article><article class="feature">${icon("wand")}<h3>Refine the details.</h3><p>Review the campaign, adjust individual devices, and ask for focused changes. Export when it feels right.</p></article></div><div class="agent-connect">${icon("link")}<div><strong>Your studio, inside your agent.</strong><p>Connect external coding agents through AppScreen’s permission-scoped MCP interface.</p></div><a class="button quiet" href="/help#agents" data-link>Explore agent access ${icon("arrow")}</a></div></section>`,
  );
}
function pricingCards() {
  const plans = normalizePlans(state.config.plans);
  if (!plans.length)
    return notice(
      "Plans are not available on this installation yet. You can explore the local editor while the hosted service is being configured.",
      "warning",
    );
  return `<div class="pricing-grid">${plans.map((plan) => `<article class="price-card ${plan.id === "pro" ? "featured" : ""}"><span class="eyebrow">${e(plan.name || plan.id)}</span><h2>A home for your app’s story.</h2><p class="price">${e(planPrice(plan))}${Number.isFinite(plan.priceAmount) ? `<small> / ${e(plan.interval || "month")}</small>` : ""}</p><p class="help-text">${plan.credits !== undefined ? `${e(plan.credits)} AI credits per ${e(plan.interval || "month")}.` : "Your available allowance is shown before generation."} No automatic AI overages.</p><ul><li>Cloud campaigns and original screenshots</li><li>Template-led AI design and refinements</li><li>Individual device editing and connected layouts</li><li>PNG exports and campaign backups</li></ul>${state.session ? button(state.config.billingEnabled && plan.available !== false && Number.isFinite(plan.priceAmount) ? `Choose ${plan.name || plan.id}` : "Checkout is not configured", "checkout", { primary: true, id: plan.id, disabled: !state.config.billingEnabled || plan.available === false || !Number.isFinite(plan.priceAmount) }) : `<a class="button primary" href="/signup" data-link>Create an account ${icon("arrow")}</a>`}<p class="help-text mt20 mb0">${Number.isFinite(plan.priceAmount) ? "Renews until cancelled. Review the price, taxes, and billing terms in secure checkout before subscribing." : "No purchase is available until the operator configures published pricing."}</p></article>`).join("")}</div>`;
}
function pricing() {
  return publicPage(
    `<section class="public-section"><div class="section-lead"><p class="eyebrow">Usage that stays visible</p><h1>Pay for the creative work.<br>Keep control of the result.</h1><p>AI campaign generation and refinements use credits. Manual editing and repeat downloads do not spend AI credits.</p></div>${pricingCards()}<p class="help-text mt20">Generation can involve third-party AI processing. Plan limits and the credit quote are checked by the server before work starts.</p></section>`,
  );
}
function authPage(mode, resetAccess) {
  const returnTo = new URLSearchParams(location.search).get("returnTo");
  const authPath = (path) =>
    returnTo
      ? `${path}?returnTo=${encodeURIComponent(localReturnPath(returnTo))}`
      : path;
  const labels = {
    login: [
      "Welcome back.",
      "Your campaigns are right where you left them.",
      "Sign in",
    ],
    signup: [
      "Make room for your next campaign.",
      "Create your private AppScreen workspace.",
      "Create account",
    ],
    recover: [
      "Let’s get you back in.",
      "We’ll send a link to reset your password.",
      "Send recovery link",
    ],
    reset: [
      "Choose a new password.",
      "Use a unique password with at least 12 characters.",
      "Update password",
    ],
  };
  const [title, subtitle, action] = labels[mode];
  const development = state.config.auth?.provider === "development";
  const enabled = ["supabase", "development"].includes(
    state.config.auth?.provider,
  );
  const password = !development && !["recover"].includes(mode);
  if (mode === "reset" && !resetAccess?.allowed)
    return publicPage(
      `<section class="auth-wrap"><h1>Get a fresh password link.</h1><p class="notice warning" role="alert">${e(resetAccess?.message || "Password recovery is not configured on this installation.")}</p><p>Request a new email and open its newest link in this browser. An expired or used link cannot confirm a password change.</p><div class="actions"><a href="${e(authPath("/recover"))}" class="button primary" data-link>Request recovery link</a><a href="${e(authPath("/login"))}" class="button quiet" data-link>Back to sign in</a></div></section>`,
    );
  return publicPage(
    `<section class="auth-wrap"><h1>${title}</h1><p>${subtitle}</p>${development ? notice("Local development sign-in is enabled. This is not a production account; use an email for this local test workspace.", "warning") : ""}${!enabled ? notice("Account sign-in is not configured on this installation. The operator needs to connect an authentication provider.", "warning") : ""}<div class="panel"><form id="auth-form" data-mode="${mode}">${mode !== "reset" ? '<div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@yourstudio.com" required maxlength="254"></div>' : ""}${mode === "recover" ? '<p class="help-text">Open the newest recovery email in this same browser. We will not reveal whether an email address has an account.</p>' : ""}${mode === "reset" ? `<p class="help-text">Updating the password for ${e(resetAccess.email || "your verified account")}.</p>` : ""}${password ? `<div class="field"><label for="password">${mode === "reset" ? "New password" : "Password"}</label><input id="password" name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" ${mode === "login" ? "" : 'minlength="12"'} required maxlength="200"></div>` : ""}${mode === "reset" ? '<div class="field"><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="200"></div>' : ""}${mode === "signup" ? '<label class="check"><input name="agreement" type="checkbox" required><span>I have read the <a href="/terms" data-link>terms</a> and <a href="/privacy" data-link>privacy information</a>, including the current launch-review notice.</span></label>' : ""}<p class="inline-error" id="auth-error" role="alert"></p><button class="button primary full" type="submit" ${!enabled || (development && ["recover", "reset"].includes(mode)) ? "disabled" : ""}>${development && ["login", "signup"].includes(mode) ? "Enter local workspace" : action}</button></form></div><p class="auth-links">${mode === "login" ? `<a href="${e(authPath("/recover"))}" data-link>Forgot your password?</a><br>New here? <a href="${e(authPath("/signup"))}" data-link>Create an account</a>` : `<a href="${e(authPath("/login"))}" data-link>Back to sign in</a>`}</p></section>`,
  );
}
function projectCard(project) {
  const previews = getPreviews(project).slice(0, 3);
  const title = project.name || "Untitled campaign";
  return `<a class="project-card" href="/app/projects/${encodeURIComponent(project.id)}" data-link><div class="project-cover ${previews.length ? "" : "empty"}">${previews.length ? previews.map((preview) => `<img src="${e(safeURL(preview.url))}" alt="" loading="lazy">`).join("") : '<i class="cover-screen" aria-hidden="true"></i><i class="cover-screen" aria-hidden="true"></i><i class="cover-screen" aria-hidden="true"></i>'}</div><div class="project-meta"><h2>${e(title)}</h2><p><span>${e(project.status || "Draft")}</span><span>${formatDate(project.updatedAt || project.createdAt)}</span></p></div></a>`;
}
function dashboard(projects) {
  const actions = `<div class="actions campaign-actions">${button("Import editable backup", "import-backup", { quiet: true, icon: "upload" })}${button("Create campaign", "create-project", { primary: true, icon: "plus" })}</div>`;
  return shell(
    `${heading("Your campaigns", "A little direction. A much stronger first impression.", actions)}${!projects.length ? `<section class="onboarding"><div><p class="eyebrow">Your first campaign</p><h2>Bring the screenshots.<br>We’ll help with the story.</h2><p>Start with 3–10 clear captures of your app. Give the agent a short brief, and choose how much creative freedom it has.</p></div><ol><li>Upload your original phone screenshots</li><li>Choose a template and write a short brief</li><li>Review, refine, and export your campaign</li></ol></section><section class="empty-state">${icon("screens")}<h2>Your next launch starts here.</h2><p>Create a campaign to collect screenshots, choose a direction, and work with the design agent.</p>${button("Create campaign", "create-project", { primary: true, icon: "plus" })}</section>` : `<div class="project-grid">${projects.map(projectCard).join("")}</div>`}${!state.config.aiEnabled ? notice("AI generation is not connected yet. You can create projects and upload screenshots; generation will become available when the operator configures the provider.", "warning") : ""}`,
  );
}
function draft() {
  const id = state.project.project.id;
  if (!state.drafts.has(id)) state.drafts.set(id, defaultDraft(state.project));
  if (!state.briefSaves.has(id))
    state.briefSaves.set(id, {
      expectedUpdatedAt: state.project.project.updatedAt,
      lastSaved: JSON.stringify(briefPayload(state.drafts.get(id))),
      dirty: false,
      saving: false,
      halted: false,
      timer: null,
      error: "",
    });
  return state.drafts.get(id);
}
function updateBriefSaveStatus(id = state.project?.project.id) {
  if (state.project?.project.id !== id) return;
  const saver = state.briefSaves.get(id);
  if (!saver) return;
  const status = document.querySelector("#brief-save-status");
  if (status) {
    status.textContent = saver.halted
      ? "Sync paused · changes remain in this tab"
      : saver.saving
        ? "Syncing brief…"
        : saver.dirty
          ? "Brief changes not saved yet"
          : "Brief saved to cloud";
    status.classList.toggle("warning-text", saver.halted);
  }
  const message = document.querySelector("#brief-save-error");
  if (message) {
    message.hidden = !saver.halted;
    message.querySelector("span").textContent = saver.error || "";
  }
}
function queueBriefSave(id = state.project.project.id) {
  const values = state.drafts.get(id);
  const saver = state.briefSaves.get(id);
  if (!values || !saver) return;
  saver.dirty = JSON.stringify(briefPayload(values)) !== saver.lastSaved;
  clearTimeout(saver.timer);
  updateBriefSaveStatus(id);
  if (saver.dirty && !saver.halted)
    saver.timer = setTimeout(() => saveBrief(id), 900);
}
async function saveBrief(id) {
  const saver = state.briefSaves.get(id);
  if (!saver || saver.halted || !saver.dirty) return;
  if (saver.saving) {
    await saver.promise;
    if (saver.dirty && !saver.halted) return saveBrief(id);
    return;
  }
  clearTimeout(saver.timer);
  saver.saving = true;
  updateBriefSaveStatus(id);
  const payload = briefPayload(state.drafts.get(id));
  const serialized = JSON.stringify(payload);
  saver.promise = (async () => {
    try {
      if (payload.brief.confirmedFacts.length > 40)
        throw new Error(
          "Keep the feature list to 40 lines or fewer, then retry sync.",
        );
      if (payload.brief.confirmedFacts.some((fact) => fact.length > 500))
        throw new Error(
          "Keep each feature or fact under 500 characters, then retry sync.",
        );
      const { project } = await api(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { ...payload, expectedUpdatedAt: saver.expectedUpdatedAt },
      });
      saver.expectedUpdatedAt = project.updatedAt;
      saver.lastSaved = serialized;
      saver.dirty =
        JSON.stringify(briefPayload(state.drafts.get(id))) !== serialized;
      saver.error = "";
      if (state.project?.project.id === id)
        state.project.project = { ...state.project.project, ...project };
    } catch (error) {
      saver.halted = true;
      saver.error =
        error.status === 409
          ? "This campaign changed in another session. Your edits are still in this tab. Reload the cloud brief to compare before continuing."
          : `${error.message} Your brief changes remain in this tab.`;
      if (state.project?.project.id !== id)
        toast(
          "A campaign brief could not sync. Reopen the campaign to resolve it.",
          true,
        );
    } finally {
      saver.saving = false;
      updateBriefSaveStatus(id);
    }
  })();
  await saver.promise;
  if (saver.dirty && !saver.halted) return saveBrief(id);
}
async function flushBriefSave() {
  captureDraft();
  const id = state.project.project.id;
  await saveBrief(id);
  const saver = state.briefSaves.get(id);
  if (saver?.halted || saver?.dirty)
    throw new Error(
      "Resolve the brief sync issue before starting this campaign. Your edits have not been discarded.",
    );
}
function captureDraft() {
  const form = document.querySelector("#brief-form");
  if (!form || !state.project) return;
  const values = new FormData(form);
  const previous = draft();
  Object.assign(previous, {
    appName: values.get("appName") || "",
    promise: values.get("promise") || "",
    audience: values.get("audience") || "",
    facts: values.get("facts") || "",
    style: values.get("style") || "elegant",
    brandColor: values.get("brandColor") || "#b9b1ff",
    screenCount: Number(values.get("screenCount") || 5),
    templateMode: values.get("templateMode") || "auto",
    locks: values.getAll("locks"),
    consent: values.has("consent"),
  });
  queueBriefSave();
}
function sourceMarkup() {
  const selection = draft().sourceIds;
  const assets = state.project.assets.filter(
    (asset) =>
      asset.kind === undefined ||
      ["source", "original", "screenshot"].includes(asset.kind),
  );
  return assets.length
    ? `<div class="source-grid">${assets.map((asset) => `<div class="source-item"><div class="source-thumb">${safeURL(asset.url || asset.signedUrl || asset.previewUrl) ? `<img src="${e(safeURL(asset.previewUrl || asset.url || asset.signedUrl))}" alt="${e(asset.name || asset.filename || "Uploaded screenshot")}" loading="lazy">` : icon("screens")}</div><label class="check"><input type="checkbox" data-source="${e(asset.id)}" ${selection.includes(asset.id) ? "checked" : ""}><span title="${e(asset.name || asset.filename)}">${e(asset.name || asset.filename || "Screenshot")}</span></label></div>`).join("")}</div>`
    : '<p class="help-text">Your uploaded screenshots will appear here. Originals stay unchanged.</p>';
}
function templatesMarkup() {
  const current = draft();
  return state.templates.length
    ? `<div class="template-grid" aria-label="Choose a campaign template">${state.templates.map((template, index) => `<button type="button" class="template-card" data-action="choose-template" data-id="${e(template.id)}" aria-pressed="${current.templateId === template.id}" ${current.templateId === template.id ? 'aria-describedby="template-summary"' : ""} ${assessTemplateSelection({ templateId: template.id, templateMode: "exact" }, state.templates).allowed ? "" : "disabled"}>${templateStudy(template, index)}<span class="template-label">${e(template.name || template.id)}<small>${e(templateCompatibilityLabel(template))}</small></span></button>`).join("")}</div>`
    : '<p class="help-text">The template catalog could not be loaded. Refresh before choosing a specific template.</p>';
}
function campaignPreviews(previews) {
  if (!previews.length)
    return '<div class="preview-empty">Previews will appear after this revision has been rendered.</div>';
  return `<div class="campaign-previews">${previews.map((preview, index) => `<a class="preview-card" href="${e(safeURL(preview.url || preview.previewUrl))}" target="_blank" rel="noopener noreferrer"><figure><img src="${e(safeURL(preview.url || preview.previewUrl))}" alt="Campaign screen ${index + 1}${preview.title ? `: ${e(preview.title)}` : ""}" loading="lazy"><figcaption>Screen ${index + 1}</figcaption></figure></a>`).join("")}</div>`;
}
function currentJob() {
  return (
    state.project.jobs.find((job) => !TERMINAL_STATES.has(jobState(job))) ||
    state.project.jobs[0] ||
    null
  );
}
function jobMarkup(job) {
  if (!job) return "";
  const status = jobState(job);
  const running = !TERMINAL_STATES.has(status);
  const index = STAGES.indexOf(job.stage || status);
  const warnings = job.result?.qa?.issues || job.qa?.issues || [];
  return `<section class="panel job-panel" aria-label="Campaign job"><div class="job-title"><div><h2>${e(stageLabel(job))}</h2><p class="job-stage" role="status">${e(job.message || job.progress?.message || (running ? "You can leave this page. The job continues in your workspace." : "This result is saved to your project."))}</p></div>${running ? button(status === "cancelling" ? "Stopping…" : "Cancel", "cancel-job", { id: job.id, quiet: true, small: true, disabled: status === "cancelling" }) : ["needs-input", "needs_input"].includes(status) && jobRevisionId(job) ? `<a class="button small" href="/editor?project=${encodeURIComponent(state.project.project.id)}&revision=${encodeURIComponent(jobRevisionId(job))}">Review draft</a>` : ["failed", "cancelled", "needs-input", "needs_input"].includes(status) ? button("Retry from checkpoint", "retry-job", { id: job.id, small: true }) : '<span class="badge ready">Saved draft</span>'}</div><div class="stage-track" aria-hidden="true">${STAGES.map((_, i) => `<span class="${i < index ? "complete" : i === index ? "current" : ""}"></span>`).join("")}</div>${job.error ? notice(e(typeof job.error === "string" ? job.error : job.error.message || "The job could not finish. Retry from the last saved checkpoint."), "error") : ""}${
    warnings.length
      ? `<ul class="qa-issues">${warnings
          .slice(0, 12)
          .map(
            (issue) =>
              `<li>${e(typeof issue === "string" ? issue : issue.message || issue.description || issue.code)}</li>`,
          )
          .join("")}</ul>`
      : ""
  }${getPreviews(job).length ? campaignPreviews(getPreviews(job)) : ""}${
    Array.isArray(job.events)
      ? `<ol class="job-events">${job.events
          .slice(-8)
          .map(
            (event) =>
              `<li>${e(event.message || event.stage || event.type)}</li>`,
          )
          .join("")}</ol>`
      : ""
  }<p class="job-id">Job ${e(job.id)} · ${e(job.kind || "design")} · ${e(status)}</p></section>`;
}
function artifactMarkup(job) {
  const raw = job?.result?.artifacts || [];
  const artifacts = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([kind, value]) =>
        typeof value === "string"
          ? { kind, url: value, name: kind }
          : { kind, ...value },
      );
  const zip = job?.result?.zipUrl;
  if (zip && !artifacts.some((item) => item.url === zip))
    artifacts.push({ url: zip, name: "Download campaign ZIP", kind: "zip" });
  const valid = artifacts.filter((item) => safeURL(item.url));
  return valid.length
    ? `<div class="download-list">${valid.map((item) => `<a href="${e(safeURL(item.url))}" target="_blank" rel="noopener noreferrer" download>${e(item.name || item.kind || "Download file")}${icon("download")}</a>`).join("")}</div>`
    : "";
}
function revisionMarkup() {
  const data = state.project;
  const active = data.revision;
  const job = currentJob();
  const proposedId = data.proposedRevision?.id || jobRevisionId(job);
  const activeId = data.project.activeRevisionId || revisionId(active);
  if (!active && !proposedId) return "";
  const draftId = proposedId || activeId;
  const proposed = data.proposedRevision;
  const hasDifference = proposedId && proposedId !== activeId;
  const jobPreviews = getPreviews(job);
  const activePreviews = getPreviews(active);
  return `<section class="panel"><div class="job-title"><div><p class="eyebrow">${hasDifference ? "A new direction to review" : "Your editable campaign"}</p><h2>${hasDifference ? "Compare before applying." : "Make it unmistakably yours."}</h2></div></div>${hasDifference ? `<p class="help-text">The agent’s draft has not replaced your current revision. Review it here or open the draft in the editor.</p><div class="revision-compare"><div><h3>Current version</h3>${campaignPreviews(activePreviews)}</div><div><h3>Proposed draft</h3>${campaignPreviews(jobPreviews.length ? jobPreviews : getPreviews(proposed))}</div></div>` : campaignPreviews(activePreviews.length ? activePreviews : jobPreviews)}<div class="actions"><a class="button primary" href="/editor?project=${encodeURIComponent(data.project.id)}&revision=${encodeURIComponent(draftId)}">Open ${hasDifference ? "draft" : "editor"} ${icon("arrow")}</a>${hasDifference ? button("Apply this revision", "apply-revision", { id: proposedId }) : ""}${button("Prepare downloads", "export", { id: draftId, icon: "download" })}${button("Prepare editable backup", "export-backup", { id: draftId, icon: "download", quiet: true })}</div><p class="help-text">Downloads contain PNG screens. The editable backup contains your design and original screenshots. Neither uses AI or AI credits.</p>${artifactMarkup(job)}<hr><h3>Ask for a focused change.</h3><p class="help-text">The agent creates a new draft. Your current version and locked properties stay protected.</p><form id="revision-form"><div class="field"><label for="refinement">What should change?</label><textarea id="refinement" name="prompt" required maxlength="3000" placeholder="Make the phone on screen 3 larger. Keep the background and shorten the headline."></textarea></div><div class="fields-row"><div class="field"><label for="scope-scene">Screen</label><select id="scope-scene" name="sceneId"><option value="">Whole campaign</option>${(proposed?.document?.scenes || active?.document?.scenes || []).map((scene, index) => `<option value="${e(scene.id)}">Screen ${index + 1}</option>`).join("")}</select></div><div class="field"><label for="scope-device">Device (optional)</label><select id="scope-device" name="deviceId"><option value="">All devices in scope</option>${(
    proposed?.document?.scenes ||
    active?.document?.scenes ||
    []
  )
    .flatMap((scene, sceneIndex) =>
      scene.devices.map((device, deviceIndex) => ({
        ...device,
        name: `Screen ${sceneIndex + 1} · ${device.name || `Device ${deviceIndex + 1}`}`,
      })),
    )
    .map(
      (device, index) =>
        `<option value="${e(device.id)}">${e(device.name || `Device ${index + 1}`)}</option>`,
    )
    .join(
      "",
    )}</select></div></div><p id="revision-error" class="inline-error" role="alert"></p><button class="button" type="submit" ${!state.config.aiEnabled ? "disabled" : ""}>Create revised draft ${icon("wand")}</button><p class="help-text mt20 mb0">${creditQuote("revision")} Automatic repair is included in the quoted action.</p></form></section>`;
}
function historyMarkup(revisions) {
  if (!revisions.length) return "";
  return `<section class="panel mt20"><h2>Saved versions</h2><p class="help-text">Open an earlier version as a draft to inspect it. The current version will not change until you explicitly apply another revision.</p><div class="download-list">${revisions
    .slice(0, 20)
    .map(
      (revision) =>
        `<a href="/editor?project=${encodeURIComponent(state.project.project.id)}&revision=${encodeURIComponent(revision.id)}"><span>${e(revision.label || "Saved design")} · ${formatDate(revision.createdAt)}${revision.id === state.project.project.activeRevisionId ? " · Current" : ""}</span>${icon("arrow")}</a>`,
    )
    .join("")}</div></section>`;
}
function creditQuote(kind = "design") {
  const quote =
    state.config.costs?.[kind] ??
    state.config.creditCosts?.[kind] ??
    state.config.pricing?.[`${kind}Credits`] ??
    state.project?.pricing?.[`${kind}Credits`];
  return Number.isFinite(quote)
    ? `${quote} AI ${quote === 1 ? "credit" : "credits"} for this action.`
    : "The server checks your available credit allowance before starting.";
}
function projectPage() {
  const data = state.project;
  const values = draft();
  return shell(
    `<div class="breadcrumb"><a href="/app" data-link>Campaigns</a><span>/</span>${e(data.project.name)}</div>${heading(data.project.name, "Your screenshots. Your direction. An editable result.", '<span class="badge ready">Saved to cloud</span>')}${!state.config.aiEnabled ? notice("AI generation is not configured yet. Upload and organize your screenshots now; generation will be available once the provider is connected.", "warning") : ""}<div id="job-area">${jobMarkup(currentJob())}</div><div class="project-layout mt20"><div class="stack"><section class="panel"><p class="eyebrow">Source material</p><h2>Start with your app.</h2><p class="help-text">Choose 3–10 PNG or JPEG captures. Remove personal information before uploading; selected screenshots are shared with the AI provider during generation.</p><label class="dropzone" id="dropzone" for="screenshot-files">${icon("upload")}<strong>Drop screenshots here, or browse</strong><span>PNG or JPEG · up to ${Math.round((state.config.limits?.maxUploadBytes || 15 * 1024 * 1024) / 1024 / 1024)} MB per image</span><input id="screenshot-files" class="sr-only" type="file" accept="image/png,image/jpeg" multiple></label><ul class="upload-list" id="upload-list" aria-live="polite"></ul><div id="source-area">${sourceMarkup()}</div></section><section class="panel"><p class="eyebrow">Creative direction</p><h2>A template is a starting point.</h2><p class="help-text">Choose a layout, then tell the agent how closely to follow it. Diagram previews show composition, not generated results.</p><div id="template-area">${templatesMarkup()}</div></section></div><div class="stack"><section class="panel"><form id="brief-form"><p class="eyebrow">Campaign brief</p><h2>What makes your app useful?</h2><p id="brief-save-status" class="help-text" role="status">Brief saved to cloud</p><div id="brief-save-error" class="notice warning" hidden><span></span><div class="actions mt20">${button("Retry sync", "retry-brief-save", { small: true })}${button("Reload cloud brief", "reload-brief", { small: true })}</div></div><p class="help-text">Your brief and template choices save automatically. Starting a draft also saves them with that design revision.</p><div class="field"><label for="app-name">App name</label><input id="app-name" name="appName" required maxlength="100" value="${e(values.appName)}" placeholder="Your app’s name"></div><div class="field"><label for="promise">Main benefit</label><textarea id="promise" name="promise" required maxlength="600" placeholder="What can someone accomplish with your app?">${e(values.promise)}</textarea></div><div class="field"><label for="audience">Who is it for?</label><input id="audience" name="audience" required maxlength="300" value="${e(values.audience)}" placeholder="For example, independent creators"></div><div class="field"><label for="facts">Features and facts to include <span class="muted">(optional)</span></label><textarea id="facts" name="facts" maxlength="3000" placeholder="List only things your app really offers. Add any wording the agent should avoid.">${e(values.facts)}</textarea></div><div class="fields-row"><div class="field"><label for="style">Visual style</label><select id="style" name="style">${["elegant", "minimal", "bold", "playful"].map((style) => `<option value="${style}" ${values.style === style ? "selected" : ""}>${style[0].toUpperCase() + style.slice(1)}</option>`).join("")}</select></div><div class="field"><label for="screen-count">Output screens</label><select id="screen-count" name="screenCount">${[5, 6, 7, 8].map((number) => `<option value="${number}" ${values.screenCount === number ? "selected" : ""}>${number} screens</option>`).join("")}</select></div></div><div class="fields-row"><div class="field"><label for="brand-color">Brand color</label><input id="brand-color" name="brandColor" type="color" value="${e(values.brandColor)}"></div><div class="field"><label>Export format</label><span class="help-text">iPhone portrait<br>1320 × 2868 · English</span></div></div><fieldset><legend>How should the agent use the template?</legend><div class="template-mode">${[
      ["auto", "Choose for me"],
      ["exact", "Use exactly"],
      ["inspiration", "As inspiration"],
    ]
      .map(
        ([mode, label]) =>
          `<label class="choice-label"><input type="radio" name="templateMode" value="${mode}" aria-describedby="template-summary" ${values.templateMode === mode ? "checked" : ""}><span>${label}</span></label>`,
      )
      .join(
        "",
      )}</div><p id="template-summary" class="${assessTemplateSelection(values, state.templates).allowed ? "help-text" : "notice warning"}" role="status" aria-live="polite" aria-atomic="true">${templateSummary()}</p></fieldset><fieldset><legend>Keep these properties unchanged</legend><div class="lock-grid">${[
      ["positions", "Device positions"],
      ["colors", "Colors"],
      ["typography", "Typography"],
      ["connections", "Overflow connections"],
      ["sources", "Screenshot sources"],
      ["text", "Existing text"],
    ]
      .map(
        ([key, label]) =>
          `<label class="check"><input type="checkbox" name="locks" value="${key}" ${values.locks.includes(key) ? "checked" : ""}>${label}</label>`,
      )
      .join(
        "",
      )}</div></fieldset><hr><label class="check"><input type="checkbox" name="consent" ${values.consent ? "checked" : ""} required><span>I’m allowed to use these screenshots and agree to send the selected images and brief to the AI provider for this campaign.</span></label><p class="help-text mt20">${creditQuote()} Available: ${formatCredits(state.session.credits)} credits.</p><p id="brief-error" class="inline-error" role="alert" tabindex="-1"></p><button class="button primary full" type="submit" aria-describedby="template-summary" ${!state.config.aiEnabled ? "disabled" : ""}>Design campaign ${icon("wand")}</button><p class="help-text mt20 mb0">The agent plans, designs, checks, and saves a draft. It won’t replace your existing version automatically.</p><hr><button type="button" class="button" data-action="manual-draft" aria-describedby="template-summary">${icon("screens")}Start with a template manually</button><p class="help-text mt20 mb0">Creates an editable layout from your selected screenshots. No AI calls or AI credits.</p></form></section></div></div><div id="revision-area" class="mt20">${revisionMarkup()}</div>${historyMarkup(data.revisions || [])}`,
  );
}
function templateSummary() {
  return e(assessTemplateSelection(draft(), state.templates).message);
}
function updateTemplateFeedback() {
  const selection = assessTemplateSelection(draft(), state.templates);
  const summary = document.querySelector("#template-summary");
  if (summary) {
    summary.textContent = selection.message;
    summary.className = selection.allowed ? "help-text" : "notice warning";
  }
  const errorArea = document.querySelector("#brief-error");
  if (errorArea?.dataset.templateError) {
    errorArea.textContent = selection.allowed ? "" : selection.message;
    if (selection.allowed) delete errorArea.dataset.templateError;
  }
}
function requireTemplateSelection(values) {
  const selection = assessTemplateSelection(values, state.templates);
  if (!selection.allowed) {
    const errorArea = document.querySelector("#brief-error");
    errorArea.textContent = selection.message;
    errorArea.dataset.templateError = "true";
    errorArea.focus();
    return null;
  }
  return selection;
}
function billingPage(usage) {
  const entitlement = state.session.entitlements || {};
  const credits = usage.credits || state.session.credits;
  const events = usage.events || usage.usageEvents || usage.ledger || [];
  return shell(
    `${heading("Usage & billing", "Your allowance, activity, and subscription in one place.", button("Manage subscription", "billing-portal", { disabled: !state.config.billingEnabled }))}${new URLSearchParams(location.search).has("checkout") ? notice("Confirming payment with the billing provider. Returning from checkout does not activate a plan until the server confirms it. Refresh to check the latest state.", "", "payment-status") : ""}<div class="billing-summary"><div class="billing-stat"><span>Available AI credits</span><strong>${formatCredits(credits)}</strong><span>${formatCredits(credits?.reserved ?? 0)} reserved for running jobs</span></div><div class="billing-stat"><span>Your plan</span><strong>${e(entitlement.planId || "Trial")}</strong><span>${e(entitlement.status || "Not subscribed")}</span></div><div class="billing-stat"><span>Next renewal</span><strong>${usage.renewsAt || usage.subscription?.currentPeriodEnd ? formatDate(usage.renewsAt || usage.subscription.currentPeriodEnd) : "—"}</strong><span>Manage payment details in the billing portal</span></div></div>${!state.config.billingEnabled ? notice("Billing is not connected on this installation. No checkout or subscription changes can be made yet.", "warning") : ""}${pricingCards()}<section class="panel mt20"><h2>Credit activity</h2><p class="help-text">Credits are reserved when a job starts and settled by the server. Retries and automatic repairs do not create a second action charge.</p>${
      events.length
        ? `<div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Activity</th><th scope="col">Credits</th><th scope="col">Status</th></tr></thead><tbody>${events
            .slice(0, 100)
            .map(
              (event) =>
                `<tr><td>${formatDate(event.createdAt)}</td><td>${e(event.description || event.kind || event.type)}</td><td>${e(event.credits ?? event.amount ?? "—")}</td><td>${e(event.status || "")}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="help-text mb0">No credit activity yet. Your first generation will appear here.</p>'
    }</section>`,
    "billing",
  );
}
function settingsPage() {
  const recoveryDescription =
    state.config.auth?.provider === "supabase"
      ? "Request a password reset link for your email address."
      : state.config.auth?.provider === "development"
        ? "Recovery email isn’t available for local test accounts."
        : "Recovery email isn’t available until account sign-in is configured.";
  return shell(
    `${heading("Your account", "Access, privacy, and the work you keep here.")}<div class="settings-grid"><section class="panel"><div class="settings-row"><div><h2>${e(state.session.user?.email || "Your account")}</h2><p>${e(state.session.workspace?.name || "Personal workspace")} · Private workspace</p></div>${button("Sign out", "sign-out", { quiet: true })}</div></section><section class="panel"><div class="settings-row"><div><h2>Export workspace data</h2><p>Download a ZIP of this workspace’s projects (including archived projects), saved revisions, original screenshots, and generated image files. Account and usage metadata are included. This is not an automatic-restore package.</p></div>${button("Download workspace ZIP", "account-export", { icon: "download" })}</div></section><section class="panel"><div class="settings-row"><div><h2>Account recovery</h2><p>${recoveryDescription}</p></div>${button("Send recovery email", "account-recover", { disabled: state.config.auth?.provider !== "supabase" })}</div></section><div id="deletion-area">${deletionStatusMarkup(state.deletionLifecycle)}</div><section class="panel">${supportMarkup()}</section></div>`,
    "settings",
  );
}
function supportMarkup() {
  return `<h2>Get help with your workspace</h2><p class="help-text">Send a problem report to the service operator. Include the job ID when a campaign needs attention. Do not include passwords, access tokens, or private screenshots in this message.</p><p><a href="/app/support" data-link>View your support conversations</a></p><form id="support-form"><div class="field"><label for="support-message">What went wrong?</label><textarea id="support-message" name="message" required minlength="10" maxlength="3000" placeholder="Tell us what you expected and what happened instead."></textarea></div><div class="field"><label for="support-job">Job ID (optional)</label><input id="support-job" name="jobId" maxlength="36" placeholder="Copy the ID shown below campaign progress"></div><p id="support-error" class="inline-error" role="alert"></p><button type="submit" class="button">Send problem report</button></form>`;
}
async function submitSupport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.pending) return;
  const routeVersion = state.routeVersion;
  form.dataset.pending = "true";
  const values = new FormData(form);
  const restore = busy(form.querySelector("button"), "Sending report…");
  const errorArea = form.querySelector("#support-error");
  errorArea.textContent = "";
  try {
    const payload = { message: values.get("message").trim() };
    if (values.get("jobId").trim()) payload.jobId = values.get("jobId").trim();
    const intent = supportIntent("new");
    const body = intent.prepare(payload);
    const result = await api("/api/support", { method: "POST", body });
    if (!resourceId(result.requestId))
      throw new Error(
        "No support receipt was returned. Retry unchanged to reuse this request.",
      );
    intent.complete(body.idempotencyKey);
    if (routeVersion !== state.routeVersion) return;
    form.reset();
    toast(
      "Problem report received. Your conversation is available in Support.",
    );
    await navigate(`/app/support/${encodeURIComponent(result.requestId)}`);
  } catch (error) {
    errorArea.textContent = supportErrorMessage(error);
  } finally {
    delete form.dataset.pending;
    restore();
  }
}
function supportIntent(action) {
  const key = `${state.session?.workspace?.id}:${action}`;
  if (!state.supportIntents.has(key))
    state.supportIntents.set(key, createActionIntent());
  return state.supportIntents.get(key);
}
function supportFilter() {
  const status = new URLSearchParams(location.search).get("status") || "";
  return Object.hasOwn(SUPPORT_STATUSES, status) ? status : "";
}
function supportQuery(cursor = null) {
  const query = new URLSearchParams({ limit: "30" });
  if (supportFilter()) query.set("status", supportFilter());
  if (cursor) query.set("cursor", cursor);
  return query;
}
function inboxQuery(cursor = null) {
  const query = new URLSearchParams({ limit: "20" });
  if (new URLSearchParams(location.search).get("unreadOnly") === "true")
    query.set("unreadOnly", "true");
  if (cursor) query.set("cursor", cursor);
  return query;
}
function inboxPage() {
  return shell(
    `${heading("Your inbox", "Saved updates from your workspace.", button("Refresh inbox", "refresh"))}<div id="email-preferences-area">${emailPreferencesMarkup(state.emailPreferences.snapshot())}</div><div id="inbox-area">${inboxMarkup(state.inbox, inboxQuery().has("unreadOnly"))}</div>`,
    "inbox",
  );
}
function supportPage(staff = false) {
  return shell(
    `${staff ? '<div class="breadcrumb"><a href="/app/operator" data-link>Operations</a><span>/</span>Support queue</div>' : ""}${heading(staff ? "Support queue" : "Your support conversations", staff ? "Request metadata, triage, and explicitly opened conversations." : "Keep the context of every request in one place.", `<div class="actions">${button("Refresh requests", "refresh")}${!staff ? '<a class="button primary" href="/app/settings#support-message" data-link>New problem report</a>' : ""}</div>`)}<div id="support-list-area">${supportListMarkup(state.supportList, { staff, status: supportFilter() })}</div>`,
    staff ? "operator" : "support",
  );
}
function supportDetailPage(id, staff = false) {
  return shell(
    `<div class="breadcrumb"><a href="${staff ? "/app/operator/support" : "/app/support"}" data-link>${staff ? "Support queue" : "Support"}</a><span>/</span>Conversation</div>${heading("Support conversation", staff ? "Private content is opened only for a recorded reason." : "Replies and the current status of your request.", button(staff ? "Close private detail" : "Reload conversation", "refresh"))}<div id="support-detail-area">${staff ? supportAccessMarkup(id) : supportConversationMarkup(state.supportDetail)}</div>`,
    staff ? "operator" : "support",
  );
}
function connectionsPage(connections = []) {
  const endpoint = `${location.origin}/mcp`;
  return shell(
    `${heading("Connect your agent", "Use AppScreen tools from an MCP-compatible agent.")}<div class="settings-grid">${connectionManagerMarkup(connections)}<section class="panel"><h2>One workspace. Two ways to design.</h2><p>Your external agent can make direct, permission-scoped design edits, or start AppScreen’s complete design job. Starting our AI workflow uses your AppScreen credits.</p><div class="field"><label for="mcp-endpoint">Remote MCP endpoint</label><input id="mcp-endpoint" readonly value="${e(endpoint)}"></div>${button("Copy endpoint", "copy-mcp", { icon: "link" })}<p class="help-text mt20">Add this URL as a remote MCP server in your agent’s connection settings, then configure a scoped bearer token created above. Never paste your account password or a provider API key into an agent prompt.</p><hr><h3>You decide what it can do.</h3><p class="help-text">Read projects, edit designs, export, and paid AI generation use separate permissions. Billing and account deletion are not design tools.</p><p class="help-text">Local screenshots need an explicit upload from your agent. Connecting does not give the remote server access to your computer’s files.</p><a href="/help#agents" data-link>Read the connection guide</a></section><section class="panel"><h2>Connection example</h2><p>“Use my selected overflow template with these screenshots. Keep device positions, write concise headlines, and prepare a five-screen campaign.”</p><p class="help-text mb0">Whether a connection is available depends on this installation’s MCP and authentication configuration. The agent will report setup or permission errors rather than bypass them.</p></section></div>`,
    "connections",
  );
}
function connectionManagerMarkup(connections) {
  return `<section class="panel"><h2>Agent connections</h2><p class="help-text">${state.config.mcp?.oauthEnabled ? "This installation supports sign-in approval from compatible agents and optional scoped bearer tokens." : "This installation uses scoped bearer tokens. Automatic OAuth connection discovery is not available yet."} Create a token only for an agent you trust; keep it in that client’s secure configuration, not in a chat or project file.</p><form id="connection-form"><div class="fields-row"><div class="field"><label for="connection-name">Connection name</label><input name="name" id="connection-name" required maxlength="80" placeholder="My development agent"></div><div class="field"><label for="connection-days">Expires after</label><select name="days" id="connection-days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div></div><fieldset><legend>Allowed actions</legend><div class="lock-grid">${[
    ["projects:read", "Read projects and templates"],
    ["projects:write", "Create and edit designs"],
    ["assets:write", "Upload screenshots"],
    ["exports:write", "Render and export"],
    ["ai:run", "Start paid AI jobs"],
  ]
    .map(
      ([value, label]) =>
        `<label class="check"><input type="checkbox" name="scopes" value="${value}" ${value === "projects:read" ? "checked" : ""}>${label}</label>`,
    )
    .join(
      "",
    )}</div></fieldset><p id="connection-error" class="inline-error" role="alert"></p><button type="submit" class="button">Create scoped token</button></form><div id="new-token-area"></div><hr><h3>Existing connections</h3>${connections.length ? `<div class="download-list">${connections.map((connection) => `<div class="settings-row"><div><strong>${e(connection.name)}</strong><p class="help-text">${connection.type === "oauth" ? "Sign-in approval" : "Scoped token"}<br>${e((connection.scopes || []).join(" · "))}<br>${connection.revokedAt ? "Revoked" : `Expires ${formatDate(connection.expiresAt)}`}</p></div>${connection.upstreamRevocationPending ? button("Retry revocation", "revoke-connection", { id: connection.id, small: true }) : connection.revokedAt ? '<span class="badge">Revoked</span>' : button("Revoke", "revoke-connection", { id: connection.id, danger: true, small: true })}</div>`).join("")}</div>` : '<p class="help-text mb0">No agent connections yet. You can start with read-only access.</p>'}</section>`;
}
async function submitConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const restore = busy(
    form.querySelector("button[type=submit]"),
    "Creating token…",
  );
  try {
    const scopes = values.getAll("scopes");
    if (!scopes.length) throw new Error("Choose at least one allowed action.");
    const result = await api("/api/connections", {
      method: "POST",
      body: {
        name: values.get("name"),
        scopes,
        days: Number(values.get("days")),
      },
    });
    const token = result.token || result.accessToken;
    if (!token)
      throw new Error(
        "The token was not returned. Refresh the list before creating another.",
      );
    const area = document.querySelector("#new-token-area");
    area.innerHTML = `<div class="notice warning mt20"><strong>Copy this token now.</strong> It is only shown once. Anyone holding it can use the approved actions until it expires or is revoked.</div><div class="field"><label for="new-connection-token">New access token</label><input id="new-connection-token" type="password" readonly autocomplete="off"><small>Use as the Authorization bearer token in your MCP client configuration.</small></div><div class="actions"><button type="button" class="button" id="copy-new-token">Copy token</button><button type="button" class="button quiet" id="dismiss-new-token">I saved it securely</button></div>`;
    area.querySelector("input").value = token;
    area.querySelector("#copy-new-token").onclick = async () => {
      try {
        await navigator.clipboard.writeText(token);
        toast("Token copied. Keep it private.");
      } catch {
        toast(
          "Copy is unavailable in this browser. Select the token field and copy it manually.",
          true,
        );
      }
    };
    area.querySelector("#dismiss-new-token").onclick = () => {
      area.replaceChildren();
      renderRoute();
    };
    announce("Token created. Copy it now; it is only shown once.");
  } catch (error) {
    document.querySelector("#connection-error").textContent = error.message;
  } finally {
    restore();
  }
}
function helpPage() {
  return publicPage(
    `<article class="prose"><p class="eyebrow">A little guidance</p><h1>From screenshots to a story.</h1><details open><summary>What should I upload?</summary><p>Use 3–10 PNG or JPEG captures of the real app. Show useful, distinct features. Remove personal information, debug screens, loading indicators, and anything you don’t have permission to share.</p></details><details><summary>Can I choose the template?</summary><p>Yes. Pick a template and choose “Use exactly” to preserve its layout, or “As inspiration” to allow composition changes. “Choose for me” gives the agent template selection. Locks protect positions, colors, typography, sources, copy, or connected overflow.</p></details><details><summary>Will my original screenshots change?</summary><p>The campaign uses your source screenshots inside editable devices. Your uploaded originals remain separate from the marketing design. AI-generated replacement app interfaces are not the default workflow.</p></details><details><summary>What happens if I close the browser?</summary><p>The server continues an accepted job. Return to the campaign to see its saved stage, result, or recovery action. A connection error does not necessarily mean the job stopped.</p></details><details><summary>How do credits work?</summary><p>The server checks your allowance before accepting generation. Credits are reserved for the action, and retrying its internal steps does not create a new action charge. Manual editing and repeat downloads do not spend AI credits. See your workspace’s current plan and usage for available allowances.</p></details><details><summary>Can I change just one device?</summary><p>Open the editor for direct control, or ask for a scoped revision. Connected devices preserve their shared seam geometry. Proposed revisions do not silently replace the current version.</p></details><details><summary>Are the exports guaranteed to pass store review?</summary><p>No. Export checks cover supported dimensions and image properties. You remain responsible for truthful product claims, rights, and the store’s current submission rules.</p></details><h2 id="agents">Connect Codex or Claude Code</h2><p>In your agent’s MCP settings, add this AppScreen installation’s remote endpoint:</p><code class="code-block">${e(location.origin)}/mcp</code><p>Create a scoped access token under Agent connections and configure it as a bearer token in your client. ${state.config.mcp?.oauthEnabled ? "Compatible clients can also open AppScreen’s sign-in approval screen, where you choose permissions before connecting." : "Automatic OAuth setup is not available on this installation yet."} Your external agent can list templates, upload authorized screenshots, create drafts, inspect previews, refine layouts, and prepare exports. Paid generation needs a separate permission.</p><p><a href="/app/connections" data-link>Open agent connections</a></p><h2>A job needs attention?</h2><p>Open the campaign and copy the job ID shown below its progress. Retry uses the server’s saved checkpoint. If the issue persists, share that ID with the service operator; do not send passwords or provider keys.</p>${state.config.supportEmail ? `<p><a href="mailto:${e(state.config.supportEmail)}">Contact ${e(state.config.supportEmail)}</a></p>` : notice("A support contact has not been configured yet. This must be completed before public launch.", "warning")}</article>`,
  );
}
function policyPage(kind) {
  const privacy = kind === "privacy";
  return publicPage(
    `<article class="prose"><p class="eyebrow">Pre-launch policy draft</p><h1>${privacy ? "Privacy information" : "Terms of use"}</h1>${notice("<strong>Not a finalized legal policy.</strong> The service operator must add its legal identity, contact details, retention schedule, market-specific terms, and complete legal review before accepting production customers.", "warning")}${privacy ? "<h2>Data used to provide AppScreen</h2><p>The hosted service processes account details, workspace and project records, uploaded screenshots, briefs, design revisions, generated previews, exports, and usage records. Payment details are managed through the configured payment provider.</p><h2>AI processing</h2><p>Starting an AI job sends the selected screenshots, brief, and relevant campaign content to the configured AI provider. Do not upload sensitive information or material you are not authorized to share. Source screenshots and model text are not instructions that grant access to other projects.</p><h2>Access and storage</h2><p>Hosted projects are scoped to the customer workspace. Authorized downloads may use expiring links. Infrastructure and AI vendors process data needed to perform their services; the operator must publish the actual vendor list and processing terms before launch.</p><h2>Your choices</h2><p>Account settings provide an account-data export and deletion-request flow. A deletion request is not a promise of immediate erasure; the operator must publish verified retention, backup, legal-record, and payment-record handling. Do not claim a fixed retention period until those settings and procedures are established.</p><h2>Contact and rights</h2><p>The operator’s legal contact and jurisdiction-specific rights process require review and publication before launch. This draft does not establish that all relevant privacy obligations have been met.</p>" : "<h2>Your content and account</h2><p>Use AppScreen only with screenshots and other content you have the right to process and publish. Keep account access secure. Do not use the service to gain unauthorized access, upload malicious files, or interfere with other customers.</p><h2>AI drafts need your review</h2><p>AI can make factual and visual mistakes. Review wording, screenshots, composition, and store requirements before publishing. Export validation is not a guarantee of App Store approval or commercial performance.</p><h2>Subscriptions and credits</h2><p>Available plans, prices, taxes, renewal periods, and action credit costs must be shown before purchase or generation. A checkout redirect alone does not establish entitlement. The operator must finalize refund, cancellation, expiry, failure, and retention policies before production sales.</p><h2>External agents</h2><p>Connecting an MCP client authorizes only the permissions you approve. You remain responsible for the instructions you give the client. Paid generation requires the appropriate scope and sufficient server-verified allowance.</p><h2>Service operation</h2><p>Provider interruptions, processing limits, or input problems can prevent a job from finishing. AppScreen provides saved job states and recovery paths where available. Warranty, liability, dispute, governing-law, and business-identity provisions remain for legal review.</p>"}<p class="help-text">Draft prepared September 2026. Not approved for public commercial launch.</p></article>`,
  );
}

async function navigate(path, replace = false) {
  if (state.backupImport?.snapshot().pending) {
    announce("Wait for the backup import to finish before leaving this view.");
    return;
  }
  captureDraft();
  clearTimeout(state.poll);
  state.poll = null;
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  await renderRoute();
  window.scrollTo(0, 0);
  document.querySelector("#main")?.focus({ preventScroll: true });
}
async function refreshSession() {
  const previousScope = `${state.session?.user?.id}:${state.session?.workspace?.id}`;
  if (await getAccessToken()) state.session = await api("/api/session");
  else state.session = null;
  if (
    previousScope !==
    `${state.session?.user?.id}:${state.session?.workspace?.id}`
  ) {
    state.backupImport = null;
    state.supportIntents.clear();
    state.supportDetail = null;
    state.supportList = null;
    state.inbox = null;
    state.emailPreferences = null;
    state.emailOperations = null;
    state.unreadCount = null;
  }
}
async function loadProject(id) {
  const data = await api(`/api/projects/${encodeURIComponent(id)}`);
  data.assets ||= [];
  data.jobs ||= [];
  data.jobs.sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
  );
  const proposedId = data.revisions?.[0]?.id || jobRevisionId(data.jobs[0]);
  if (proposedId && proposedId !== revisionId(data.revision)) {
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(proposedId)}`,
      );
      data.proposedRevision = result.revision;
    } catch {}
  }
  const saver = state.briefSaves.get(id);
  if (saver && !saver.dirty && !saver.saving) {
    saver.expectedUpdatedAt = data.project.updatedAt;
    const next = defaultDraft(data);
    state.drafts.set(id, next);
    saver.lastSaved = JSON.stringify(briefPayload(next));
  }
  return data;
}
async function renderRoute() {
  const version = ++state.routeVersion;
  const path = location.pathname.replace(/\/$/, "") || "/";
  state.route = path;
  state.supportDetail = null;
  if (modal.querySelector("#support-confirm-form, #email-review-form, #backup-import-form")) {
    modal.close();
    modal.innerHTML = "";
  }
  if (
    /^\/app\/(inbox|support|operator\/(support|report|email))(\/|$)/.test(path) ||
    root.querySelector("#support-detail-area")
  ) {
    const selected = path.startsWith("/app/operator")
      ? "operator"
      : path.startsWith("/app/inbox")
        ? "inbox"
        : "support";
    root.innerHTML = shell(
      '<section class="panel" aria-busy="true"><p role="status" class="mb0">Loading this view and checking access…</p></section>',
      selected,
    );
  }
  if (!path.startsWith("/app/operator")) state.staffMfa.enrollment = null;
  state.oauthConsent = null;
  state.oauthReconnect = null;
  clearTimeout(state.poll);
  try {
    const oauthAvailable =
      state.config.auth?.provider === "supabase" &&
      state.config.mcp?.oauthEnabled === true;
    const protectedPage =
      path.startsWith("/app") || (path === "/oauth/consent" && oauthAvailable);
    if (protectedPage) {
      await refreshSession();
      if (version !== state.routeVersion) return;
      if (!state.session) {
        await navigate(
          `/login?returnTo=${encodeURIComponent(path + location.search + location.hash)}`,
          true,
        );
        return;
      }
      if (path !== "/app/inbox") refreshInboxBadge(version);
    }
    let html;
    if (path === "/app") {
      const data = await api("/api/projects");
      html = dashboard(data.projects || []);
    } else if (path === "/app/inbox") {
      const inbox = normalizeNotifications(
        await api(`/api/notifications?${inboxQuery()}`),
      );
      if (version !== state.routeVersion) return;
      state.inbox = inbox;
      state.unreadCount = state.inbox.unreadCount;
      const preferences = createEmailPreferences(api, () => {
        if (
          version === state.routeVersion &&
          state.emailPreferences === preferences
        )
          renderEmailPreferences();
      });
      state.emailPreferences = preferences;
      html = inboxPage();
    } else if (path === "/app/support") {
      const list = await api(`/api/support?${supportQuery()}`);
      if (version !== state.routeVersion) return;
      state.supportList = list;
      html = supportPage();
    } else if (/^\/app\/support\/[^/]+$/.test(path)) {
      const id = resourceId(decodeURIComponent(path.split("/")[3]));
      if (!id) throw new Error("This support link is incomplete.");
      const detail = await api(`/api/support/${encodeURIComponent(id)}`);
      if (version !== state.routeVersion) return;
      state.supportDetail = detail;
      html = supportDetailPage(id);
    } else if (/^\/app\/projects\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      const [data, templates] = await Promise.all([
        loadProject(id),
        api("/api/templates").catch(() => ({ templates: [] })),
      ]);
      state.project = data;
      state.templates = templates.templates || [];
      html = projectPage();
    } else if (path === "/oauth/consent") {
      if (!oauthAvailable)
        html = publicPage(
          '<section class="auth-wrap"><h1>Agent sign-in is not connected.</h1><p class="notice warning">Automatic agent authorization requires a configured Supabase account provider and OAuth setup. No connection has been approved.</p><a class="button" href="/app/connections" data-link>Open agent connections</a></section>',
        );
      else {
        const authorizationId = new URLSearchParams(location.search).get(
          "authorization_id",
        );
        if (!authorizationId || authorizationId.length > 200)
          throw new Error(
            "This approval link is incomplete. Return to your agent and start the connection again.",
          );
        const data = await api(
          `/api/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
        );
        if (version !== state.routeVersion) return;
        if (data.alreadyApproved && data.redirectUrl) {
          const redirect = safeOAuthRedirect(data.redirectUrl);
          if (!redirect)
            throw new Error(
              "The agent returned an unsupported callback address. No new approval was sent.",
            );
          location.assign(redirect);
          return;
        }
        if (data.reconnectRequired) {
          state.oauthReconnect = data;
          html = publicPage(oauthReconnectMarkup(data));
        } else {
          state.oauthConsent = { ...data, authorizationId };
          html = publicPage(oauthConsentMarkup(data));
        }
      }
    } else if (
      path === "/app/operator" ||
      path === "/app/operator/report" ||
      path === "/app/operator/email" ||
      path === "/app/operator/support" ||
      /^\/app\/operator\/(jobs|support)\/[^/]+$/.test(path)
    ) {
      if (staffMfaAllowed(state.session, state.config)) {
        state.staffMfa.factors = await listStaffFactors(authClient().auth.mfa);
        html = shell(
          `${heading("Staff verification", "Confirm your second factor to enter restricted operations.", button("Refresh access", "refresh"))}<div id="staff-mfa-area">${staffMfaMarkup(state.staffMfa.factors, state.staffMfa.enrollment)}</div>`,
          "operator",
        );
      } else if (state.session.operator !== true)
        html = shell(
          `${heading("Operator access required", "This account is not authorized to view service operations.")}<p class="notice error" role="alert">403 · Access denied. Customer accounts cannot grant themselves operator access.</p><a href="/app" class="button" data-link>Back to campaigns</a>`,
        );
      else if (path === "/app/operator")
        html = shell(
          `${heading("Service operations", "Saved health signals and documented account corrections.", button("Refresh status", "refresh"))}<nav class="actions operator-page-links" aria-label="Operations tools"><a class="button" href="/app/operator/support" data-link>Support queue</a><a class="button" href="/app/operator/report" data-link>Activity report</a><a class="button" href="/app/operator/email" data-link>Email incident reviews</a></nav>${operatorOverviewMarkup(await api("/api/operator/overview"))}`,
          "operator",
        );
      else if (path === "/app/operator/report") {
        const days = reportDays(
          new URLSearchParams(location.search).get("days"),
        );
        html = shell(
          `<div class="breadcrumb"><a href="/app/operator" data-link>Operations</a><span>/</span>Activity report</div>${heading("Activity report", "Content-free service milestones and current operational conditions.", button("Refresh report", "refresh"))}${operationsReportMarkup(await api(`/api/operator/report?days=${days}`))}`,
          "operator",
        );
      } else if (path === "/app/operator/email") {
        state.emailOperations = {
          filter: emailIncidentFilter(new URLSearchParams(location.search).get("state")),
          incidents: [], nextCursor: null, report: null, pending: [],
          loading: false, loadingMore: false, error: "", feedback: "", pendingError: "",
          routeVersion: version,
        };
        html = shell(
          `<div class="breadcrumb"><a href="/app/operator" data-link>Operations</a><span>/</span>Email incident reviews</div>${heading("Email incident reviews", "Delivery evidence and staff decisions, kept separate.")}<div id="email-operations-area">${emailOperationsMarkup({ ...state.emailOperations, loading: true })}</div>`,
          "operator",
        );
      } else if (path === "/app/operator/support") {
        const list = await api(`/api/operator/support?${supportQuery()}`);
        if (version !== state.routeVersion) return;
        state.supportList = list;
        html = supportPage(true);
      } else if (/^\/app\/operator\/support\/[^/]+$/.test(path)) {
        const id = resourceId(decodeURIComponent(path.split("/")[4]));
        if (!id) throw new Error("This support link is incomplete.");
        html = supportDetailPage(id, true);
      } else {
        const jobId = decodeURIComponent(path.split("/")[4]);
        html = shell(
          `<div class="breadcrumb"><a href="/app/operator" data-link>Operations</a><span>/</span>Job detail</div>${heading("Job detail", "Stages, usage, and the credit reservation.", button("Refresh status", "refresh"))}${operatorJobMarkup(await api(`/api/operator/jobs/${encodeURIComponent(jobId)}`))}`,
          "operator",
        );
      }
    } else if (path === "/app/billing") {
      html = billingPage(await api("/api/usage"));
    } else if (path === "/app/settings") {
      state.deletionLifecycle = await api(
        "/api/account/deletion-request",
      ).catch((error) => ({ unavailable: error.message }));
      html = settingsPage();
    } else if (path === "/app/connections")
      html = connectionsPage((await api("/api/connections")).connections || []);
    else if (path === "/pricing") html = pricing();
    else if (path === "/help") html = helpPage();
    else if (path === NOTICES_PATH) {
      root.innerHTML = publicPage(
        thirdPartyNoticesMarkup([], { loading: true }),
      );
      const notices = await loadLicenseNotices();
      if (version !== state.routeVersion) return;
      html = publicPage(thirdPartyNoticesMarkup(notices));
    } else if (path === "/privacy" || path === "/terms")
      html = policyPage(path.slice(1));
    else if (path === "/reset-password")
      html = authPage(
        "reset",
        await verifyPasswordAccess(
          state.config.auth?.provider === "supabase"
            ? authClient()?.auth
            : null,
          authCallbackState(),
        ),
      );
    else if (["/login", "/signup", "/recover"].includes(path))
      html = authPage(path.slice(1));
    else if (path === "/auth/callback") {
      const callback = authCallbackState();
      if (callback.error || state.config.auth?.provider !== "supabase") {
        html = publicPage(
          `<section class="auth-wrap"><h1>This sign-in link needs attention.</h1><p class="notice warning" role="alert">${e(authErrorMessage(callback.error, "callback"))}</p><div class="actions"><a class="button primary" href="/recover" data-link>Request recovery link</a><a class="button quiet" href="/login" data-link>Back to sign in</a></div></section>`,
        );
      } else if (callback.recoveryEvent) {
        await navigate(
          recoveryRedirect(
            location.origin,
            new URLSearchParams(location.search).get("returnTo"),
          ).replace(location.origin, ""),
          true,
        );
        return;
      } else {
        await refreshSession();
        const returnTo = localReturnPath(
          new URLSearchParams(location.search).get("returnTo"),
        );
        await navigate(
          state.session
            ? returnTo
            : `/login?returnTo=${encodeURIComponent(returnTo)}`,
          true,
        );
        return;
      }
    } else if (["/", "/saas", "/saas/index.html"].includes(path))
      html = landing();
    else
      html = publicPage(
        '<section class="prose"><h1>This page isn’t here.</h1><p>Head back to your campaigns or start from the homepage.</p><a href="/app" data-link class="button primary">Open campaigns</a></section>',
      );
    if (version !== state.routeVersion) return;
    root.innerHTML = html;
    document.title = path.startsWith("/app")
      ? "Your studio — AppScreen"
      : "AppScreen — Your app, beautifully presented";
    bindPage();
    if (path === "/app/inbox") void state.emailPreferences.load();
    if (path === "/app/operator/email" && state.session?.operator === true)
      void loadEmailOperations();
    if (path.startsWith("/app/projects/")) startPolling();
    if (location.hash)
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
    if (path === "/app" && location.hash === "#import-backup") openImportBackup();
  } catch (error) {
    if (version !== state.routeVersion) return;
    if (path.startsWith("/app/operator") && error.status === 403) {
      root.innerHTML = shell(
        `${heading("Operator access denied", "Your account does not have access to these operations.")}<p class="notice error" role="alert">${e(error.message)}</p><a href="/app" class="button" data-link>Back to campaigns</a>`,
      );
      return;
    }
    root.innerHTML = publicPage(
      `<section class="error-boundary panel"><h1>We couldn’t open this page.</h1><p class="inline-error" role="alert">${e(error.message)}</p><div class="actions">${button("Try again", "refresh", { primary: true })}<a href="/login" data-link class="button quiet">Sign in</a></div></section>`,
    );
  }
}
function bindPage() {
  updateBriefSaveStatus();
  bindEmailPreferences();
  bindEmailOperations();
  bindEngagement();
  document
    .querySelector("#operator-credit-form")
    ?.addEventListener("submit", reviewCreditAdjustment);
  document
    .querySelector("#support-form")
    ?.addEventListener("submit", submitSupport);
  document
    .querySelector("#connection-form")
    ?.addEventListener("submit", submitConnection);
  document.querySelector("#auth-form")?.addEventListener("submit", submitAuth);
  document
    .querySelector("#oauth-consent-form")
    ?.addEventListener("submit", submitOAuthConsent);
  document
    .querySelector("#oauth-reconnect-form")
    ?.addEventListener("submit", submitOAuthReconnect);
  document
    .querySelector("#staff-mfa-form")
    ?.addEventListener("submit", submitStaffMfa);
  document
    .querySelector("#brief-form")
    ?.addEventListener("submit", submitDesign);
  document.querySelector("#brief-form")?.addEventListener("input", () => {
    captureDraft();
    updateTemplateFeedback();
  });
  document
    .querySelector("#revision-form")
    ?.addEventListener("submit", submitRevision);
  document
    .querySelector("#screenshot-files")
    ?.addEventListener("change", (event) =>
      uploadFiles([...event.target.files]),
    );
  const zone = document.querySelector("#dropzone");
  for (const event of ["dragenter", "dragover"])
    zone?.addEventListener(event, (entry) => {
      entry.preventDefault();
      zone.classList.add("dragging");
    });
  for (const event of ["dragleave", "drop"])
    zone?.addEventListener(event, (entry) => {
      entry.preventDefault();
      zone.classList.remove("dragging");
    });
  zone?.addEventListener("drop", (event) =>
    uploadFiles([...event.dataTransfer.files]),
  );
}
function renderEmailPreferences() {
  const area = document.querySelector("#email-preferences-area");
  if (!area || !state.emailPreferences) return;
  const focused = area.contains(document.activeElement)
    ? document.activeElement.id
    : null;
  area.innerHTML = emailPreferencesMarkup(state.emailPreferences.snapshot());
  bindEmailPreferences();
  if (focused) {
    const target = document.getElementById(focused);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
}
function bindEmailPreferences() {
  const preferences = state.emailPreferences;
  const form = document.querySelector("#email-preferences-form");
  if (!preferences || !form || form.dataset.bound) return;
  form.dataset.bound = "true";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await preferences.save();
    if (state.emailPreferences !== preferences || state.route !== "/app/inbox")
      return;
    const target = document.querySelector(
      preferences.snapshot().reloadRequired
        ? "#email-preferences-reload"
        : "#email-preferences-enabled",
    );
    if (target && !target.disabled) target.focus({ preventScroll: true });
  });
  form.querySelector("#email-preferences-enabled").addEventListener("change", (event) => {
    preferences.change(event.currentTarget.checked);
  });
  form.querySelector("#email-preferences-reload")?.addEventListener("click", async () => {
    await preferences.load();
    if (state.emailPreferences !== preferences || state.route !== "/app/inbox")
      return;
    const target = document.querySelector("#email-preferences-enabled");
    if (target && !target.disabled) target.focus({ preventScroll: true });
  });
}
function emailReviewStore() {
  return createEmailReviewStore(
    window.sessionStorage, state.session?.user?.id, state.session?.workspace?.id,
  );
}
function currentEmailOperations(view) {
  return state.emailOperations === view &&
    view.routeVersion === state.routeVersion &&
    state.route === "/app/operator/email" && state.session?.operator === true;
}
function refreshPendingEmailReviews(view) {
  try {
    view.pending = emailReviewStore().list();
    view.pendingError = "";
  } catch {
    view.pending = [];
    view.pendingError = "Saved review storage is unavailable or incomplete.";
  }
}
function paintEmailOperations(view, focus = "") {
  if (!currentEmailOperations(view)) return;
  const area = document.querySelector("#email-operations-area");
  if (!area) return;
  area.innerHTML = emailOperationsMarkup(view);
  bindEmailOperations();
  if (focus) area.querySelector(focus)?.focus({ preventScroll: true });
}
function stopEmailOperations() {
  state.emailOperations = null;
  state.session.operator = false;
  if (modal.querySelector("#email-review-form")) modal.close();
  root.innerHTML = shell(
    `${heading("Operator access denied", "Staff access is required to review email incidents.")}<p class="notice error" role="alert">Access is no longer available. No further reviews can be submitted. Any unconfirmed request remains scoped to the original staff session in this tab.</p><a href="/app" class="button" data-link>Back to campaigns</a>`,
  );
  root.querySelector("#main")?.focus({ preventScroll: true });
}
async function loadEmailOperations(more = false, focus = "") {
  const view = state.emailOperations;
  if (!view || !currentEmailOperations(view) || view.loading || view.loadingMore) return;
  view.loading = !more;
  view.loadingMore = more;
  view.error = "";
  view.feedback = "";
  refreshPendingEmailReviews(view);
  const query = new URLSearchParams({ state: view.filter, limit: "30" });
  if (more && view.nextCursor) query.set("cursor", view.nextCursor);
  if (!more) {
    view.incidents = [];
    view.nextCursor = null;
    view.report = null;
  }
  paintEmailOperations(view);
  const [list, report] = await Promise.allSettled([
    api(`/api/operator/email/incidents?${query}`).then(normalizeEmailIncidents),
    more ? Promise.resolve(view.report) : api("/api/operator/email").then(normalizeEmailReport),
  ]);
  if (!currentEmailOperations(view)) return;
  if ([list, report].some((result) => result.status === "rejected" &&
      (result.reason.status === 403 || result.reason.status === 401 || result.reason.code === "OPERATOR_REQUIRED"))) {
    stopEmailOperations();
    return;
  }
  view.loading = false;
  view.loadingMore = false;
  if (list.status === "fulfilled") {
    view.reloadRequired = false;
    view.incidents = more
      ? [...new Map([...view.incidents, ...list.value.incidents].map((item) => [item.id, item])).values()]
      : list.value.incidents;
    view.nextCursor = list.value.nextCursor;
    view.feedback = `${view.incidents.length} incident${view.incidents.length === 1 ? "" : "s"} shown. Current evidence loaded.`;
  } else {
    view.error = "The current incident queue could not be loaded. Reload the queue before recording a review.";
  }
  view.report = report.status === "fulfilled" ? report.value : null;
  refreshPendingEmailReviews(view);
  paintEmailOperations(view, view.error ? "#email-queue-feedback" : focus);
  announce(view.error || view.feedback);
}
function bindEmailOperations() {
  const area = document.querySelector("#email-operations-area");
  if (!area || area.dataset.bound) return;
  // The area is stable while its contents are replaced; delegate controls once.
  area.dataset.bound = "true";
  area.addEventListener("change", (event) => {
    if (event.target.id !== "email-incident-filter") return;
    navigate(`/app/operator/email?state=${emailIncidentFilter(event.target.value)}`);
  });
  area.addEventListener("click", (event) => {
    const control = event.target.closest("[data-email-action]");
    if (!control || control.disabled) return;
    const action = control.dataset.emailAction;
    if (action === "reload") void loadEmailOperations(false, "#email-incident-filter");
    else if (action === "more") void loadEmailOperations(true, "#email-queue-feedback");
    else if (["review", "resume"].includes(action)) openEmailReview(control.dataset.id, control);
  });
}
function openEmailReview(id, opener) {
  const view = state.emailOperations;
  if (!view || !currentEmailOperations(view) || view.loading || view.pendingError) return;
  refreshPendingEmailReviews(view);
  const incident = view.pending.find((item) => item.incident.id === id)?.incident ||
    view.incidents.find((item) => item.id === id);
  if (!incident || view.pendingError) return;
  if ((view.error || view.reloadRequired) && !view.pending.some((item) => item.incident.id === id)) return;
  let review;
  try { review = createEmailReview(api, emailReviewStore(), incident); }
  catch {
    view.pendingError = "Saved review storage is unavailable or incomplete.";
    paintEmailOperations(view, "#email-queue-feedback");
    return;
  }
  let active = true;
  const paint = (focus = "") => {
    if (!active || !currentEmailOperations(view)) return;
    modal.innerHTML = emailReviewMarkup(review.snapshot());
    modal.querySelector(focus || "#email-review-feedback")?.focus({ preventScroll: true });
  };
  const cancel = (event) => {
    if (review.snapshot().phase === "saving") event.preventDefault();
  };
  const close = () => {
    active = false;
    modal.removeEventListener("cancel", cancel);
    modal.removeEventListener("click", click);
    modal.removeEventListener("submit", submit);
    if (currentEmailOperations(view)) {
      refreshPendingEmailReviews(view);
      paintEmailOperations(view);
      (document.querySelector(`[data-email-action][data-id="${id}"]:not(:disabled)`) ||
        document.querySelector('#email-operations-area [data-email-action="reload"]'))?.focus({ preventScroll: true });
    } else if (opener?.isConnected) opener.focus({ preventScroll: true });
    modal.innerHTML = "";
  };
  const click = (event) => {
    const control = event.target.closest("[data-email-action]");
    if (!control || control.disabled || review.snapshot().phase === "saving") return;
    if (control.dataset.emailAction === "edit") {
      review.edit();
      paint("#email-review-disposition");
    } else if (control.dataset.emailAction === "close") modal.close();
    else if (control.dataset.emailAction === "reload-close") {
      modal.close();
      void loadEmailOperations(false, "#email-queue-feedback");
    }
  };
  const submit = async (event) => {
    if (event.target.id !== "email-review-form") return;
    event.preventDefault();
    if (!active || !currentEmailOperations(view)) return;
    const before = review.snapshot();
    if (before.phase === "draft") {
      try {
        review.prepare(Object.fromEntries(new FormData(event.target)));
        paint("#email-review-confirmed");
      } catch (error) {
        const feedback = modal.querySelector("#email-review-feedback");
        feedback.textContent = error.message;
        feedback.setAttribute("role", "alert");
        feedback.focus();
      }
      return;
    }
    const confirmed = event.target.querySelector("#email-review-confirmed")?.checked === true;
    const recording = review.record(confirmed);
    paint();
    const result = await recording;
    // The controller retains/clears its scoped retry even if this route is gone.
    if (!active || !currentEmailOperations(view)) return;
    if (result.phase === "forbidden") {
      stopEmailOperations();
      return;
    }
    if (["saved", "stale"].includes(result.phase)) {
      view.reloadRequired = true;
      view.feedback = result.phase === "saved"
        ? "Staff review recorded. Reload the queue for current evidence and decisions."
        : "Evidence changed. Reload the queue before recording another review.";
    }
    paint();
    refreshPendingEmailReviews(view);
    paintEmailOperations(view);
    announce(result.message);
  };
  modal.addEventListener("cancel", cancel);
  modal.addEventListener("close", close, { once: true });
  modal.addEventListener("click", click);
  modal.addEventListener("submit", submit);
  modal.innerHTML = emailReviewMarkup(review.snapshot());
  modal.showModal();
  modal.querySelector(review.snapshot().phase === "draft" ? "#email-review-disposition" : "#email-review-confirmed")?.focus();
}
function bindEngagement() {
  document
    .querySelector("#support-access-form")
    ?.addEventListener("submit", openSupportConversation);
  document
    .querySelector("#support-reply-form")
    ?.addEventListener("submit", sendSupportReply);
  document
    .querySelector("#support-status-form")
    ?.addEventListener("submit", reviewSupportStatus);
  document
    .querySelector("#inbox-unread-only")
    ?.addEventListener("change", (event) =>
      navigate(
        `/app/inbox${event.currentTarget.checked ? "?unreadOnly=true" : ""}`,
      ),
    );
  document
    .querySelector("#support-status-filter")
    ?.addEventListener("change", (event) =>
      navigate(
        `${state.route}${event.currentTarget.value ? `?status=${encodeURIComponent(event.currentTarget.value)}` : ""}`,
      ),
    );
  document
    .querySelector("#report-days")
    ?.addEventListener("change", (event) =>
      navigate(
        `/app/operator/report?days=${reportDays(event.currentTarget.value)}`,
      ),
    );
}
async function refreshInboxBadge(version) {
  const unread = await api("/api/notifications/unread-count", {
    timeout: 5000,
  }).catch(() => null);
  if (version !== state.routeVersion) return;
  state.unreadCount =
    Number.isInteger(unread?.unreadCount) && unread.unreadCount >= 0
      ? unread.unreadCount
      : null;
  const link = document.querySelector('.side-link[href="/app/inbox"]');
  if (link)
    link.innerHTML = `${icon("inbox")}Inbox${state.unreadCount > 0 ? ` · ${state.unreadCount}` : ""}`;
}
async function openSupportConversation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.pending) return;
  const area = form.querySelector("#support-access-error");
  area.textContent = "";
  const reason = String(new FormData(form).get("reason") || "").trim();
  const id = resourceId(state.route.split("/")[4]);
  if (
    state.session?.operator !== true ||
    !id ||
    reason.length < 10 ||
    reason.length > 500
  ) {
    area.textContent =
      "An authorized staff account and a reason between 10 and 500 characters are required.";
    return;
  }
  const version = state.routeVersion;
  form.dataset.pending = "true";
  const restore = busy(
    form.querySelector("button[type=submit]"),
    "Opening audited conversation…",
  );
  try {
    const data = await api(
      `/api/operator/support/${encodeURIComponent(id)}/view`,
      { method: "POST", body: { reason } },
    );
    if (version !== state.routeVersion) return;
    const html = supportConversationMarkup(data, { staff: true });
    state.supportDetail = data;
    document.querySelector("#support-detail-area").innerHTML = html;
    bindEngagement();
    announce("Private support conversation opened. Access was recorded.");
    document.querySelector("#support-reply")?.focus();
  } catch (error) {
    area.textContent = supportErrorMessage(error);
  } finally {
    delete form.dataset.pending;
    restore();
  }
}
async function sendSupportReply(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.pending) return;
  const errorArea = form.querySelector("#support-reply-error");
  errorArea.textContent = "";
  const detail = state.supportDetail;
  try {
    const payload = parseSupportReply(
      Object.fromEntries(new FormData(form)),
      detail,
    );
    if (form.dataset.staff === "true") {
      if (state.session?.operator !== true)
        throw new Error("Staff access is required.");
      reviewSupportWrite("reply", payload, detail.case.id);
      return;
    }
    if (
      detail.case.canReply !== true ||
      detail.allowedActions?.followUp !== true
    )
      throw new Error(
        "This request cannot receive a reply yet. Contact support with its reference.",
      );
    form.dataset.pending = "true";
    const restore = busy(
      form.querySelector("button[type=submit]"),
      "Sending reply…",
    );
    const version = state.routeVersion;
    try {
      const intent = supportIntent(`customer-reply:${detail.case.id}`);
      const body = intent.prepare(payload);
      const result = await api(
        `/api/support/${encodeURIComponent(detail.case.id)}/replies`,
        { method: "POST", body },
      );
      if (
        result.case?.id !== detail.case.id ||
        !Number.isInteger(result.case?.version) ||
        result.case.version <= payload.expectedVersion ||
        !Array.isArray(result.messages)
      )
        throw new Error(
          "No complete reply receipt was returned. Retry unchanged to reuse this request.",
        );
      intent.complete(body.idempotencyKey);
      if (version !== state.routeVersion) return;
      state.supportDetail = result;
      document.querySelector("#support-detail-area").innerHTML =
        supportConversationMarkup(result);
      bindEngagement();
      announce("Your reply was recorded.");
      toast("Reply sent. The conversation shows its current status.");
      document.querySelector("#support-reply")?.focus();
    } finally {
      delete form.dataset.pending;
      restore();
    }
  } catch (error) {
    errorArea.textContent = supportErrorMessage(error);
  }
}
function reviewSupportStatus(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const area = form.querySelector("#support-status-error");
  area.textContent = "";
  try {
    if (state.session?.operator !== true)
      throw new Error("Staff access is required.");
    const payload = parseSupportStatus(
      Object.fromEntries(new FormData(form)),
      state.supportDetail,
    );
    reviewSupportWrite("status", payload, state.supportDetail.case.id);
  } catch (error) {
    area.textContent = supportErrorMessage(error);
  }
}
function reviewSupportWrite(kind, payload, id) {
  const version = state.routeVersion;
  const intent = supportIntent(`staff-${kind}:${id}`);
  const body = intent.prepare(payload);
  modal.innerHTML = supportReviewMarkup(kind, id, payload);
  const reviewForm = modal.querySelector("#support-confirm-form");
  let pending = false;
  const preventClose = (event) => {
    if (pending) event.preventDefault();
  };
  modal.addEventListener("cancel", preventClose);
  modal.addEventListener(
    "close",
    () => {
      modal.removeEventListener("cancel", preventClose);
      if (modal.querySelector("#support-confirm-form") === reviewForm)
        modal.innerHTML = "";
    },
    { once: true },
  );
  modal.showModal();
  modal.querySelector("input[name=confirmed]").focus();
  modal
    .querySelector("#support-confirm-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending) return;
      const form = event.currentTarget;
      const area = form.querySelector("#support-confirm-error");
      area.textContent = "";
      if (
        !form.querySelector("input[name=confirmed]").checked ||
        state.session?.operator !== true ||
        version !== state.routeVersion
      ) {
        area.textContent =
          "Review this action and confirm it from the same authorized conversation.";
        return;
      }
      pending = true;
      const controls = [...modal.querySelectorAll("button,input")];
      controls.forEach((control) => {
        control.disabled = true;
      });
      const restore = busy(
        form.querySelector("button[type=submit]"),
        kind === "reply" ? "Sending reply…" : "Changing status…",
      );
      try {
        const result = await api(
          `/api/operator/support/${encodeURIComponent(id)}/${kind === "reply" ? "replies" : "status"}`,
          { method: "POST", body },
        );
        if (
          result.case?.id !== id ||
          !Number.isInteger(result.case?.version) ||
          result.case.version <= payload.expectedVersion
        )
          throw new Error(
            "No case update receipt was returned. Retry unchanged to reuse this request.",
          );
        intent.complete(body.idempotencyKey);
        pending = false;
        modal.close();
        if (version !== state.routeVersion) return;
        state.supportDetail = null;
        const receipt =
          kind === "reply"
            ? "Customer reply recorded. The private conversation is closed; reopen it explicitly to read the updated thread."
            : "Case status updated. The private conversation is closed; reopen it explicitly to read the updated thread.";
        document.querySelector("#support-detail-area").innerHTML =
          supportAccessMarkup(id, receipt);
        bindEngagement();
        announce(
          kind === "reply"
            ? "Customer reply recorded."
            : "Case status updated.",
        );
        document.querySelector("#support-access-reason")?.focus();
      } catch (error) {
        area.textContent = supportErrorMessage(error);
      } finally {
        pending = false;
        controls.forEach((control) => {
          control.disabled = false;
        });
        restore();
      }
    });
}
async function handleEngagementAction(element) {
  const action = element.dataset.action;
  const routeVersion = state.routeVersion;
  const restore = busy(
    element,
    action === "read-notification" ? "Marking as read…" : "Loading more…",
  );
  try {
    if (action === "read-notification") {
      const id = resourceId(element.dataset.id);
      if (!id || !state.inbox?.notifications.some((item) => item.id === id))
        throw new Error("Refresh the inbox before marking this update read.");
      const result = await api("/api/notifications/read", {
        method: "POST",
        body: { ids: [id] },
      });
      if (
        !result.readIds?.includes(id) ||
        !Number.isInteger(result.unreadCount) ||
        result.unreadCount < 0
      )
        throw new Error(
          "Read status was not confirmed. Refresh the inbox or retry this action.",
        );
      if (routeVersion !== state.routeVersion) return;
      state.inbox.unreadCount = result.unreadCount;
      state.unreadCount = result.unreadCount;
      state.inbox.notifications = state.inbox.notifications
        .map((item) => (item.id === id ? { ...item, readAt: "read" } : item))
        .filter((item) => !inboxQuery().has("unreadOnly") || !item.readAt);
      root.innerHTML = inboxPage();
      bindPage();
      announce(
        "Notification marked as read. Its underlying job, payment issue, or support status is unchanged.",
      );
      document.querySelector("#inbox-unread-only")?.focus();
    } else if (action === "more-notifications") {
      const cursor = state.inbox?.nextCursor;
      if (!cursor) return;
      const next = normalizeNotifications(
        await api(`/api/notifications?${inboxQuery(cursor)}`),
      );
      if (routeVersion !== state.routeVersion) return;
      const items = new Map(
        state.inbox.notifications.map((item) => [item.id, item]),
      );
      next.notifications.forEach((item) => items.set(item.id, item));
      state.inbox = { ...next, notifications: [...items.values()] };
      state.unreadCount = next.unreadCount;
      document.querySelector("#inbox-area").innerHTML = inboxMarkup(
        state.inbox,
        inboxQuery().has("unreadOnly"),
      );
      bindEngagement();
      announce(`${next.notifications.length} more updates loaded.`);
      document.querySelector('[data-action="more-notifications"]')?.focus();
    } else {
      const staff = action === "more-operator-support";
      const cursor = state.supportList?.nextCursor;
      if (!cursor) return;
      const next = await api(
        `${staff ? "/api/operator/support" : "/api/support"}?${supportQuery(cursor)}`,
      );
      if (!Array.isArray(next.cases))
        throw new Error(
          "No support page was returned. Retry to load this page.",
        );
      if (routeVersion !== state.routeVersion) return;
      const items = new Map(
        state.supportList.cases.map((item) => [item.id, item]),
      );
      next.cases.forEach((item) => items.set(item.id, item));
      state.supportList = { ...next, cases: [...items.values()] };
      document.querySelector("#support-list-area").innerHTML =
        supportListMarkup(state.supportList, {
          staff,
          status: supportFilter(),
        });
      bindEngagement();
      announce(`${next.cases.length} more support requests loaded.`);
      document.querySelector(`[data-action="${action}"]`)?.focus();
    }
  } catch (error) {
    const area = document.querySelector(
      action.includes("notification") ? "#inbox-error" : "#support-list-error",
    );
    if (area) area.textContent = error.message;
  } finally {
    restore();
  }
}
async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting) return;
  form.dataset.submitting = "true";
  const data = new FormData(form);
  const mode = form.dataset.mode;
  const restore = busy(
    form.querySelector("button[type=submit]"),
    {
      recover: "Sending recovery request…",
      reset: "Updating password…",
      login: "Signing in…",
      signup: "Creating account…",
    }[mode] || "Please wait…",
  );
  const errorArea = form.querySelector("#auth-error");
  errorArea.textContent = "";
  const returnTo = localReturnPath(
    new URLSearchParams(location.search).get("returnTo"),
  );
  try {
    if (state.config.auth?.provider === "development") {
      if (!["login", "signup"].includes(mode))
        throw Object.assign(
          new Error("Recovery is unavailable in development sign-in."),
          { code: "AUTH_UNAVAILABLE" },
        );
      const result = await api("/api/dev/session", {
        method: "POST",
        authenticated: false,
        body: { email: String(data.get("email") || "").trim() },
      });
      if (!result.token)
        throw Object.assign(new Error("The local session was not returned."), {
          code: "INVALID_RESPONSE",
        });
      setDevelopmentToken(result.token);
    } else {
      const auth = authClient()?.auth;
      if (!auth)
        throw Object.assign(new Error("Account tools are unavailable."), {
          code: "AUTH_UNAVAILABLE",
        });
      if (mode === "recover") {
        await requestRecoveryEmail(
          auth,
          data.get("email"),
          recoveryRedirect(location.origin, returnTo),
        );
        form.innerHTML =
          notice(
            "Recovery request accepted. If that address has an account, check your inbox and spam folder for a reset link. Open the newest email in this same browser.",
            "success",
          ) +
          '<p class="help-text">A request being accepted does not confirm email delivery or that an account exists.</p>';
        announce("Recovery email request accepted.");
        return;
      }
      if (mode === "reset") {
        await updateRecoveredPassword(
          auth,
          {
            password: data.get("password"),
            confirmPassword: data.get("confirmPassword"),
          },
          authCallbackState(),
        );
        form.innerHTML =
          notice(
            "Your account provider confirmed the password update. Use your new password the next time you sign in.",
            "success",
          ) +
          '<div class="actions"><a class="button primary" href="' +
          e(returnTo) +
          '" data-link>Continue to workspace</a><a class="button quiet" href="/login" data-link>Back to sign in</a></div>';
        announce("Password updated.");
        return;
      }
      let result;
      if (mode === "login")
        result = await auth.signInWithPassword({
          email: String(data.get("email") || "").trim(),
          password: data.get("password"),
        });
      if (mode === "signup")
        result = await auth.signUp({
          email: String(data.get("email") || "").trim(),
          password: data.get("password"),
          options: {
            emailRedirectTo:
              location.origin +
              "/auth/callback?returnTo=" +
              encodeURIComponent(returnTo),
          },
        });
      if (!result || result.error)
        throw (
          result?.error ||
          Object.assign(new Error("Missing authentication result."), {
            code: "INVALID_RESPONSE",
          })
        );
      if (mode === "signup" && !result.data?.session) {
        if (!result.data?.user?.id)
          throw Object.assign(new Error("Missing account result."), {
            code: "INVALID_RESPONSE",
          });
        form.innerHTML = notice(
          "The signup request was accepted. Check your email for a confirmation link, then return to sign in. If you already have an account, use sign-in or recovery.",
          "success",
        );
        announce("Signup request accepted. Check your email.");
        return;
      }
      if (!result.data?.session?.access_token)
        throw Object.assign(new Error("No signed-in session was returned."), {
          code: "INVALID_RESPONSE",
        });
    }
    try {
      await refreshSession();
    } catch {
      form.innerHTML =
        notice(
          "You are signed in, but your workspace could not be loaded. Your password does not need to be submitted again.",
          "warning",
        ) +
        '<a href="' +
        e(returnTo) +
        '" class="button primary" data-link>Try opening workspace</a>';
      return;
    }
    toast("Your workspace is ready.");
    await navigate(returnTo, true);
  } catch (error) {
    errorArea.textContent = error.safeMessage || authErrorMessage(error, mode);
  } finally {
    delete form.dataset.submitting;
    restore();
  }
}
async function submitStaffMfa(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting) return;
  const errorArea = document.querySelector("#staff-mfa-error");
  const statusArea = document.querySelector("#staff-mfa-status");
  errorArea.textContent = "";
  statusArea.textContent = "";
  const restore = busy(
    form.querySelector("button[type=submit]"),
    "Verifying authenticator…",
  );
  form.dataset.submitting = "true";
  try {
    if (!staffMfaAllowed(state.session, state.config))
      throw new Error("Staff verification is not available for this account.");
    const values = new FormData(form),
      factorId = values.get("factorId");
    if (
      state.staffMfa.enrollment?.id !== factorId &&
      !state.staffMfa.factors.some((factor) => factor.id === factorId)
    )
      throw new Error("Choose your current authenticator.");
    await verifyStaffFactor(
      authClient().auth.mfa,
      factorId,
      values.get("code"),
    );
    state.staffMfa.enrollment = null;
    document.querySelector(".mfa-setup")?.remove();
    try {
      await refreshSession();
    } catch {
      statusArea.textContent =
        "Your authenticator was verified, but the server could not confirm staff access. Refresh this page to check access; no operations have been unlocked here.";
      return;
    }
    if (state.session.operator !== true) {
      statusArea.textContent =
        "Your second factor was verified, but this account has not been authorized for operations by the server. Contact the service operator.";
      return;
    }
    toast("Second factor verified. Staff access confirmed by the server.");
    await renderRoute();
  } catch (error) {
    errorArea.textContent = mfaErrorMessage(error);
  } finally {
    form.querySelector("[name=code]")?.setAttribute("value", "");
    const code = form.querySelector("[name=code]");
    if (code) code.value = "";
    delete form.dataset.submitting;
    restore();
  }
}
async function submitOAuthReconnect(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting) return;
  const values = new FormData(form);
  const errorArea = form.querySelector("#oauth-reconnect-error");
  const statusArea = form.querySelector("#oauth-reconnect-status");
  errorArea.textContent = "";
  statusArea.textContent = "";
  const restore = busy(
    form.querySelector("button[type=submit]"),
    "Resetting selected connection…",
  );
  form.dataset.submitting = "true";
  try {
    if (!state.oauthReconnect || !values.has("confirmation"))
      throw new Error("Select one connection and confirm the reset first.");
    const selected = reconnectSelection(
      state.oauthReconnect,
      values.get("connectionId"),
    );
    const result = await api(
      `/api/connections/${encodeURIComponent(selected.id)}/reconnect`,
      {
        method: "POST",
        body: {
          expectedVersion: selected.expectedVersion,
          confirmation: "reconnect",
        },
      },
    );
    const connection = state.oauthReconnect?.connections.find(
      (item) => item.id === selected.id,
    );
    if (connection && Number.isInteger(result.version))
      connection.version = result.version;
    if (result.upstreamRevocationPending) {
      statusArea.textContent =
        "AppScreen access to this connection is revoked, but the sign-in provider has not completed the reset. Retry this selected connection before restarting your agent.";
      return;
    }
    if (!result.reconnectReady || !result.restartRequired)
      throw new Error(
        "The reset was not confirmed. Refresh this page to inspect the current connection before retrying.",
      );
    form.innerHTML = notice(
      "The selected connection is ready to reconnect. Return to Codex, Claude Code, or your MCP client and restart authorization. You will approve the new connection’s permissions there; no scope or expiry was expanded automatically.",
      "success",
    );
    announce(
      "Selected connection reset. Restart authorization from your agent.",
    );
  } catch (error) {
    errorArea.textContent =
      error.code === "OAUTH_CONNECTION_CHANGED"
        ? "This connection changed in another session. Refresh this page before choosing it again."
        : error.code === "OAUTH_CONNECTION_BUSY"
          ? "Another reset is still in progress. Wait briefly, then retry this selected connection."
          : error.message;
  } finally {
    delete form.dataset.submitting;
    restore();
  }
}
async function submitOAuthConsent(event) {
  event.preventDefault();
  const consent = state.oauthConsent;
  const action = event.submitter?.value;
  const form = event.currentTarget;
  const errorArea = form.querySelector("#oauth-error");
  errorArea.textContent = "";
  if (
    !consent ||
    !["approve", "deny"].includes(action) ||
    state.config.auth?.provider !== "supabase" ||
    !state.config.mcp?.oauthEnabled
  ) {
    errorArea.textContent =
      "This approval request is no longer active. Refresh to check it again.";
    return;
  }
  const scopes = new FormData(form).getAll("scopes");
  if (action === "approve" && !scopes.length) {
    errorArea.textContent =
      "Choose at least one workspace permission, or cancel the connection.";
    return;
  }
  const restorers = [...form.querySelectorAll("button")].map((element) =>
    busy(
      element,
      element.value === action
        ? action === "approve"
          ? "Approving access…"
          : "Cancelling connection…"
        : "Please wait…",
    ),
  );
  try {
    const response = await api(
      `/api/oauth/authorizations/${encodeURIComponent(consent.authorizationId)}/consent`,
      {
        method: "POST",
        body: {
          consentNonce: consent.consentNonce,
          action,
          scopes: action === "approve" ? scopes : [],
          days: 30,
        },
      },
    );
    const redirect = safeOAuthRedirect(response.redirectUrl);
    if (!redirect)
      throw new Error(
        "The connection returned an unsupported callback. Check Agent connections before retrying.",
      );
    state.oauthConsent = null;
    announce(
      action === "approve"
        ? "Selected agent access approved."
        : "Agent connection cancelled.",
    );
    location.assign(redirect);
  } catch (error) {
    errorArea.textContent = error.message;
    restorers.forEach((restore) => restore());
  }
}
function updateBackupImportDialog() {
  const form = modal.querySelector("#backup-import-form");
  const controller = state.backupImport;
  if (!form || !controller) return;
  const view = controller.snapshot();
  const failed = ["error", "retry", "blocked"].includes(view.phase);
  form.querySelector("#backup-import-error").textContent = failed ? view.message : "";
  form.querySelector("#backup-import-status").textContent = failed ? "" : view.message;
  for (const input of form.querySelectorAll("input")) input.disabled = view.pending || view.frozen;
  for (const control of modal.querySelectorAll('[data-action="close-dialog"]')) control.disabled = view.pending;
  const submit = form.querySelector('button[type="submit"]');
  submit.hidden = view.phase === "ready";
  submit.disabled = view.pending || view.phase === "blocked";
  submit.textContent = view.phase === "checking" ? "Checking backup…"
    : view.phase === "importing" ? "Importing campaign…"
      : view.phase === "retry" ? "Retry import" : "Import as new campaign";
  if (view.pending) submit.setAttribute("aria-busy", "true");
  else submit.removeAttribute("aria-busy");
  const open = form.querySelector("#backup-import-open");
  open.hidden = view.phase !== "ready";
  if (view.result) open.href = `/app/projects/${encodeURIComponent(view.result.project.id)}`;
  const frozen = form.querySelector("#backup-import-file-note");
  frozen.textContent = view.phase === "ready" ? `Imported backup: ${view.fileName}.`
    : view.frozen ? `Selected backup: ${view.fileName}. Its file and name stay fixed for a safe retry.` : "";
}
function openImportBackup() {
  if (modal.open) return;
  const returnFocus = document.activeElement;
  if (!state.backupImport || ["ready", "blocked"].includes(state.backupImport.snapshot().phase)) {
    let controller;
    try {
      controller = createBackupImport(api, {
        scope: () => state.session ? `${state.session.user?.id}:${state.session.workspace?.id}` : null,
        target: { userId: state.session?.user?.id, workspaceId: state.session?.workspace?.id },
        storage: window.sessionStorage,
        onChange: () => {
          if (state.backupImport === controller) updateBackupImportDialog();
        },
      });
    } catch {
      toast("Your browser could not keep a safe import receipt. Allow session storage and try again.", true);
      return;
    }
    state.backupImport = controller;
  }
  const view = state.backupImport.snapshot();
  modal.classList.add("backup-import-dialog");
  modal.innerHTML = `<button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close import">×</button>
    <p class="eyebrow">Bring your design back</p><h2 id="modal-title">Import an editable backup.</h2>
    <p>Your layout, copy, connected devices, and original screenshots become a <strong>new campaign</strong>. Existing campaigns will not be replaced.</p>
    <form id="backup-import-form">
      <div class="field"><label for="backup-import-file">Editable-project ZIP</label><input id="backup-import-file" type="file" accept=".zip,application/zip" required aria-describedby="backup-import-file-help backup-import-file-note"><p id="backup-import-file-help" class="help-text">AppScreen editable backups only · up to 100 MiB. Store PNG ZIPs, whole-workspace archives, and legacy JSON backups are not supported here.</p><p id="backup-import-file-note" class="help-text"></p></div>
      <div class="field"><label for="backup-import-name">New campaign name <span class="muted">(optional)</span></label><input id="backup-import-name" maxlength="120" value="${e(view.copyName)}" placeholder="Saved name · Imported copy"><p class="help-text">Leave blank to keep the saved name with “Imported copy” added.</p></div>
      <p class="help-text">The backup uploads to your private workspace. No AI runs and no AI credits are used.</p>
      <p id="backup-import-status" role="status" aria-live="polite"></p><p id="backup-import-error" class="inline-error" role="alert" tabindex="-1"></p>
      <div class="actions">${button("Close", "close-dialog", { quiet: true })}<button class="button primary" type="submit">Import as new campaign</button><a id="backup-import-open" class="button primary" data-link hidden>Open imported campaign</a></div>
    </form>`;
  const preventPendingClose = event => {
    if (state.backupImport?.snapshot().pending) event.preventDefault();
  };
  modal.addEventListener("cancel", preventPendingClose);
  modal.addEventListener("close", () => {
    modal.removeEventListener("cancel", preventPendingClose);
    modal.classList.remove("backup-import-dialog");
    if (state.backupImport?.snapshot().phase === "ready") state.backupImport = null;
    if (location.hash === "#import-backup") history.replaceState({}, "", location.pathname + location.search);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }, { once: true });
  modal.querySelector("#backup-import-form").addEventListener("submit", async event => {
    event.preventDefault();
    const controller = state.backupImport;
    if (!controller) return;
    const form = event.currentTarget;
    const file = form.querySelector("#backup-import-file").files[0];
    const name = form.querySelector("#backup-import-name").value;
    await controller.submit(file, name);
    if (state.backupImport !== controller || !modal.open) return;
    const current = controller.snapshot();
    if (current.phase === "ready") form.querySelector("#backup-import-open").focus();
    else if (!current.pending) {
      const feedback = form.querySelector("#backup-import-error");
      feedback.focus({ preventScroll: true });
      feedback.scrollIntoView({ block: "center", behavior: "instant" });
    }
  });
  modal.showModal();
  updateBackupImportDialog();
  modal.querySelector(view.frozen ? 'button[type="submit"]' : "#backup-import-file").focus();
}
function openCreateProject() {
  modal.innerHTML = `<button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><h2 id="modal-title">A new campaign.</h2><p>Give this project a name. You can add your screenshots and brief next.</p><form id="create-project-form"><div class="field"><label for="project-name">Campaign name</label><input id="project-name" name="name" required maxlength="120" placeholder="Your app · launch campaign" autofocus></div><p id="create-error" class="inline-error" role="alert"></p><div class="actions">${button("Cancel", "close-dialog", { quiet: true })}<button class="button primary" type="submit">Create campaign ${icon("arrow")}</button></div></form>`;
  modal.showModal();
  document.querySelector("#project-name").focus();
  document
    .querySelector("#create-project-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const restore = busy(
        form.querySelector("button[type=submit]"),
        "Creating…",
      );
      try {
        const result = await api("/api/projects", {
          method: "POST",
          body: { name: new FormData(form).get("name").trim() },
        });
        modal.close();
        toast("Campaign created. Add your screenshots to get started.");
        await navigate(
          `/app/projects/${encodeURIComponent(result.project.id)}`,
        );
      } catch (error) {
        document.querySelector("#create-error").textContent = error.message;
      } finally {
        restore();
      }
    });
}
async function uploadFiles(files) {
  if (state.uploading || !files.length) return;
  const projectRef = state.project;
  const draftRef = draft();
  const projectId = projectRef.project.id;
  state.uploading = true;
  const input = document.querySelector("#screenshot-files");
  input.disabled = true;
  const list = document.querySelector("#upload-list");
  try {
    for (const file of files) {
      const item = document.createElement("li");
      item.innerHTML = `<span>${e(file.name)}</span><span role="status">Checking…</span>`;
      list.append(item);
      const status = item.lastElementChild;
      try {
        const issue = validateFileMetadata(
          file,
          state.config.limits?.maxUploadBytes || 15 * 1024 * 1024,
        );
        if (issue) throw new Error(issue);
        const image = await createImageBitmap(file);
        const invalid =
          image.width < 200 ||
          image.height < 200 ||
          image.width * image.height > 40000000;
        image.close();
        if (invalid)
          throw new Error(
            "Use a clear screenshot at least 200 × 200 pixels and below 40 megapixels.",
          );
        status.textContent = "Uploading…";
        const body = new FormData();
        body.append("file", file);
        const { asset } = await api(
          `/api/projects/${encodeURIComponent(projectId)}/assets`,
          { method: "POST", body, timeout: 120000 },
        );
        const targetProject =
          state.project?.project.id === projectId ? state.project : projectRef;
        const targetDraft = state.drafts.get(projectId) || draftRef;
        if (!targetProject.assets.some((existing) => existing.id === asset.id))
          targetProject.assets.push(asset);
        if (
          targetDraft.sourceIds.length < 10 &&
          !targetDraft.sourceIds.includes(asset.id)
        )
          targetDraft.sourceIds.push(asset.id);
        queueBriefSave(projectId);
        status.textContent = "Uploaded";
        status.className = "status-ready";
      } catch (error) {
        status.textContent = error.message;
        status.className = "status-failed";
      }
      if (
        state.project?.project.id === projectId &&
        document.querySelector("#source-area")
      )
        document.querySelector("#source-area").innerHTML = sourceMarkup();
    }
    announce("Screenshot uploads finished. Review the file statuses.");
    queueBriefSave(projectId);
  } finally {
    state.uploading = false;
    input.disabled = false;
    input.value = "";
  }
}
async function submitDesign(event) {
  event.preventDefault();
  captureDraft();
  const values = draft();
  const form = event.currentTarget;
  const errorArea = document.querySelector("#brief-error");
  errorArea.textContent = "";
  delete errorArea.dataset.templateError;
  const selection = requireTemplateSelection(values);
  if (!selection) return;
  if (values.sourceIds.length < 3 || values.sourceIds.length > 10) {
    errorArea.textContent = "Select 3–10 uploaded screenshots before starting.";
    return;
  }
  if (state.uploading) {
    errorArea.textContent = "Wait for the current uploads to finish.";
    return;
  }
  const restore = busy(
    form.querySelector("button[type=submit]"),
    "Starting campaign…",
  );
  if (
    values.appName.trim().length > 100 ||
    values.promise.trim().length > 600
  ) {
    errorArea.textContent =
      "Keep the app name under 100 characters and the main benefit under 600 characters.";
    restore();
    return;
  }
  const confirmedFacts = values.facts
    .split("\n")
    .map((fact) => fact.trim())
    .filter(Boolean);
  if (
    confirmedFacts.length > 30 ||
    confirmedFacts.some((fact) => fact.length > 400)
  ) {
    errorArea.textContent =
      "Use up to 30 fact lines, each under 400 characters.";
    restore();
    return;
  }
  const payload = {
    brief: {
      appName: values.appName.trim(),
      promise: values.promise.trim(),
      audience: values.audience.trim(),
      confirmedFacts,
      style: values.style,
      brandColors: [values.brandColor],
    },
    sourceIds: values.sourceIds,
    templateMode: values.templateMode,
    templateId: selection.templateId,
    locks: Object.fromEntries(values.locks.map((lock) => [lock, true])),
    screenCount: values.screenCount,
    profile: { id: "iphone-6.9", width: 1320, height: 2868 },
    locale: "en",
  };
  try {
    await flushBriefSave();
    const result = await api(
      `/api/projects/${encodeURIComponent(state.project.project.id)}/design-jobs`,
      {
        method: "POST",
        body: { ...payload, idempotencyKey: operationKey("design", payload) },
      },
    );
    state.project.jobs.unshift(result.job);
    updateJobSections();
    startPolling();
    toast("Campaign started. You can leave and return while it designs.");
  } catch (error) {
    errorArea.textContent = error.message;
  } finally {
    restore();
  }
}
async function createManualDraft(element) {
  captureDraft();
  const values = draft();
  const errorArea = document.querySelector("#brief-error");
  errorArea.textContent = "";
  delete errorArea.dataset.templateError;
  const selection = requireTemplateSelection(values);
  if (!selection) return;
  if (!values.sourceIds.length) {
    toast("Upload and select at least one screenshot first.", true);
    return;
  }
  if (state.uploading) {
    toast("Wait for the current uploads to finish.", true);
    return;
  }
  const restore = busy(element, "Creating editable draft…");
  try {
    await flushBriefSave();
    const { revision } = await api(
      `/api/projects/${encodeURIComponent(state.project.project.id)}/drafts`,
      {
        method: "POST",
        body: {
          assetIds: values.sourceIds,
          ...(selection.templateId ? { templateId: selection.templateId } : {}),
          templateMode: values.templateMode,
          screenCount: values.screenCount,
          locale: "en",
          profile: { id: "iphone-6.9", width: 1320, height: 2868 },
          locks: Object.fromEntries(values.locks.map((lock) => [lock, true])),
          brief: {
            appName: values.appName,
            promise: values.promise,
            audience: values.audience,
            confirmedFacts: values.facts.split("\n").filter(Boolean),
            brandColors: [values.brandColor],
            style: values.style,
          },
          apply: false,
          idempotencyKey: operationKey("manual-draft", {
            projectId: state.project.project.id,
            ...values,
          }),
        },
      },
    );
    location.assign(
      `/editor?project=${encodeURIComponent(state.project.project.id)}&revision=${encodeURIComponent(revision.id)}`,
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    restore();
  }
}
async function submitRevision(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const restore = busy(
    form.querySelector("button[type=submit]"),
    "Starting refinement…",
  );
  const baseRevisionId =
    revisionId(state.project.proposedRevision) ||
    jobRevisionId(currentJob()) ||
    state.project.project.activeRevisionId ||
    revisionId(state.project.revision);
  const scope = {};
  if (values.get("sceneId")) scope.sceneIds = [values.get("sceneId")];
  if (values.get("deviceId")) scope.deviceIds = [values.get("deviceId")];
  const payload = { prompt: values.get("prompt"), baseRevisionId, scope };
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(state.project.project.id)}/revision-jobs`,
      {
        method: "POST",
        body: { ...payload, idempotencyKey: operationKey("revision", payload) },
      },
    );
    state.project.jobs.unshift(result.job);
    updateJobSections();
    startPolling();
    toast("Refinement started. Your current version remains unchanged.");
  } catch (error) {
    document.querySelector("#revision-error").textContent = error.message;
  } finally {
    restore();
  }
}
function updateJobSections() {
  document.querySelector("#job-area").innerHTML = jobMarkup(currentJob());
  if (TERMINAL_STATES.has(jobState(currentJob()))) {
    document.querySelector("#revision-area").innerHTML = revisionMarkup();
    document
      .querySelector("#revision-form")
      ?.addEventListener("submit", submitRevision);
  }
}
function startPolling() {
  clearTimeout(state.poll);
  const id = state.project?.project.id;
  const job = currentJob();
  if (!job || TERMINAL_STATES.has(jobState(job))) return;
  state.poll = setTimeout(
    async () => {
      if (!state.route.startsWith(`/app/projects/${id}`)) return;
      try {
        const { job: updated } = await api(
          `/api/jobs/${encodeURIComponent(job.id)}`,
        );
        if (state.project?.project.id !== id) return;
        const previous = jobState(job);
        const index = state.project.jobs.findIndex(
          (item) => item.id === updated.id,
        );
        if (index >= 0) state.project.jobs[index] = updated;
        if (TERMINAL_STATES.has(jobState(updated))) {
          state.project = await loadProject(id);
          await refreshSession();
          announce(stageLabel(updated));
          if (previous !== jobState(updated))
            toast(stageLabel(updated), jobState(updated) === "failed");
        }
        updateJobSections();
      } catch (error) {
        const area = document.querySelector("#job-area");
        if (area && !area.querySelector("[data-poll-error]"))
          area.insertAdjacentHTML(
            "beforeend",
            `<p class="help-text warning-text" data-poll-error role="status">Couldn’t refresh progress. Reconnecting automatically; your server job may still be running.</p>`,
          );
      }
      startPolling();
    },
    document.hidden ? 8000 : 2500,
  );
}
function reviewCreditAdjustment(event) {
  event.preventDefault();
  const sourceForm = event.currentTarget;
  const errorArea = sourceForm.querySelector("#operator-credit-error");
  errorArea.textContent = "";
  try {
    if (state.session?.operator !== true)
      throw new Error("Operator access is required for credit adjustments.");
    const payload = parseCreditAdjustment(
      Object.fromEntries(new FormData(sourceForm)),
    );
    const idempotencyKey = operationKey("operator-credit", payload);
    modal.innerHTML = creditReviewMarkup(payload);
    let pending = false;
    const preventPendingClose = (event) => {
      if (pending) event.preventDefault();
    };
    modal.addEventListener("cancel", preventPendingClose);
    modal.addEventListener(
      "close",
      () => modal.removeEventListener("cancel", preventPendingClose),
      { once: true },
    );
    modal.showModal();
    modal.querySelector("#credit-confirmation").focus();
    modal
      .querySelector("#operator-credit-confirm-form")
      .addEventListener("submit", async (confirmEvent) => {
        confirmEvent.preventDefault();
        if (pending) return;
        const form = confirmEvent.currentTarget;
        const confirmation = new FormData(form).get("confirmation");
        const confirmError = form.querySelector("#credit-confirm-error");
        confirmError.textContent = "";
        if (confirmation !== "ADJUST CREDITS") {
          confirmError.textContent = "Type ADJUST CREDITS exactly to confirm.";
          return;
        }
        pending = true;
        const controls = [...modal.querySelectorAll("button")];
        controls.forEach((control) => {
          control.disabled = true;
        });
        const submit = form.querySelector("button[type=submit]");
        const restore = busy(submit, "Recording adjustment…");
        try {
          const result = await api("/api/operator/credits", {
            method: "POST",
            body: { ...payload, idempotencyKey, confirmation },
          });
          const receipt = result.receipt || result;
          if (!receipt.id && !receipt.receiptId)
            throw new Error(
              "No adjustment receipt was returned. Check service operations before retrying; a retry will reuse this request ID.",
            );
          state.operationKeys.delete(
            `operator-credit:${JSON.stringify(payload)}`,
          );
          pending = false;
          modal.close();
          sourceForm.reset();
          const area = document.querySelector("#operator-credit-receipt");
          if (area) area.innerHTML = creditReceiptMarkup(result);
          toast("Credit adjustment recorded. Review the server receipt.");
        } catch (error) {
          confirmError.textContent = error.message;
        } finally {
          pending = false;
          controls.forEach((control) => {
            control.disabled = false;
          });
          restore();
        }
      });
  } catch (error) {
    errorArea.textContent = error.message;
  }
}
async function confirmDeletion(action = "request") {
  const workspaceId = state.session?.workspace?.id;
  const cancelling = action === "cancel";
  let requestId;
  try {
    if (
      !workspaceId ||
      !state.deletionLifecycle ||
      state.deletionLifecycle.unavailable
    )
      throw new Error(
        "Refresh account status before changing a deletion request.",
      );
    requestId = cancelling
      ? deletionCancellationTarget(state.deletionLifecycle)
      : null;
  } catch (error) {
    toast(error.message, true);
    return;
  }
  const anchor =
    requestId || state.deletionLifecycle.request?.requestId || "none";
  const intent = lifecycleActionKey(
    sessionStorage,
    workspaceId,
    action,
    anchor,
    () => operationKey("account-lifecycle-" + action, { workspaceId, anchor }),
  );
  const confirmationText = cancelling ? "KEEP DATA" : "DELETE";
  modal.innerHTML =
    '<button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><h2 id="modal-title">' +
    (cancelling ? "Keep your workspace data?" : "Request workspace deletion?") +
    "</h2><p>" +
    (cancelling
      ? "This cancels all currently pending deletion requests for this workspace, including older duplicates. It does not cancel requests created later, restore removed content, or change billing."
      : "This records a deletion request for the current workspace. Export anything you want to keep first. Automatic deletion and billing cancellation are not configured; manual fulfillment and retention-policy setup are still required.") +
    '</p><p class="help-text">Workspace: ' +
    e(state.session.workspace.name || workspaceId) +
    '<br><code class="operator-id">' +
    e(workspaceId) +
    '</code></p><form id="deletion-form"><div class="field"><label for="deletion-confirmation">Type ' +
    confirmationText +
    ' to confirm</label><input id="deletion-confirmation" name="confirmation" required pattern="' +
    confirmationText +
    '" autocomplete="off" spellcheck="false"></div><p id="deletion-error" class="inline-error" role="alert"></p><div class="actions">' +
    button("Go back", "close-dialog", { quiet: true }) +
    '<button type="submit" class="button ' +
    (cancelling ? "" : "danger") +
    '">' +
    (cancelling
      ? "Cancel pending deletion requests"
      : "Submit deletion request") +
    "</button></div></form>";
  let pending = false;
  const preventClose = (event) => {
    if (pending) event.preventDefault();
  };
  modal.addEventListener("cancel", preventClose);
  modal.addEventListener(
    "close",
    () => modal.removeEventListener("cancel", preventClose),
    { once: true },
  );
  modal.showModal();
  modal.querySelector("#deletion-confirmation").focus();
  modal
    .querySelector("#deletion-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending) return;
      const form = event.currentTarget,
        errorArea = form.querySelector("#deletion-error");
      const confirmation = new FormData(form).get("confirmation");
      errorArea.textContent = "";
      if (confirmation !== confirmationText) {
        errorArea.textContent =
          "Type " + confirmationText + " exactly to continue.";
        return;
      }
      if (state.session?.workspace?.id !== workspaceId) {
        errorArea.textContent =
          "The active workspace changed. Close this dialog and check account status again.";
        return;
      }
      const controls = [...modal.querySelectorAll("button")];
      controls.forEach((control) => {
        control.disabled = true;
      });
      const restore = busy(
        form.querySelector("button[type=submit]"),
        cancelling ? "Cancelling pending requests…" : "Recording request…",
      );
      pending = true;
      try {
        const payload = { confirmation, idempotencyKey: intent.idempotencyKey };
        if (cancelling) payload.requestId = requestId;
        const result = await api(
          "/api/account/deletion-request" + (cancelling ? "/cancel" : ""),
          { method: "POST", body: payload },
        );
        if (
          !["none", "pending", "requires-review", "cancelled"].includes(
            result.status,
          ) ||
          (!result.requestId && !Array.isArray(result.cancelledRequestIds))
        )
          throw new Error(
            "No request receipt was returned. Refresh account status before retrying; the same action key will be reused.",
          );
        completeLifecycleAction(sessionStorage, intent);
        state.deletionLifecycle = result;
        pending = false;
        modal.close();
        const area = document.querySelector("#deletion-area");
        if (area) area.innerHTML = deletionStatusMarkup(result);
        toast(
          result.message ||
            "Deletion request status updated. No automatic data erasure or billing change was performed.",
        );
      } catch (error) {
        errorArea.textContent = error.message;
      } finally {
        pending = false;
        controls.forEach((control) => {
          control.disabled = false;
        });
        restore();
      }
    });
}
async function handleAction(element) {
  const action = element.dataset.action;
  const id = element.dataset.id;
  if (
    [
      "read-notification",
      "more-notifications",
      "more-support",
      "more-operator-support",
    ].includes(action)
  ) {
    await handleEngagementAction(element);
    return;
  }
  if (action === "manual-draft") {
    await createManualDraft(element);
    return;
  }
  if (action === "close-dialog") {
    if (state.backupImport?.snapshot().pending && modal.querySelector("#backup-import-form")) return;
    modal.close();
    return;
  }
  if (action === "create-project") {
    openCreateProject();
    return;
  }
  if (action === "import-backup") {
    openImportBackup();
    return;
  }
  if (action === "request-deletion") {
    await confirmDeletion();
    return;
  }
  if (action === "cancel-deletion") {
    await confirmDeletion("cancel");
    return;
  }
  if (action === "choose-template") {
    if (!requireTemplateSelection({ templateId: id, templateMode: "exact" }))
      return;
    captureDraft();
    draft().templateId = id;
    if (draft().templateMode === "auto") draft().templateMode = "exact";
    document.querySelector(
      `input[name=templateMode][value="${draft().templateMode}"]`,
    ).checked = true;
    const galleryScroll = document.querySelector(".template-grid")?.scrollTop || 0;
    document.querySelector("#template-area").innerHTML = templatesMarkup();
    const gallery = document.querySelector(".template-grid");
    if (gallery) gallery.scrollTop = galleryScroll;
    updateTemplateFeedback();
    const selectedCard = [...document.querySelectorAll('[data-action="choose-template"]')]
      .find((card) => card.dataset.id === id);
    selectedCard?.focus({ preventScroll: true });
    queueBriefSave();
    announce(
      "Template selected. Use exactly mode preserves its device layout.",
    );
    return;
  }
  const restore = busy(
    element,
    action === "cancel-job" ? "Stopping…"
      : action === "export-backup" ? "Preparing editable backup…"
        : action === "export" ? "Preparing downloads…" : "Please wait…",
  );
  try {
    if (action === "enroll-staff-mfa") {
      if (!staffMfaAllowed(state.session, state.config))
        throw new Error(
          "Staff verification is not available for this account.",
        );
      try {
        const enrollment = await enrollStaffFactor(authClient().auth.mfa);
        if (
          !state.route.startsWith("/app/operator") ||
          !staffMfaAllowed(state.session, state.config)
        )
          return;
        state.staffMfa.enrollment = enrollment;
        document.querySelector("#staff-mfa-area").innerHTML = staffMfaMarkup(
          state.staffMfa.factors,
          state.staffMfa.enrollment,
        );
        document
          .querySelector("#staff-mfa-form")
          ?.addEventListener("submit", submitStaffMfa);
      } catch (error) {
        throw new Error(mfaErrorMessage(error));
      }
    }
    if (action === "copy-mfa-key") {
      if (
        !staffMfaAllowed(state.session, state.config) ||
        !state.staffMfa.enrollment?.secret
      )
        throw new Error("No active authenticator setup key is available.");
      await navigator.clipboard.writeText(state.staffMfa.enrollment.secret);
      toast(
        "Setup key copied. Add it only to your authenticator app and keep it private.",
      );
    }
    if (action === "retry-brief-save") {
      const saver = state.briefSaves.get(state.project.project.id);
      saver.halted = false;
      await saveBrief(state.project.project.id);
    }
    if (action === "reload-brief") {
      if (
        !window.confirm(
          "Reload the saved cloud brief? Unsynced brief and template changes in this tab will be replaced. Your rendered designs are not affected.",
        )
      )
        return;
      const projectId = state.project.project.id;
      const saver = state.briefSaves.get(projectId);
      clearTimeout(saver?.timer);
      if (saver?.saving) await saver.promise;
      state.drafts.delete(projectId);
      state.briefSaves.delete(projectId);
      await renderRoute();
    }
    if (action === "refresh") await renderRoute();
    if (action === "sign-out") {
      if (state.uploading)
        throw new Error(
          "Wait for screenshot uploads to finish before signing out.",
        );
      await Promise.all(
        [...state.briefSaves.entries()]
          .filter(([, saver]) => saver.dirty && !saver.halted)
          .map(([id]) => saveBrief(id)),
      );
      if (
        [...state.briefSaves.values()].some((saver) => saver.dirty) &&
        !window.confirm(
          "Some brief changes could not sync. Sign out and discard the unsynced changes in this tab?",
        )
      )
        return;
      for (const saver of state.briefSaves.values()) clearTimeout(saver.timer);
      await signOut();
      try { clearEmailReviewStorage(window.sessionStorage); }
      catch { toast("Signed out. This browser could not clear saved staff notes; close this tab to remove its session storage.", true); }
      state.session = null;
      state.backupImport = null;
      state.project = null;
      state.drafts.clear();
      state.briefSaves.clear();
      state.supportIntents.clear();
      state.supportDetail = null;
      state.supportList = null;
      state.inbox = null;
      state.emailOperations = null;
      state.emailPreferences = null;
      state.unreadCount = null;
      await navigate("/login");
    }
    if (action === "cancel-job" || action === "retry-job") {
      const result = await api(
        `/api/jobs/${encodeURIComponent(id)}/${action === "cancel-job" ? "cancel" : "retry"}`,
        { method: "POST", body: {} },
      );
      const index = state.project.jobs.findIndex((job) => job.id === id);
      if (result.job) {
        if (index >= 0) state.project.jobs[index] = result.job;
        else state.project.jobs.unshift(result.job);
      }
      updateJobSections();
      startPolling();
      toast(
        action === "cancel-job"
          ? "Cancellation requested. A running provider call may still finish."
          : "Retry requested from the saved checkpoint.",
      );
    }
    if (action === "apply-revision") {
      await api(
        `/api/projects/${encodeURIComponent(state.project.project.id)}/revisions/${encodeURIComponent(id)}/apply`,
        {
          method: "POST",
          body: {
            expectedRevisionId:
              state.project.project.activeRevisionId ||
              revisionId(state.project.revision),
          },
        },
      );
      state.project = await loadProject(state.project.project.id);
      updateJobSections();
      toast(
        "Revision applied. The previous revision remains in project history.",
      );
    }
    if (action === "export" || action === "export-backup") {
      const payload = action === "export-backup"
        ? { revisionId: id, format: "project" }
        : { revisionId: id };
      const result = await api(
        `/api/projects/${encodeURIComponent(state.project.project.id)}/export-jobs`,
        {
          method: "POST",
          body: { ...payload, idempotencyKey: operationKey(action, payload) },
        },
      );
      state.project.jobs.unshift(result.job);
      updateJobSections();
      startPolling();
      toast(action === "export-backup"
        ? "Preparing editable backup from this saved revision. No AI calls or AI credits."
        : "Preparing downloads from this saved revision.");
    }
    if (action === "checkout" || action === "billing-portal") {
      const result = await api(
        `/api/billing/${action === "checkout" ? "checkout" : "portal"}`,
        { method: "POST", body: action === "checkout" ? { planId: id } : {} },
      );
      const url = safeURL(result.url);
      if (!url || new URL(url, location.origin).protocol !== "https:")
        throw new Error(
          "The billing provider did not return a secure checkout link.",
        );
      location.assign(url);
    }
    if (action === "account-export") {
      element.textContent = "Receiving workspace ZIP…";
      const result = await api("/api/account/export", {
        responseType: "download",
        timeout: 300000,
      });
      const archive = await validateArchiveDownload(result);
      const url = URL.createObjectURL(archive.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = archive.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(
        "Complete workspace ZIP received. Check your browser’s downloads for " +
          archive.filename +
          ".",
      );
    }
    if (action === "account-recover") {
      try {
        await requestRecoveryEmail(
          authClient()?.auth,
          state.session.user.email,
          recoveryRedirect(location.origin, "/app/settings"),
        );
      } catch (error) {
        throw new Error(authErrorMessage(error, "recover"));
      }
      toast(
        "Recovery request accepted. Check your inbox and spam folder; open the newest email in this browser. Email delivery is not confirmed by this request.",
      );
    }
    if (action === "copy-mcp") {
      await navigator.clipboard.writeText(`${location.origin}/mcp`);
      toast("MCP endpoint copied.");
    }
    if (action === "revoke-connection") {
      const result = await api(`/api/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      toast(
        result.upstreamRevocationPending
          ? "AppScreen access is revoked. The sign-in provider still needs to confirm its revocation; retry from this connection’s row."
          : "Agent access revoked.",
        Boolean(result.upstreamRevocationPending),
      );
      await renderRoute();
    }
  } catch (error) {
    toast(
      error.code === "REVISION_CONFLICT"
        ? "A newer version was saved. Refresh the project and compare again; nothing was overwritten."
        : action === "export-backup"
          ? `${error.message} Try Prepare editable backup again.` : error.message,
      true,
    );
  } finally {
    restore();
  }
}
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (
    link &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  ) {
    event.preventDefault();
    navigate(link.getAttribute("href"));
    return;
  }
  const action = event.target.closest("[data-action]");
  if (action && !action.disabled) handleAction(action);
});
document.addEventListener("change", (event) => {
  const source = event.target.dataset.source;
  if (source) {
    if (event.target.checked && draft().sourceIds.length >= 10) {
      event.target.checked = false;
      toast("Choose up to 10 screenshots for one campaign.", true);
      return;
    }
    draft().sourceIds = event.target.checked
      ? [...new Set([...draft().sourceIds, source])]
      : draft().sourceIds.filter((id) => id !== source);
    queueBriefSave();
  }
});
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (
      image instanceof HTMLImageElement &&
      image.classList.contains("template-preview")
    ) {
      const id = image.closest('[data-action="choose-template"]')?.dataset.id;
      const index = state.templates.findIndex((template) => template.id === id);
      const template = state.templates[index];
      if (template)
        image.outerHTML = templateStudy(
          { ...template, previewUrl: null, thumbnailUrl: null },
          index,
        );
    }
  },
  true,
);
window.addEventListener("popstate", () => {
  captureDraft();
  renderRoute();
});
window.addEventListener("beforeunload", (event) => {
  if (
    state.uploading ||
    state.backupImport?.snapshot().pending ||
    [...state.briefSaves.values()].some((saver) => saver.dirty || saver.saving)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function init() {
  try {
    state.config = await api("/api/config", { authenticated: false });
    await configureSession(state.config);
    if (await getAccessToken()) {
      try {
        await refreshSession();
      } catch {}
    }
    await renderRoute();
  } catch (error) {
    root.innerHTML = publicPage(
      `<section class="prose"><h1>Your studio needs a connection.</h1><p class="inline-error" role="alert">${e(error.message)}</p><p>This page needs the AppScreen SaaS backend. The standalone local editor is still available.</p><div class="actions"><button class="button primary" data-action="reload">Retry connection</button><a href="/editor" class="button">Open local editor</a></div></section>`,
    );
    document.querySelector("[data-action=reload]").onclick = () =>
      location.reload();
  }
}
init();
