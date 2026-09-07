export function archiveFilename(disposition = "") {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain =
    disposition.match(/filename="([^"]+)"/i)?.[1] ||
    disposition.match(/filename=([^;]+)/i)?.[1];
  let value = plain || "appscreen-workspace.zip";
  if (encoded) {
    try {
      value = decodeURIComponent(encoded);
    } catch {}
  }
  const name = value
    .trim()
    .replace(/[\\/\x00-\x1f\x7f]/g, "_")
    .replace(/[^a-z0-9._ -]/gi, "_")
    .slice(0, 180);
  return name.toLowerCase().endsWith(".zip") && !name.startsWith(".")
    ? name
    : "appscreen-workspace.zip";
}

export async function validateArchiveDownload(download) {
  const { blob, contentType, contentLength, contentEncoding } = download;
  if (
    !blob ||
    !/^application\/zip(?:;|$)/i.test(contentType || "") ||
    blob.size < 22
  )
    throw new Error(
      "The server did not return a complete workspace ZIP. No archive was saved.",
    );
  if (!contentEncoding && contentLength && Number(contentLength) !== blob.size)
    throw new Error(
      "The workspace download was interrupted. No complete archive was received; try again.",
    );
  const header = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(
    0,
    true,
  );
  if (![0x04034b50, 0x06054b50].includes(header))
    throw new Error("The download is not a ZIP archive. No file was saved.");
  // Verify the end-of-directory record so an abruptly completed stream is not reported as a finished archive.
  const tail = new DataView(await blob.slice(-65557).arrayBuffer());
  let complete = false;
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (
      tail.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + tail.getUint16(offset + 20, true) === tail.byteLength
    ) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new Error(
      "The workspace ZIP is incomplete. No archive was saved; try the download again.",
    );
  return { blob, filename: archiveFilename(download.contentDisposition) };
}
