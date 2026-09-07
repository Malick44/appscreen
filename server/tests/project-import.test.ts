import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCampaign } from '../../core/campaign.mjs';
import { toLegacyState } from '../../core/campaign.mjs';
import { deterministicZip } from '../worker.js';
import { inspectProjectZip, parseProjectBackup, PROJECT_IMPORT_LIMITS } from '../project-import.js';

const limits = { uploadLimit: 20 * 1024 * 1024, maxPixels: 40_000_000 };
async function fixture() {
  const png = await sharp({ create: { width: 64, height: 128, channels: 4, background: '#357f98' } }).png().toBuffer();
  const id = randomUUID(), document = (createCampaign as any)({ id: randomUUID(), name: 'A real editable campaign', assets: [{ id, width: 64, height: 128 }], templateId: 'tidal-relay', templateMode: 'exact', screenCount: 3 });
  const asset = { id, file: `assets/${id}.png`, name: 'Original screenshot.png', mimeType: 'image/png' };
  const manifest = { format: 'appscreen-campaign', version: 1, document, assets: [asset] };
  const zip = (value: any = manifest, media = png, extras: Array<{ name: string; bytes: Buffer | string }> = []) => deterministicZip([{ name: 'project.json', bytes: JSON.stringify(value) }, { name: asset.file, bytes: media }, ...extras]);
  return { png, id, document, asset, manifest, zip };
}

test('portable project parser accepts the actual exporter ZIP and preserves original bytes', async () => {
  const f = await fixture(), archive = await f.zip(), parsed = await parseProjectBackup(archive, limits);
  assert.deepEqual(parsed.document, f.document); assert.deepEqual(parsed.assets[0].bytes, f.png);
  assert.equal(parsed.assets[0].width, 64); assert.equal(parsed.assets[0].height, 128);
  assert.equal(inspectProjectZip(archive, limits.uploadLimit).length, 2);
});

test('legacy localized image aliases normalize into references the real editor can resolve', async () => {
  const f = await fixture(); f.document.sources[0].localizedAssets.fr = { assetId: f.id, width: 64, height: 128 };
  const parsed = await parseProjectBackup(await f.zip(), limits);
  assert.equal(parsed.document.sources[0].localizedAssets.fr, f.id);
  const requested: string[] = [];
  await toLegacyState(parsed.document, async (assetId: unknown) => { assert.equal(typeof assetId, 'string'); requested.push(assetId as string); return `data:image/png;base64,${f.png.toString('base64')}`; });
  assert.ok(requested.length >= 2);
});

test('JPEG backups preserve JPEG bytes and decoded dimensions without re-encoding', async () => {
  const f = await fixture(), jpeg = await sharp(f.png).jpeg({ quality: 91 }).toBuffer();
  f.asset.file = `assets/${f.id}.jpg`; f.asset.mimeType = 'image/jpeg'; f.asset.name = 'Original.jpeg';
  const archive = await deterministicZip([{ name: 'project.json', bytes: JSON.stringify(f.manifest) }, { name: f.asset.file, bytes: jpeg }]);
  const parsed = await parseProjectBackup(archive, limits);
  assert.equal(parsed.assets[0].mimeType, 'image/jpeg'); assert.equal(parsed.assets[0].extension, 'jpg');
  assert.equal(parsed.assets[0].width, 64); assert.equal(parsed.assets[0].height, 128); assert.deepEqual(parsed.assets[0].bytes, jpeg);
});

