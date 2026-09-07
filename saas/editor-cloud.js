import { api } from "./api.js";
import { configureSession, getAccessToken } from "./session.js";
import { escapeHTML as e, safeURL } from "./utils.mjs";

// This adapter never runs inside the standalone/file editor or the render worker.
const params = new URLSearchParams(location.search);
let bar,
  overlay,
  bridge,
  projectId,
  currentRevisionId,
  activeRevisionAtLoad,
  appliedMode = false;
let dirty = false,
  saving = false,
  changedDuringSave = false,
  halted = false,
  loaded = false,
  saveTimer,
  projectName;
let preparingBackup = false,
  pendingBackup = null,
  localBackupAttributes = null,
  localImportAttributes = null,
  lastSavedFingerprint;

const hostedAISelectors =
  "#magical-titles-btn,.magic-generate-btn,.magic-translate-btn,.ai-generate-btn,#translate-all-btn,#ai-translate-btn,#ai-text-generate,#ai-image-gen-confirm,#magical-titles-confirm";
const saveRequestKeys = new Map();
function saveRequestKey(payload) {
  const key = JSON.stringify(payload);
  if (!saveRequestKeys.has(key)) saveRequestKeys.set(key, crypto.randomUUID());
  return saveRequestKeys.get(key);
}
function setHostedAIControls(enabled) {
  document.body.classList.toggle("cloud-hosted-mode", enabled);
  setCloudBackupControl(enabled);
  setCloudImportControl(enabled);
  document
    .querySelector(".settings-provider-selector")
    ?.closest(".settings-section")
    ?.classList.add("cloud-provider-config");
  document
    .querySelectorAll(".settings-api-section")
    .forEach((section) => section.classList.add("cloud-provider-config"));
  let link = bar.querySelector(".cloud-ai-link");
  if (enabled && !link) {
    link = document.createElement("a");
    link.className = "cloud-ai-link";
    link.textContent = "Design with AI";
    link.href = `/app/projects/${encodeURIComponent(projectId)}#revision-area`;
    link.title = "Use the cloud campaign agent. No provider API key is needed.";
    bar.querySelector("a").after(link);
  }
  if (link) link.hidden = !enabled;
}
document.addEventListener(
  "click",
  (event) => {
    if (
      document.body.classList.contains("cloud-hosted-mode") &&
      event.target.closest("#import-project-btn")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (guardBackupNavigation(event, "opening backup import"))
        location.assign("/app#import-backup");
      return;
    }
    if (
      document.body.classList.contains("cloud-hosted-mode") &&
      event.target.closest("#export-project-btn")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void prepareCloudBackup();
      return;
    }
    if (
      document.body.classList.contains("cloud-hosted-mode") &&
      event.target.closest(hostedAISelectors)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setStatus(
        "Use Design with AI in your campaign workspace. No provider key is needed.",
      );
    }
  },
  true,
);
if (location.pathname === "/editor" && !params.has("render"))
  initializeCloudEditor().catch((error) => showLoadError(error));

