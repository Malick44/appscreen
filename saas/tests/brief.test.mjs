import test from "node:test";
import assert from "node:assert/strict";
import { defaultDraft, briefPayload } from "../brief.mjs";

const data = () => ({
  project: { name: "Test campaign", brief: {}, designPreferences: {} },
  assets: [
    { id: "source-1", kind: "source" },
    { id: "preview-1", kind: "preview" },
  ],
});

test("brief starts from original sources and never assumes AI sharing consent", () => {
  const draft = defaultDraft(data());
  assert.equal(draft.appName, "Test campaign");
  assert.deepEqual(draft.sourceIds, ["source-1"]);
  assert.equal(draft.consent, false);
});
test("cloud brief honors explicitly cleared names, template choices, sources and locks", () => {
  const input = data();
  input.project.brief = { appName: "", promise: "" };
  input.project.designPreferences = {
    templateMode: "auto",
    templateId: null,
    sourceIds: [],
    locks: {},
    screenCount: 6,
  };
  input.revision = {
    document: {
      template: { id: "older-template", mode: "exact" },
      locks: { positions: true },
    },
  };
  const draft = defaultDraft(input);
  assert.equal(draft.appName, "");
  assert.equal(draft.templateId, "");
  assert.equal(draft.templateMode, "auto");
  assert.equal(draft.screenCount, 6);
  assert.deepEqual(draft.sourceIds, []);
  assert.deepEqual(draft.locks, []);
});
test("brief sync uses API fields without persisting per-run provider consent", () => {
  const draft = {
    ...defaultDraft(data()),
    facts: " One fact \n\n Another fact ",
    locks: ["positions", "sources"],
    consent: true,
    templateMode: "inspiration",
    templateId: "tidal",
  };
  const payload = briefPayload(draft);
  assert.deepEqual(payload.brief.confirmedFacts, ["One fact", "Another fact"]);
  assert.deepEqual(payload.designPreferences.locks, {
    positions: true,
    sources: true,
  });
  assert.equal(payload.designPreferences.templateMode, "inspiration");
  assert.deepEqual(payload.designPreferences.profile, {
    id: "iphone-6.9",
    width: 1320,
    height: 2868,
  });
  assert.equal(JSON.stringify(payload).includes("consent"), false);
});