test('ZIP admission rejects unsafe structures before inflation', async t => {
  const f = await fixture(), archive = await f.zip();
  const indexed = inspectProjectZip(archive, limits.uploadLimit), first = indexed[0], eocd = archive.length - 22, central = archive.readUInt32LE(eocd + 16);
  const mutate = (change: (bytes: Buffer) => void) => { const bytes = Buffer.from(archive); change(bytes); return bytes; };
  const cases: Array<[string, Buffer]> = [
    ['not a ZIP', Buffer.from('not a ZIP')], ['truncated end', archive.subarray(0, -1)], ['trailing bytes', Buffer.concat([archive, Buffer.from('extra')])],
    ['encrypted entry', mutate(bytes => { bytes.writeUInt16LE(1, central + 8); bytes.writeUInt16LE(1, first.offset + 6); })],
    ['unsupported compression', mutate(bytes => { bytes.writeUInt16LE(99, central + 10); bytes.writeUInt16LE(99, first.offset + 8); })],
    ['data descriptor flag', mutate(bytes => bytes.writeUInt16LE(8, central + 8))],
    ['symlink', mutate(bytes => bytes.writeUInt32LE(0xa1ff0000, central + 38))],
    ['multidisk archive', mutate(bytes => bytes.writeUInt16LE(1, eocd + 4))],
    ['ZIP64 count', mutate(bytes => bytes.writeUInt16LE(65535, eocd + 10))],
    ['ZIP64 offset', mutate(bytes => bytes.writeUInt32LE(0xffffffff, central + 42))],
    ['header CRC disagreement', mutate(bytes => bytes.writeUInt32LE((first.crc + 1) >>> 0, central + 16))],
    ['overlapping local entries', mutate(bytes => bytes.writeUInt32LE(indexed[1].offset, central + 42))],
    ['oversized expanded file', mutate(bytes => { bytes.writeUInt32LE(0x7fffffff, central + 24); bytes.writeUInt32LE(0x7fffffff, first.offset + 22); })],
    ['implausible compression ratio', mutate(bytes => { const size = first.compressedSize * (PROJECT_IMPORT_LIMITS.compressionRatio + 1); bytes.writeUInt32LE(size, central + 24); bytes.writeUInt32LE(size, first.offset + 22); })],
    ['traversal path', await deterministicZip([{ name: 'project.json', bytes: '{}' }, { name: '../sensitive.png', bytes: 'bad' }])],
    ['backslash path', await deterministicZip([{ name: 'project.json', bytes: '{}' }, { name: 'assets\\sensitive.png', bytes: 'bad' }])],
    ['absolute path', await deterministicZip([{ name: 'project.json', bytes: '{}' }, { name: '/sensitive.png', bytes: 'bad' }])],
    ['unexpected extra file', await f.zip(f.manifest, f.png, [{ name: 'run.js', bytes: 'ignored but unsafe' }])],
    ['too many entries', await deterministicZip([{ name: 'project.json', bytes: '{}' }, ...Array.from({ length: 101 }, () => ({ name: `assets/${randomUUID()}.png`, bytes: 'tiny' }))])],
  ];
  for (const [label, bytes] of cases) await t.test(label, () => assert.throws(() => inspectProjectZip(bytes, limits.uploadLimit), error => ['INVALID_PROJECT_BACKUP', 'IMPORT_SIZE'].includes((error as any).code)));
  await t.test('duplicate raw names cannot be hidden by ZIP library normalization', async () => {
    const secondId = randomUUID(), two = await f.zip(f.manifest, f.png, [{ name: `assets/${secondId}.png`, bytes: f.png }]);
    const needle = Buffer.from(secondId), replace = Buffer.from(f.id);
    for (let position = two.indexOf(needle); position >= 0; position = two.indexOf(needle, position + needle.length)) replace.copy(two, position);
    assert.throws(() => inspectProjectZip(two, limits.uploadLimit), /duplicate/);
  });
  await t.test('per-image expanded limit applies before inflation', () => assert.throws(() => inspectProjectZip(archive, 10), (error: any) => error.code === 'IMPORT_SIZE'));
});

