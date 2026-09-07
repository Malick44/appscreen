import { randomUUID } from 'node:crypto';
import { inflateRaw } from 'node:zlib';
import sharp from 'sharp';
import { z } from 'zod';
import { hash, requireScope, type Context } from './auth.js';
import { row, transaction } from './db.js';
import { AppError, invariant } from './errors.js';
import { collectCampaignAssetIds } from './render-service.js';
import type { AppServices } from './services.js';
import type { Config } from './config.js';

export const PROJECT_IMPORT_LIMITS = Object.freeze({ compressedBytes: 100 * 1024 * 1024, expandedBytes: 200 * 1024 * 1024, documentBytes: 2 * 1024 * 1024, entries: 101, compressionRatio: 200 });
const archiveError = (message = 'This is not a supported editable AppScreen backup.') => new AppError('INVALID_PROJECT_BACKUP', message, 400);
function check(condition: unknown, message?: string): asserts condition { if (!condition) throw archiveError(message); }
const assetPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nameSchema = z.string().trim().min(1).max(120);
const localePattern = /^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/;
const plain = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer) { let result = 0xffffffff; for (const byte of bytes) result = crcTable[(result ^ byte) & 255] ^ (result >>> 8); return (result ^ 0xffffffff) >>> 0; }
type Entry = { name: string; crc: number; compressedSize: number; size: number; method: number; offset: number; dataOffset: number; end: number };

/** Inspect every central AND local header before any entry is inflated. This
 * deliberately accepts only the bounded, single-disk ZIP subset we export.
 * No extraction to disk, path normalization, encrypted/ZIP64 entries, symlinks,
 * descriptors, prepended executables or unindexed/trailing data are accepted. */
export function inspectProjectZip(bytes: Buffer, uploadLimit: number): Entry[] {
  invariant(bytes.length <= PROJECT_IMPORT_LIMITS.compressedBytes, 'IMPORT_SIZE', 'Editable backups must be 100 MB or smaller.', 413);
  check(bytes.length >= 22);
  const eocd = bytes.length - 22;
  check(bytes.readUInt32LE(eocd) === 0x06054b50 && bytes.readUInt16LE(eocd + 20) === 0);
  const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16);
  check(bytes.readUInt16LE(eocd + 4) === 0 && bytes.readUInt16LE(eocd + 6) === 0 && bytes.readUInt16LE(eocd + 8) === count);
  check(count > 1 && count <= PROJECT_IMPORT_LIMITS.entries, 'This backup contains too many files or is missing its screenshots.');
  check(centralOffset + centralSize === eocd && centralOffset !== 0xffffffff);
  const entries: Entry[] = [], names = new Set<string>(); let cursor = centralOffset, total = 0;
  for (let index = 0; index < count; index++) {
    check(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    check(next <= eocd && nameLength > 0 && nameLength <= 80 && extraLength === 0 && commentLength === 0 && bytes.readUInt16LE(cursor + 34) === 0);
    check(bytes.readUInt16LE(cursor + 6) <= 20 && (flags & ~0x800) === 0 && [0, 8].includes(method), 'Encrypted or unsupported ZIP entries are not accepted.');
    const attributes = bytes.readUInt32LE(cursor + 38), fileType = (attributes >>> 16) & 0xf000;
    check((fileType === 0 || fileType === 0x8000) && !(attributes & 0x10), 'Only ordinary backup files are accepted.');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = rawName.toString('utf8');
    check(Buffer.from(name, 'utf8').equals(rawName) && (name === 'project.json' || /^assets\/[0-9a-f-]{36}\.(png|jpg)$/i.test(name)) && !names.has(name.toLowerCase()), 'The backup contains an unsafe, duplicate, or unexpected file name.');
    names.add(name.toLowerCase());
    check(size > 0 && compressedSize > 0 && size !== 0xffffffff && compressedSize !== 0xffffffff && offset !== 0xffffffff);
    const maximum = name === 'project.json' ? PROJECT_IMPORT_LIMITS.documentBytes : uploadLimit;
    invariant(size <= maximum && size / compressedSize <= PROJECT_IMPORT_LIMITS.compressionRatio, 'IMPORT_SIZE', 'A file in this backup exceeds the safe import limits.', 413);
    total += size; invariant(total <= PROJECT_IMPORT_LIMITS.expandedBytes, 'IMPORT_SIZE', 'This backup expands beyond the 200 MB import limit.', 413);
    check(offset + 30 <= centralOffset && bytes.readUInt32LE(offset) === 0x04034b50);
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28), dataOffset = offset + 30 + localNameLength + localExtraLength, end = dataOffset + compressedSize;
    check(end <= centralOffset && localNameLength === nameLength && localExtraLength === 0 && bytes.subarray(offset + 30, dataOffset).equals(rawName));
    check(bytes.readUInt16LE(offset + 4) <= 20 && bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === method && bytes.readUInt32LE(offset + 14) === crc && bytes.readUInt32LE(offset + 18) === compressedSize && bytes.readUInt32LE(offset + 22) === size, 'The ZIP headers do not agree.');
    check(method !== 0 || compressedSize === size);
    entries.push({ name, crc, compressedSize, size, method, offset, dataOffset, end }); cursor = next;
  }
  check(cursor === eocd && names.has('project.json'));
  let end = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) { check(entry.offset === end, 'The ZIP contains overlapping or unindexed files.'); end = entry.end; }
  check(end === centralOffset);
  return entries;
}

