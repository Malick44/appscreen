import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { archiveFilename, validateArchiveDownload } from "../download.mjs";

test("workspace ZIP filename uses a safe server name and rejects unexpected extensions", () => {
  assert.equal(
    archiveFilename(
      'attachment; filename="appscreen-workspace-qa-2026-09-04.zip"',
    ),
    "appscreen-workspace-qa-2026-09-04.zip",
  );
  assert.equal(
    archiveFilename('attachment; filename="script.html"'),
    "appscreen-workspace.zip",
  );
  assert.equal(
    archiveFilename('attachment; filename="../../private.zip"'),
    "appscreen-workspace.zip",
  );
});
test("workspace download reports success only for a complete ZIP stream", async () => {
  const zip = new JSZip();
  zip.file("manifest.json", '{"test":true}');
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const complete = {
    blob: new Blob([bytes]),
    contentType: "application/zip",
    contentLength: String(bytes.length),
    contentDisposition: 'attachment; filename="qa.zip"',
  };
  assert.equal((await validateArchiveDownload(complete)).filename, "qa.zip");
  await assert.rejects(
    validateArchiveDownload({
      ...complete,
      blob: new Blob([bytes.slice(0, -10)]),
      contentLength: null,
    }),
    /incomplete/,
  );
  await assert.rejects(
    validateArchiveDownload({
      ...complete,
      contentLength: String(bytes.length + 1),
    }),
    /interrupted/,
  );
  await assert.rejects(
    validateArchiveDownload({ ...complete, contentType: "application/json" }),
    /complete workspace ZIP/,
  );
});