function setStatus(message, error = false) {
  const status = bar?.querySelector(".cloud-status");
  if (status) {
    status.textContent = message;
    status.dataset.status = error ? "error" : "normal";
  }
}
function setCloudBackupControl(enabled) {
  const button = document.getElementById("export-project-btn");
  if (!button) return;
  if (enabled) {
    localBackupAttributes ||= Object.fromEntries(
      ["title", "aria-label", "aria-busy", "disabled"].map((name) => [
        name,
        button.getAttribute(name),
      ]),
    );
    const label = preparingBackup
      ? "Preparing editable backup…"
      : pendingBackup
        ? "Retry editable backup (same saved snapshot)"
        : "Prepare editable backup";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = preparingBackup;
    if (preparingBackup) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  } else {
    if (localBackupAttributes)
      for (const [name, value] of Object.entries(localBackupAttributes)) {
        if (value === null) button.removeAttribute(name);
        else button.setAttribute(name, value);
      }
    localBackupAttributes = null;
    pendingBackup = null;
    bar?.querySelector(".cloud-backup-link")?.remove();
  }
}
function backupFingerprint(document) {
  // Revision acknowledgements are not design edits. All design fields still count.
  return JSON.stringify({ ...document, revision: 0 });
}
function setCloudImportControl(enabled) {
  const button = document.getElementById("import-project-btn");
  if (!button) return;
  if (enabled) {
    localImportAttributes ||= Object.fromEntries(
      ["title", "aria-label"].map(name => [name, button.getAttribute(name)]),
    );
    button.title = "Import editable backup as a new campaign";
    button.setAttribute("aria-label", button.title);
  } else if (localImportAttributes) {
    for (const [name, value] of Object.entries(localImportAttributes)) {
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
    localImportAttributes = null;
  }
}
function backupMatchesEditor(intent) {
  try {
    return (
      backupFingerprint(bridge.exportDocument({ name: projectName })) ===
      intent.fingerprint
    );
  } catch {
    // Newly added, not-yet-uploaded images also mean this is an earlier snapshot.
    return false;
  }
}
function guardBackupNavigation(event, destination = "opening backup progress") {
  // Stay in this tab so local-development sessions work too. Do not leave on
  // an immediate edit that has not reached the debounced dirty flag yet.
  if (
    !loaded || saving || dirty || halted ||
    !backupMatchesEditor({ fingerprint: lastSavedFingerprint })
  ) {
    event.preventDefault();
    setStatus(`Save your latest changes before ${destination}. Your editor is still open.`, true);
    return false;
  }
  return true;
}
async function prepareCloudBackup() {
  if (!loaded || preparingBackup) return;
  const targetProjectId = projectId;
  const isCurrentProject = () =>
    loaded && bridge.currentDocument?.id === targetProjectId;
  if (!isCurrentProject()) return;
  preparingBackup = true;
  setCloudBackupControl(true);
  try {
    if (!pendingBackup) {
      if (saving)
        throw new Error("Wait for the current save, then prepare the backup again.");
      if (halted)
        throw new Error("Resolve the cloud save first, then prepare the backup again.");
      // Force a snapshot even if the editor's debounced change event has not fired.
      const saved = await saveCloud(true);
      if (!isCurrentProject()) return;
      // saveCloud already explains conflicts/upload failures and exposes recovery.
      if (!saved || halted) return;
      if (dirty || !backupMatchesEditor(saved))
        throw new Error("Finish saving your latest changes, then prepare the backup again.");
      pendingBackup = {
        ...saved,
        projectId: targetProjectId,
        idempotencyKey: saveRequestKey({
          operation: "export-backup",
          projectId: targetProjectId,
          revisionId: saved.revisionId,
          format: "project",
        }),
      };
    }
    // Keep this immutable intent on uncertain failure: retry must not create a
    // new revision/job or quietly include edits made after the first attempt.
    const intent = pendingBackup;
    setStatus("Preparing editable backup of the saved design and original screenshots…");
    await api(`/api/projects/${encodeURIComponent(targetProjectId)}/export-jobs`, {
      method: "POST",
      body: {
        revisionId: intent.revisionId,
        format: "project",
        idempotencyKey: intent.idempotencyKey,
      },
    });
    if (!isCurrentProject()) return;
    pendingBackup = null;
    let link = bar.querySelector(".cloud-backup-link");
    if (!link) {
      link = document.createElement("a");
      link.className = "cloud-backup-link";
      bar.append(link);
    }
    link.href = `/app/projects/${encodeURIComponent(targetProjectId)}#revision-area`;
    link.textContent = "View backup progress →";
    link.title = "Open your campaign to download the backup once it is ready.";
    link.onclick = guardBackupNavigation;
    setStatus(
      backupMatchesEditor(intent)
        ? "Editable backup requested. Open backup progress to download it. No AI credits used."
        : "Backup requested for the earlier saved snapshot. Later edits remain here. No AI credits used.",
    );
  } catch (error) {
    if (isCurrentProject())
      setStatus(
        pendingBackup
          ? `${error.message} Retry editable backup to check the same saved snapshot; later edits are not included.`
          : error.message,
        true,
      );
  } finally {
    preparingBackup = false;
    if (isCurrentProject()) setCloudBackupControl(true);
  }
}
function showLoadError(error) {
  setStatus("Cloud connection needs attention", true);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "cloud-workspace-overlay";
    document.body.append(overlay);
  }
  overlay.innerHTML = `<div><h1>We couldn’t open the cloud design.</h1><p role="alert">${e(error.message)}</p><p>Your saved local projects have not been removed.</p><button id="cloud-reload">Try again</button><p><a href="/app">Back to campaigns</a> · <a href="/editor">Open the local editor</a></p></div>`;
  overlay.querySelector("#cloud-reload").onclick = () => location.reload();
}
async function awaitBridge() {
  if (window.AppScreenCloudBridge?.ready) return window.AppScreenCloudBridge;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("app-screen-bridge-ready", ready);
      reject(
        new Error("The editor did not finish loading. Refresh to try again."),
      );
    }, 45000);
    function ready() {
      clearTimeout(timeout);
      resolve(window.AppScreenCloudBridge);
    }
    window.addEventListener("app-screen-bridge-ready", ready, { once: true });
  });
}
async function initializeCloudEditor() {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/saas/editor-cloud.css";
  document.head.append(style);
  bar = document.createElement("div");
  bar.className = "cloud-workspace-bar";
  bar.setAttribute("aria-label", "Cloud project controls");
  bar.innerHTML =
    '<a href="/app">← Campaigns</a><strong>AppScreen cloud</strong><span class="cloud-status" role="status" aria-live="polite">Connecting…</span><button id="cloud-retry" hidden>Retry save</button><button id="cloud-save" hidden>Save now</button><button class="cloud-primary" id="cloud-apply" hidden>Apply draft</button><button class="cloud-primary" id="cloud-migrate" hidden>Copy local project to cloud</button>';
  document.body.prepend(bar);
  document.body.classList.add("cloud-workspace-active");
  projectId = params.get("project");
  if (projectId) {
    overlay = document.createElement("div");
    overlay.className = "cloud-workspace-overlay";
    overlay.innerHTML =
      "<div><h1>Opening your cloud design…</h1><p>Loading the saved revision and its original screenshots.</p></div>";
    document.body.append(overlay);
  }
  let config;
  try {
    config = await api("/api/config", { authenticated: false });
    await configureSession(config);
  } catch (error) {
    if (projectId) throw error;
    setStatus("Local editor · cloud is not connected");
    return;
  }
  if (!(await getAccessToken())) {
    setStatus("Local editor · sign in to use cloud projects");
    if (projectId)
      location.replace(
        `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`,
      );
    else {
      const link = document.createElement("a");
      link.href = `/login?returnTo=${encodeURIComponent("/editor")}`;
      link.textContent = "Sign in";
      bar.append(link);
    }
    return;
  }
  bridge = await awaitBridge();
  if (!projectId) {
    setStatus("Saved on this device · copying preserves the local original");
    const migrate = bar.querySelector("#cloud-migrate");
    migrate.hidden = false;
    migrate.onclick = migrateLocalProject;
    return;
  }
  const detail = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  projectName = detail.project.name;
  activeRevisionAtLoad = detail.project.activeRevisionId || null;
  const requestedId = params.get("revision") || activeRevisionAtLoad;
  if (!requestedId)
    throw new Error(
      "This campaign has no editable revision yet. Create a template draft from the campaign workspace first.",
    );
  const revision =
    detail.revision?.id === requestedId
      ? detail.revision
      : (
          await api(
            `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(requestedId)}`,
          )
        ).revision;
  currentRevisionId = revision.id;
  appliedMode = currentRevisionId === activeRevisionAtLoad;
  const assets = new Map(detail.assets.map((asset) => [asset.id, asset]));
  await bridge.importDocument(revision.document, {
    resolveAsset: async (id) => {
      const asset = assets.get(id);
      const url = safeURL(asset?.url || asset?.signedUrl);
      if (!url)
        throw new Error(
          "A source image could not be loaded. Refresh the campaign to get a new download link.",
        );
      return url;
    },
  });
  loaded = true;
  lastSavedFingerprint = backupFingerprint(bridge.exportDocument({ name: projectName }));
  setHostedAIControls(true);
  overlay.remove();
  overlay = null;
  bar.querySelector("strong").textContent = projectName;
  bar.querySelector("a").href =
    `/app/projects/${encodeURIComponent(projectId)}`;
  setStatus(
    appliedMode
      ? "Saved to cloud"
      : "Saved draft · current project version unchanged",
  );
  bar.querySelector("#cloud-save").hidden = false;
  bar.querySelector("#cloud-save").onclick = () => saveCloud(true);
  bar.querySelector("#cloud-retry").onclick = () => {
    halted = false;
    saveCloud(true);
  };
  bar.querySelector("#cloud-apply").hidden = appliedMode;
  bar.querySelector("#cloud-apply").onclick = applyDraft;
  window.addEventListener("app-screen-document-change", onDocumentChange);
  window.addEventListener("app-screen-document-detached", () => {
    loaded = false;
    halted = true;
    dirty = false;
    clearTimeout(saveTimer);
    setStatus("Local project selected · cloud sync is paused");
    setHostedAIControls(false);
    for (const id of ["#cloud-save", "#cloud-retry", "#cloud-apply"])
      bar.querySelector(id).hidden = true;
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty || saving) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
function onDocumentChange() {
  if (!loaded) return;
  dirty = true;
  if (saving) changedDuringSave = true;
  setStatus(
    halted
      ? "Changes remain on this device · cloud save paused"
      : "Unsaved cloud changes",
  );
  clearTimeout(saveTimer);
  if (!halted) saveTimer = setTimeout(() => saveCloud(), 1100);
}
async function uploadUnregisteredAssets(targetProjectId) {
  const uploaded = new Map();
  for (const reference of bridge.getAssetReferences()) {
    if (reference.assetId || uploaded.has(reference.src)) continue;
    if (!/^(data:image\/(png|jpeg);|blob:)/.test(reference.src))
      throw new Error(
        "A linked image cannot be copied automatically. Download it and upload a PNG or JPEG through the editor first.",
      );
    const response = await fetch(reference.src);
    if (!response.ok)
      throw new Error("A local image could not be read. Upload it again.");
    const blob = await response.blob();
    const body = new FormData();
    body.append("file", blob, reference.name || "screenshot.png");
    const { asset } = await api(
      `/api/projects/${encodeURIComponent(targetProjectId)}/assets`,
      { method: "POST", body, timeout: 120000 },
    );
    uploaded.set(reference.src, asset.id);
    bridge.registerAssets({ [reference.src]: asset.id });
  }
}
async function saveCloud(force = false) {
  if (!loaded || halted || (!dirty && !force)) return;
  if (saving) {
    changedDuringSave = true;
    return;
  }
  const targetProjectId = projectId;
  const isCurrentProject = () =>
    loaded && bridge.currentDocument?.id === targetProjectId;
  clearTimeout(saveTimer);
  saving = true;
  changedDuringSave = false;
  setStatus("Saving to cloud…");
  const saveButton = bar.querySelector("#cloud-save");
  saveButton.disabled = true;
  try {
    await uploadUnregisteredAssets(targetProjectId);
    if (!isCurrentProject()) return;
    const document = bridge.exportDocument({ name: projectName });
    const { revision, project } = await api(
      `/api/projects/${encodeURIComponent(targetProjectId)}/revisions`,
      {
        method: "POST",
        body: {
          document,
          expectedRevisionId: currentRevisionId,
          apply: appliedMode,
          idempotencyKey: saveRequestKey({
            document,
            expectedRevisionId: currentRevisionId,
            apply: appliedMode,
          }),
        },
      },
    );
    if (!isCurrentProject()) return;
    currentRevisionId = revision.id;
    if (appliedMode) activeRevisionAtLoad = project.activeRevisionId;
    bridge.acknowledgeSave(revision.document);
    dirty = changedDuringSave;
    const url = new URL(location.href);
    url.searchParams.set("revision", currentRevisionId);
    history.replaceState({}, "", url);
    bar.querySelector("#cloud-retry").hidden = true;
    setStatus(
      dirty
        ? "Saving the latest changes…"
        : appliedMode
          ? "Saved to cloud"
          : "Saved draft · current project version unchanged",
    );
    lastSavedFingerprint = backupFingerprint(document);
    return { revisionId: revision.id, fingerprint: lastSavedFingerprint };
  } catch (error) {
    if (!isCurrentProject()) return;
    dirty = true;
    halted = true;
    setStatus(
      error.code === "REVISION_CONFLICT"
        ? "Cloud conflict · your local edits are safe. Reopen the campaign to compare."
        : `${error.message} Changes are still on this device.`,
      true,
    );
    bar.querySelector("#cloud-retry").hidden = false;
  } finally {
    saving = false;
    saveButton.disabled = false;
    if (isCurrentProject() && dirty && !halted)
      saveTimer = setTimeout(() => saveCloud(), 700);
  }
}
async function applyDraft() {
  const apply = bar.querySelector("#cloud-apply");
  apply.disabled = true;
  try {
    if (saving)
      throw new Error(
        "Wait for the current save to finish, then apply the draft.",
      );
    if (dirty) await saveCloud();
    if (dirty || halted)
      throw new Error("Save the pending changes before applying this draft.");
    await api(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(currentRevisionId)}/apply`,
      { method: "POST", body: { expectedRevisionId: activeRevisionAtLoad } },
    );
    activeRevisionAtLoad = currentRevisionId;
    appliedMode = true;
    apply.hidden = true;
    setStatus("Draft applied · saved to cloud");
  } catch (error) {
    setStatus(
      error.code === "REVISION_CONFLICT"
        ? "A newer project version exists. Return to the campaign to compare before applying."
        : error.message,
      true,
    );
  } finally {
    apply.disabled = false;
  }
}
async function migrateLocalProject() {
  const migrate = bar.querySelector("#cloud-migrate");
  if (!bridge.getAssetReferences().length) {
    setStatus("Add at least one screenshot before copying this project.", true);
    return;
  }
  const name = window.prompt(
    "Name this cloud copy. Your local original will be kept.",
    "My campaign",
  );
  if (!name?.trim()) return;
  if (
    !window.confirm(
      "Copy this local project and its images into your private cloud workspace? Your original stays on this device. No AI job will run.",
    )
  )
    return;
  migrate.disabled = true;
  setStatus("Copying screenshots to cloud…");
  try {
    const { project } = await api("/api/projects", {
      method: "POST",
      body: { name: name.trim().slice(0, 120) },
    });
    await uploadUnregisteredAssets(project.id);
    const document = bridge.exportDocument({ name: project.name });
    document.id = project.id;
    const { revision } = await api(
      `/api/projects/${encodeURIComponent(project.id)}/revisions`,
      {
        method: "POST",
        body: { document, expectedRevisionId: null, apply: true },
      },
    );
    setStatus("Cloud copy saved. Opening it now…");
    location.assign(
      `/editor?project=${encodeURIComponent(project.id)}&revision=${encodeURIComponent(revision.id)}`,
    );
  } catch (error) {
    setStatus(`${error.message} Your local original is unchanged.`, true);
    migrate.disabled = false;
  }
}