async function inflateEntry(archive: Buffer, entry: Entry): Promise<Buffer> {
  const input = archive.subarray(entry.dataOffset, entry.end);
  const output = entry.method === 0 ? input : await new Promise<Buffer>((resolve, reject) => {
    inflateRaw(input, { maxOutputLength: entry.size, info: true }, (error, result: any) => {
      if (error || !result?.buffer || result.engine.bytesWritten !== input.length) reject(archiveError('A compressed backup file is damaged or exceeds its declared size.'));
      else resolve(result.buffer);
    });
  });
  check(output.length === entry.size && crc32(output) === entry.crc, 'A backup file is incomplete or its checksum does not match.');
  return output;
}

type ImportedAsset = { originalId: string; name: string; bytes: Buffer; width: number; height: number; mimeType: string; extension: string; checksum: string };
export async function parseProjectBackup(bytes: Buffer, config: Pick<Config, 'uploadLimit' | 'maxPixels'>) {
  const entries = inspectProjectZip(bytes, config.uploadLimit);
  const raw = await inflateEntry(bytes, entries.find(entry => entry.name === 'project.json')!);
  let manifest: any;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw archiveError('The backup document is not valid JSON.'); }
  check(manifest?.format === 'appscreen-campaign' && manifest.version === 1, 'Choose an editable AppScreen campaign backup (version 1), not a PNG download ZIP or account export.');
  check(Array.isArray(manifest.assets) && manifest.assets.length > 0 && manifest.assets.length < PROJECT_IMPORT_LIMITS.entries);
  const document = manifest.document;
  const { validateCampaign } = await import('../core/campaign.mjs');
  let validation; try { validation = validateCampaign(document); } catch { throw archiveError('The campaign document is malformed.'); }
  invariant(validation.valid, 'INVALID_CAMPAIGN', 'The backup contains an invalid campaign document.', 400, validation.issues);
  check(document.scenes.length > 0 && document.scenes.length <= 10 && document.sources.length > 0, 'Cloud campaigns must contain between one and ten screens and at least one screenshot.');
  check(typeof document.locale === 'string' && localePattern.test(document.locale) && Array.isArray(document.locales) && document.locales.length > 0 && document.locales.length <= 100 && document.locales.includes(document.locale) && document.locales.every((locale: unknown) => typeof locale === 'string' && localePattern.test(locale)), 'The backup has invalid campaign languages.');
  check(plain(document.template) && typeof document.template.id === 'string' && document.template.id.length > 0 && document.template.id.length <= 120 && ['auto', 'exact', 'inspiration'].includes(document.template.mode), 'The backup template settings are invalid.');
  for (const scene of document.scenes) {
    check(plain(scene.background) && plain(scene.screenshot) && plain(scene.text) && Array.isArray(scene.elements) && scene.elements.every((element: unknown) => plain(element) && typeof element.id === 'string' && typeof element.type === 'string') && Array.isArray(scene.popouts) && scene.popouts.every((popout: unknown) => plain(popout)), 'The backup has malformed screen layers.');
    check(plain(scene.background.gradient) && Array.isArray(scene.background.gradient.stops) && scene.background.gradient.stops.length > 0 && scene.background.gradient.stops.every((stop: unknown) => plain(stop) && typeof stop.color === 'string' && typeof stop.position === 'number'), 'The backup has malformed background settings.');
    check(plain(scene.screenshot.frame) && plain(scene.screenshot.shadow), 'The backup has malformed device appearance settings.');
    for (const field of ['headlineLanguages', 'subheadlineLanguages']) check(scene.text[field] === undefined || Array.isArray(scene.text[field]) && scene.text[field].every((locale: unknown) => typeof locale === 'string' && localePattern.test(locale)), 'The backup has malformed text languages.');
    for (const field of ['headlineFont', 'subheadlineFont']) check(scene.text[field] === undefined || typeof scene.text[field] === 'string', 'The backup has malformed fonts.');
    for (const element of scene.elements) check(element.font === undefined || typeof element.font === 'string', 'The backup has malformed fonts.');
  }
  for (const appearance of document.appearanceGroups) for (const field of ['frame', 'shadow']) check(appearance[field] === undefined || plain(appearance[field]), 'The backup has malformed device appearance settings.');
  for (const source of document.sources) {
    check(plain(source.localizedAssets), 'Localized screenshots must be an asset map.');
    for (const [locale, image] of Object.entries(source.localizedAssets)) check(localePattern.test(locale) && (typeof image === 'string' && assetPattern.test(image) || plain(image) && typeof image.assetId === 'string' && assetPattern.test(image.assetId)), 'A localized screenshot reference is invalid.');
  }
  const { getCloudRenderSupport, cloudSupportMessage } = await import('../core/cloud-support.mjs');
  let support; try { support = getCloudRenderSupport(document); } catch { throw archiveError('The campaign document is malformed.'); }
  invariant(support.cloudCompatible, 'UNSUPPORTED_DESIGN', cloudSupportMessage(support), 422, support.cloudLimitations);
  const scan = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      check(!(['url', 'src', 'imageSrc', 'href'].includes(key) && item !== null && item !== '') && !(key === 'image' && item !== null), 'Backup images must use included assets, never runtime images, external URLs or embedded data.');
      if (key === 'assetId' || key === 'sourceAssetId') check(typeof item === 'string' && assetPattern.test(item), 'A backup asset reference is invalid.');
      if (item && typeof item === 'object') scan(item);
    }
  };
  scan(document);
  const referenced = collectCampaignAssetIds(document), ids = new Set<string>(), files = new Set<string>();
  check(referenced.every(id => assetPattern.test(id)));
  for (const asset of manifest.assets) {
    check(asset && typeof asset.id === 'string' && assetPattern.test(asset.id) && !ids.has(asset.id) && ['image/png', 'image/jpeg'].includes(asset.mimeType));
    check(typeof asset.name === 'string' && asset.name.length > 0 && asset.name.length <= 180);
    const file = `assets/${asset.id}.${asset.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
    check(asset.file === file && !files.has(file) && entries.some(entry => entry.name === file), 'The backup is missing an original image or contains an inconsistent asset manifest.');
    ids.add(asset.id); files.add(file);
  }
  check(ids.size === referenced.length && referenced.every(id => ids.has(id)) && entries.length === ids.size + 1, 'Include exactly the original images referenced by this campaign.');
  // Reject references outside the canonical asset locations as well, rather than
  // retaining an unknown field that could point at another campaign in future.
  const verifyReferences = (value: any): void => { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) { if (key === 'assetId' || key === 'sourceAssetId') check(ids.has(item as string), 'A campaign image is missing from this backup.'); else if (item && typeof item === 'object') verifyReferences(item); } };
  verifyReferences(document);
  const assets: ImportedAsset[] = [];
  for (const asset of manifest.assets) {
    const source = await inflateEntry(bytes, entries.find(entry => entry.name === asset.file)!);
    let metadata;
    try {
      metadata = await sharp(source, { limitInputPixels: config.maxPixels, failOn: 'warning' }).metadata();
      check(['png', 'jpeg'].includes(metadata.format || '') && metadata.width && metadata.height && (metadata.pages || 1) === 1 && metadata.width * metadata.height <= config.maxPixels, 'Backup originals must be static PNG or JPEG images within the pixel limit.');
      // Metadata alone accepts some truncated files. Decode every pixel, then
      // discard the decoded buffer: the original screenshot bytes are preserved.
      await sharp(source, { limitInputPixels: config.maxPixels, failOn: 'warning' }).raw().toBuffer();
    } catch { throw archiveError('An original image is damaged, animated, or exceeds the image limits.'); }
    const mimeType = metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    check(asset.mimeType === mimeType, 'An image does not match the backup’s declared file type.');
    assets.push({ originalId: asset.id, name: asset.name.replace(/[\x00-\x1f/\\]/g, '_'), bytes: source, width: metadata.width!, height: metadata.height!, mimeType, extension: metadata.format === 'jpeg' ? 'jpg' : 'png', checksum: hash(source) });
  }
  for (const source of document.sources) {
    const asset = assets.find(asset => asset.originalId === source.assetId)!;
    check((source.width === undefined || source.width === asset.width) && (source.height === undefined || source.height === asset.height), 'The source dimensions do not match its original image.');
    for (const localized of Object.values(source.localizedAssets || {})) if (localized && typeof localized === 'object') {
      const value = localized as any, image = assets.find(asset => asset.originalId === value.assetId);
      check(image && (value.width === undefined || value.width === image.width) && (value.height === undefined || value.height === image.height), 'A localized source has inconsistent dimensions.');
    }
    // Earlier canonical documents allowed {assetId,width,height} aliases. The
    // editor/renderer consume IDs, so normalize only that media-reference alias;
    // design geometry, locks, groups, source IDs and original bytes stay intact.
    source.localizedAssets = Object.fromEntries(Object.entries(source.localizedAssets).map(([locale, image]) => [locale, typeof image === 'string' ? image : (image as any).assetId]));
  }
  return { document, assets };
}

/** A backup is copied into a new campaign. The only persistent pre-admission
 * state is a private, immutable request intent, allowing the same operation to
 * recover safely after an uncertain storage response or database COMMIT. */
export async function importProjectBackup(services: AppServices, ctx: Context, args: { bytes: Buffer; idempotencyKey: string; name?: string }) {
  requireScope(ctx, 'projects:write'); requireScope(ctx, 'assets:write'); await services.assertMembership(ctx);
  const key = z.string().min(8).max(200).parse(args.idempotencyKey), requestedName = args.name === undefined ? undefined : nameSchema.parse(args.name);
  const parsed = await parseProjectBackup(args.bytes, services.config);
  const name = requestedName ?? `${(parsed.document.name.trim() || 'Untitled campaign').slice(0, 104)} · Imported copy`;
  nameSchema.parse(name);
  const request = { idempotencyKey: key, archiveHash: hash(args.bytes), name: requestedName ?? null };
  // Use the same lock order as ordinary project/upload admission. A pending
  // receipt reserves identities, not project/storage quota or a visible project.
  await transaction(services.db, async client => {
    await services.assertMembership(ctx, client); await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ctx.workspaceId]);
    const receipt = await services.writeReceipt(client, ctx, 'import-project', request);
    if (!receipt!.result) await services.storeReceipt(client, ctx, receipt, { state: 'pending', projectId: randomUUID(), revisionId: randomUUID(), assetIds: Object.fromEntries(parsed.assets.map(asset => [asset.originalId, randomUUID()])) });
  });
  return transaction(services.db, async client => {
    await services.assertMembership(ctx, client); await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ctx.workspaceId]);
    const receipt = (await services.writeReceipt(client, ctx, 'import-project', request))!, intent = receipt.result;
    if (intent.state === 'complete') { await services.project(ctx, intent.response.project.id, client); return intent.response; }
    const count = await client.query('SELECT count(*)::integer AS count FROM projects WHERE workspace_id=$1 AND archived_at IS NULL', [ctx.workspaceId]);
    invariant(count.rows[0].count < services.config.maxProjects, 'PROJECT_LIMIT', 'Your workspace has reached its project limit.', 402);
    const usage = await client.query('SELECT COALESCE(sum(byte_size),0)::bigint AS used FROM assets WHERE workspace_id=$1', [ctx.workspaceId]);
    invariant(Number(usage.rows[0].used) + parsed.assets.reduce((sum, asset) => sum + asset.bytes.length, 0) <= services.config.maxStorageBytes, 'STORAGE_LIMIT', 'Your workspace does not have enough storage for this backup.', 402);
    const document = structuredClone(parsed.document);
    const remap = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'assetId' || key === 'sourceAssetId') value[key] = intent.assetIds[item as string];
        else if (key === 'localizedAssets' && item && typeof item === 'object') for (const [locale, image] of Object.entries(item)) { if (typeof image === 'string') (item as any)[locale] = intent.assetIds[image]; else remap(image); }
        else if (item && typeof item === 'object') remap(item);
      }
    };
    remap(document); document.id = intent.projectId; document.name = name; document.revisionId = intent.revisionId; document.revision = 0;
    for (const field of ['workspaceId', 'projectId', 'parentRevisionId', 'createdBy', 'createdAt', 'updatedAt']) delete document[field];
    const written: Array<{ key: string; checksum: string }> = [];
    try {
      await client.query('INSERT INTO projects(id,workspace_id,name,brief,design_preferences) VALUES($1,$2,$3,$4,$5)', [intent.projectId, ctx.workspaceId, name, document.brief || {}, { templateId: document.template?.id, templateMode: document.template?.mode, locks: document.locks || {}, screenCount: document.scenes.length, sourceIds: document.sources.map((source: any) => source.assetId), profile: document.profile, locale: document.locale }]);
      for (const asset of parsed.assets) {
        const id = intent.assetIds[asset.originalId], storageKey = `${ctx.workspaceId}/sources/${id}.${asset.extension}`;
        written.push({ key: storageKey, checksum: asset.checksum });
        try { await services.storage.put(storageKey, asset.bytes, asset.mimeType); }
        catch {
          const prior = await services.storage.read(storageKey).catch(() => null);
          if (!prior || hash(prior) !== asset.checksum) throw new AppError('IMPORT_STORAGE_FAILED', 'The backup could not be stored. No campaign was added. Retry the same backup to resume safely.', 503);
        }
        await client.query('INSERT INTO assets(id,workspace_id,project_id,name,storage_key,mime_type,byte_size,width,height,sha256,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,\'source\')', [id, ctx.workspaceId, intent.projectId, asset.name, storageKey, asset.mimeType, asset.bytes.length, asset.width, asset.height, asset.checksum]);
      }
      await services.assertMembership(ctx, client);
      const revisionResult = await client.query('INSERT INTO campaign_revisions(id,workspace_id,project_id,parent_revision_id,document,qa,label,created_by) VALUES($1,$2,$3,NULL,$4,$5,$6,$7) RETURNING *', [intent.revisionId, ctx.workspaceId, intent.projectId, document, { reviewNeeded: true, issues: [], imported: true }, 'Imported backup', ctx.userId]);
      const projectResult = await client.query('UPDATE projects SET active_revision_id=$1 WHERE id=$2 AND workspace_id=$3 RETURNING *', [intent.revisionId, intent.projectId, ctx.workspaceId]);
      const response = { project: row(projectResult.rows[0]), revision: row(revisionResult.rows[0]) };
      await client.query('UPDATE write_receipts SET result=$1 WHERE workspace_id=$2 AND user_id=$3 AND action=\'import-project\' AND request_key=$4 AND request_hash=$5', [{ state: 'complete', response }, ctx.workspaceId, ctx.userId, receipt.key, receipt.requestHash]);
      await client.query('INSERT INTO audit_events(id,workspace_id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), ctx.workspaceId, ctx.userId, 'project.import', intent.projectId, { revisionId: intent.revisionId, assetCount: parsed.assets.length }]);
      return response;
    } catch (error) {
      // This callback has NOT reached COMMIT. These keys belong exclusively to
      // this pending intent, and the workspace lock prevents a concurrent retry.
      // Only remove matching bytes. Leave uncertain COMMIT outcomes (outside this
      // callback) alone: the receipt will replay/adopt them on the next request.
      for (const object of written) {
        try { const bytes = await services.storage.read(object.key); if (hash(bytes) === object.checksum) await services.storage.remove(object.key); }
        catch { /* A later retry adopts matching private bytes if cleanup failed. */ }
      }
      throw error;
    }
  });
}