test('portable backup contents reject malformed canonical documents and missing/unsafe assets', async t => {
  const f = await fixture();
  const cases: Array<[string, (manifest: any) => void]> = [
    ['wrong backup format', value => { value.format = 'account-export'; }], ['unsupported version', value => { value.version = 2; }],
    ['null source', value => { value.document.sources[0] = null; }], ['null scene', value => { value.document.scenes[0] = null; }],
    ['null device', value => { value.document.scenes[0].devices[0] = null; }], ['missing template geometry', value => { value.document.deviceGroups[0].geometry = null; }],
    ['missing scene elements', value => { delete value.document.scenes[0].elements; }], ['null scene element', value => { value.document.scenes[0].elements = [null]; }],
    ['invalid locale', value => { value.document.locale = '<img src=x>'; }], ['invalid localized map', value => { value.document.sources[0].localizedAssets = 'bad'; }],
    ['null gradient for solid background', value => { value.document.scenes[0].background.type = 'solid'; value.document.scenes[0].background.gradient = null; }],
    ['null appearance frame', value => { value.document.appearanceGroups[0].frame = null; }],
    ['null screenshot shadow', value => { value.document.scenes[0].screenshot.shadow = null; }],
    ['malformed headline languages', value => { value.document.scenes[0].text.headlineLanguages = {}; }],
    ['malformed font value', value => { value.document.scenes[0].text.headlineFont = []; }],
    ['invalid localized locale', value => { value.document.sources[0].localizedAssets['<img src=x>'] = value.assets[0].id; }],
    ['nested runtime image URL', value => { value.document.scenes[0].elements = [{ id: 'runtime', type: 'graphic', image: { src: ['https://example.invalid/private.png'] } }]; }],
    ['array URL', value => { value.document.scenes[0].background.url = ['https://example.invalid/private.png']; }],
    ['no scenes', value => { value.document.scenes = []; }], ['too many screens', value => { value.document.scenes = Array.from({ length: 11 }, (_, index) => ({ ...structuredClone(value.document.scenes[0]), id: `scene-${index}` })); }],
    ['unsupported 3D rendering', value => { value.document.scenes[0].screenshot.use3D = true; }],
    ['external background URL', value => { value.document.scenes[0].background.url = 'https://example.invalid/private.png'; }],
    ['embedded screenshot', value => { value.document.sources[0].src = 'data:image/png;base64,bad'; }],
    ['missing manifest asset', value => { value.assets = []; }], ['duplicate manifest asset', value => { value.assets.push(value.assets[0]); }],
    ['missing included file', value => { value.assets[0].file = `assets/${randomUUID()}.png`; }],
    ['foreign asset reference without bytes', value => { value.document.sources[0].assetId = randomUUID(); }],
    ['missing localized bytes', value => { value.document.sources[0].localizedAssets.fr = randomUUID(); }],
    ['missing decorative bytes', value => { value.document.scenes[0].elements.push({ id: 'missing', type: 'image', assetId: randomUUID() }); }],
    ['missing nested media bytes', value => { value.document.scenes[0].popouts.push({ id: 'missing', media: { assetId: randomUUID() } }); }],
    ['wrong source dimensions', value => { value.document.sources[0].width = 100; }],
    ['non-image manifest MIME', value => { value.assets[0].mimeType = 'text/html'; }],
    ['unsafe object key', value => { value.document.brief = JSON.parse('{"__proto__":{"polluted":true}}'); }],
  ];
  for (const [label, change] of cases) await t.test(label, async () => {
    const manifest = structuredClone(f.manifest); change(manifest);
    await assert.rejects(parseProjectBackup(await f.zip(manifest), limits), error => [400, 413, 422].includes((error as any).statusCode));
  });
  await t.test('corrupt compressed content has a safe checksum/decompression error', async () => {
    const bytes = await f.zip(), entry = inspectProjectZip(bytes, limits.uploadLimit).find(entry => entry.name.endsWith('.png'))!;
    bytes[entry.dataOffset + Math.floor(entry.compressedSize / 2)] ^= 0xff;
    await assert.rejects(parseProjectBackup(bytes, limits), (error: any) => error.code === 'INVALID_PROJECT_BACKUP');
  });
  await t.test('inflation cannot exceed a forged low expanded-size declaration', async () => {
    const bytes = await f.zip(), entry = inspectProjectZip(bytes, limits.uploadLimit).find(entry => entry.name === 'project.json')!;
    let cursor = bytes.readUInt32LE(bytes.length - 6);
    while (bytes.subarray(cursor + 46, cursor + 46 + bytes.readUInt16LE(cursor + 28)).toString() !== entry.name) cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    bytes.writeUInt32LE(10, cursor + 24); bytes.writeUInt32LE(10, entry.offset + 22);
    inspectProjectZip(bytes, limits.uploadLimit);
    await assert.rejects(parseProjectBackup(bytes, limits), (error: any) => error.code === 'INVALID_PROJECT_BACKUP');
  });
  await t.test('complete pixel decode rejects truncated original image bytes', async () => {
    await assert.rejects(parseProjectBackup(await f.zip(f.manifest, f.png.subarray(0, Math.floor(f.png.length / 2))), limits), /damaged/);
  });
  await t.test('actual image format must agree with manifest', async () => {
    const jpeg = await sharp(f.png).jpeg().toBuffer();
    await assert.rejects(parseProjectBackup(await f.zip(f.manifest, jpeg), limits), /declared file type/);
  });
  await t.test('pixel limit applies even to tiny compressed images', async () => {
    await assert.rejects(parseProjectBackup(await f.zip(), { ...limits, maxPixels: 100 }), /image limits/);
  });
});
