/**
 * zip.mjs — minimal deterministic ZIP writer and reader on node:zlib (#1931).
 *
 * Node has no ZIP writer in its stdlib and the repo carries no ZIP dependency
 * (BV-001.5), so this module implements the small subset the OpenAI
 * skills-only package needs: DEFLATE (method 8) or STORE (method 0) entries,
 * no ZIP64, no encryption, no data descriptors. Ceiling: archives under 4 GiB
 * and 65,535 entries; revisit if a package ever approaches that.
 *
 * Determinism: entries are sorted by path, every entry carries the same fixed
 * DOS timestamp (1980-01-01 00:00) and fixed external attributes, so two
 * builds of the same tree are byte-identical.
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_DESCRIPTOR = 0x0008;
const EXTRA_ZIP64 = 0x0001;
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_FLAG = 0x0800;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{path: string, data: Buffer}>} files POSIX paths, files only
 *   (directories are implied by their members)
 * @returns {Buffer}
 */
export function writeZip(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { path, data } of sorted) {
    const name = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: UNIX, v2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((S_IFREG | 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * Whether an extra-field block carries a record with header id `id`.
 *
 * @param {Buffer} extra
 * @param {number} id
 * @returns {boolean}
 */
function hasExtraField(extra, id) {
  for (let i = 0; i + 4 <= extra.length; i += 4 + extra.readUInt16LE(i + 2)) {
    if (extra.readUInt16LE(i) === id) return true;
  }
  return false;
}

/** A structurally broken or inconsistent archive. Callers report it as a violation. */
export class ZipFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

/**
 * Read a ZIP archive written by {@link writeZip} or any common tool (STORE or
 * DEFLATE, no ZIP64). Every entry is cross-checked against its local header:
 * the local name must equal the central-directory name (an extractor that
 * reads local headers would otherwise see a different path than the
 * validator), and the inflated payload must match the recorded size and CRC.
 * The local entries must also tile `[0, central directory offset)` exactly:
 * a gap could hold a local entry that is missing from the central directory,
 * which this reader would never see but an extractor that walks local headers
 * in order would unpack. Duplicate and control-character names are returned
 * as-is for the caller's validator to report.
 *
 * @param {Buffer} buf
 * @returns {Array<{path: string, data: Buffer|null, isDirectory: boolean, isSymlink: boolean}>}
 * @throws {ZipFormatError} on any structural defect, including truncation
 */
export function readZip(buf) {
  try {
    return readZipUnchecked(buf);
  } catch (err) {
    if (err instanceof ZipFormatError) throw err;
    // Out-of-range reads (truncation) and inflate errors are format defects too.
    throw new ZipFormatError(`zip: ${err.message}`);
  }
}

/** @param {Buffer} buf */
function readZipUnchecked(buf) {
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) throw new ZipFormatError('zip: end-of-central-directory record not found');
  const count = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdOff = buf.readUInt32LE(eocdAt + 16);
  // Bytes between the central directory and the EOCD record are read by nobody
  // here, but a local-header scanner could still find an entry there.
  if (cdOff + cdSize !== eocdAt) throw new ZipFormatError(`zip: central directory (offset ${cdOff}, size ${cdSize}) does not end at the end-of-central-directory record at ${eocdAt}`);
  let p = cdOff;
  const out = [];
  /** @type {Array<{start: number, end: number, path: string}>} byte range of each local header + data (+ descriptor) */
  const spans = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError(`zip: bad central header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0xffff;
    const localAt = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocdAt) throw new ZipFormatError(`zip: central header at ${p} runs past the directory`);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const path = nameBytes.toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localAt) !== SIG_LOCAL) throw new ZipFormatError(`zip: bad local header for ${path}`);
    const localNameLen = buf.readUInt16LE(localAt + 26);
    if (!buf.subarray(localAt + 30, localAt + 30 + localNameLen).equals(nameBytes)) {
      throw new ZipFormatError(`zip: local header name differs from central directory name for ${path}`);
    }
    const isDirectory = path.endsWith('/');
    const isSymlink = (mode & S_IFMT) === S_IFLNK;
    let data = null;
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    if (hasExtraField(buf.subarray(localAt + 30 + localNameLen, localAt + 30 + localNameLen + localExtraLen), EXTRA_ZIP64)) {
      // Fail closed: ZIP64 changes sizes and descriptor length, and nothing here reads it.
      throw new ZipFormatError(`zip: ZIP64 is not supported (${path})`);
    }
    const start = localAt + 30 + localNameLen + localExtraLen;
    let end = start + compSize;
    // A streamed entry (flag bit 3, e.g. macOS Archive Utility) is followed by
    // a data descriptor: 16 bytes with its optional signature, else 12.
    if (buf.readUInt16LE(localAt + 6) & FLAG_DESCRIPTOR) end += end + 4 <= buf.length && buf.readUInt32LE(end) === SIG_DESCRIPTOR ? 16 : 12;
    spans.push({ start: localAt, end, path });
    if (!isDirectory) {
      if (start + compSize > buf.length) throw new ZipFormatError(`zip: payload of ${path} runs past the end of the archive`);
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new ZipFormatError(`zip: unsupported compression method ${method} for ${path}`);
      if (data.length !== size) throw new ZipFormatError(`zip: size mismatch for ${path}`);
      if ((crc32(data) >>> 0) !== crc) throw new ZipFormatError(`zip: CRC mismatch for ${path}`);
    }
    out.push({ path, data, isDirectory, isSymlink });
  }
  let at = 0;
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.start !== at) {
      throw new ZipFormatError(span.start > at
        ? `zip: ${span.start - at} unlisted byte(s) at offset ${at}, before ${span.path}; a local entry missing from the central directory could hide there`
        : `zip: local entry of ${span.path} overlaps the entry before it`);
    }
    at = span.end;
  }
  if (at > cdOff) throw new ZipFormatError(`zip: the last local entry runs into the central directory at ${cdOff}`);
  if (at < cdOff) throw new ZipFormatError(`zip: ${cdOff - at} unlisted byte(s) between the last local entry and the central directory at ${cdOff}; a local entry missing from the central directory could hide there`);
  return out;
}
