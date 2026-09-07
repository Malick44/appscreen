import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTemplateSelection,
  templateCompatibilityLabel,
} from "../template-selection.mjs";
import { defaultDraft, briefPayload } from "../brief.mjs";

const catalog = [
  { id: "supported", name: "Tidal", cloudCompatible: true },
  {
    id: "local-3d",
    name: "Floating phone",
    cloudCompatible: false,
    cloudLimitations: [
      { code: "DEVICE_3D", message: "3D device mockups need the local editor." },
    ],
  },
  {
    id: "local-photo",
    name: "Photo stack",
    cloudCompatible: false,
    cloudLimitations: [
      { code: "LAYERED_PHOTO", message: "Layered photo compositions need the local editor." },
    ],
  },
  { id: "unknown-metadata", name: "Earlier layout" },
];
const selection = (templateId, templateMode = "exact") => ({ templateId, templateMode });

test("both explicit modes require affirmative cloud compatibility", () => {
  for (const mode of ["exact", "inspiration"]) {
    const supported = assessTemplateSelection(selection("supported", mode), catalog);
    assert.equal(supported.allowed, true);
    assert.equal(supported.templateId, "supported");
    assert.match(supported.message, /Tidal selected/);
    for (const id of ["local-3d", "local-photo", "unknown-metadata", "removed", ""]) {
      const result = assessTemplateSelection(selection(id, mode), catalog);
      assert.equal(result.allowed, false, `${mode}/${id} must not start`);
      assert.equal(result.templateId, undefined);
      assert.match(result.message, /Choose a supported template/);
      assert.match(result.message, /Choose for me/);
    }
  }
  for (const flag of [undefined, null, "true", 1]) {
    assert.equal(assessTemplateSelection(selection("supported"), [
      { id: "supported", cloudCompatible: flag },
    ]).allowed, false);
  }
});

test("local-only explanations distinguish 3D devices from layered photos", () => {
  const device = assessTemplateSelection(selection("local-3d"), catalog);
  assert.equal(device.code, "LOCAL_ONLY");
  assert.match(device.message, /Floating phone/);
  assert.match(device.message, /3D device mockups/);
  assert.doesNotMatch(device.message, /Layered photo/);
  assert.equal(templateCompatibilityLabel(catalog[1]), "Local editor only · 3D devices");
  const photo = assessTemplateSelection(selection("local-photo"), catalog);
  assert.match(photo.message, /Photo stack/);
  assert.match(photo.message, /Layered photo compositions/);
  assert.doesNotMatch(photo.message, /3D/);
  assert.equal(templateCompatibilityLabel(catalog[2]), "Local editor only · Layered photos");
});

test("unknown saved templates and missing metadata have actionable, distinct explanations", () => {
  const unknown = assessTemplateSelection(selection("removed"), catalog);
  assert.equal(unknown.code, "UNKNOWN_TEMPLATE");
  assert.match(unknown.message, /saved template “removed” is unavailable/);
  assert.match(unknown.message, /Refresh the catalog/);
  const noMetadata = assessTemplateSelection(selection("unknown-metadata"), catalog);
  assert.equal(noMetadata.code, "COMPATIBILITY_UNAVAILABLE");
  assert.match(noMetadata.message, /Compatibility information for “Earlier layout” is unavailable/);
  assert.equal(templateCompatibilityLabel(catalog[3]), "Compatibility information unavailable");
  assert.equal(assessTemplateSelection(selection("supported"), null).allowed, false);
  assert.equal(assessTemplateSelection(selection("supported"), []).allowed, false);
});

test("auto mode returns no effective template ID while retaining the saved choice", () => {
  for (const id of ["supported", "local-3d", "local-photo", "unknown-metadata", "removed", ""]) {
    const values = Object.freeze(selection(id, "auto"));
    const result = assessTemplateSelection(values, catalog);
    assert.equal(result.allowed, true);
    assert.equal(result.templateId, null);
    assert.equal(values.templateId, id);
    assert.match(result.message, /AppScreen will choose a supported template/);
    if (id) assert.match(result.message, /saved choice.*retained/);
  }
  assert.equal(assessTemplateSelection(selection("removed", "auto"), []).allowed, true);
});

test("restored incompatible choice remains saved and visible until explicitly changed", () => {
  const values = defaultDraft({
    project: {
      name: "Saved campaign",
      designPreferences: { templateId: "local-3d", templateMode: "inspiration" },
    },
    assets: [],
  });
  assert.equal(assessTemplateSelection(values, catalog).allowed, false);
  assert.equal(values.templateId, "local-3d");
  assert.equal(briefPayload(values).designPreferences.templateId, "local-3d");
  values.templateMode = "auto";
  assert.equal(assessTemplateSelection(values, catalog).templateId, null);
  assert.equal(briefPayload(values).designPreferences.templateId, "local-3d");
});

test("invalid modes and malformed limitation data fail safely without losing guidance", () => {
  assert.equal(assessTemplateSelection(selection("supported", "unexpected"), catalog).code, "INVALID_MODE");
  const result = assessTemplateSelection(selection("local"), [{
    id: "local",
    cloudCompatible: false,
    cloudLimitations: [null, {}, { message: 12 }, { message: "" }, { message: "Public reason." }, { message: "Public reason." }],
  }]);
  assert.equal(result.allowed, false);
  assert.equal(result.message.match(/Public reason\./g).length, 1);
  assert.match(result.message, /local editor/);
});
