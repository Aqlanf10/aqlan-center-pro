// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Bounded, dependency-free XLSX (OOXML spreadsheet) reader for legacy archive
// import. Read-only: extracts the first worksheet as text records shaped
// exactly like parseImportCsv output ({ line, cells }). No formula evaluation,
// no external entity resolution, no style/date inference: date serials stay
// numeric strings and the preview's validation decides. The ZIP layer enforces
// declared and actual output caps so a workbook cannot exhaust memory.
import { inflateRawSync } from 'node:zlib';

export const XLSX_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024, maxRows: 10000, maxColumns: 64, maxCellLength: 10000,
  maxUncompressed: 20 * 1024 * 1024, maxEntries: 200,
});
const MESSAGES = {
  INVALID_WORKBOOK: ['The workbook is not a readable XLSX file.', 'الملف ليس مصنفا XLSX قابلا للقراءة.'],
  FILE_LIMIT: ['File exceeds the preview size limit.', 'الملف يتجاوز حد حجم المعاينة.'],
  ROW_LIMIT: ['File exceeds the row limit.', 'الملف يتجاوز عدد الصفوف المسموح.'],
  COLUMN_LIMIT: ['Row exceeds the column limit.', 'الصف يتجاوز عدد الأعمدة المسموح.'],
  CELL_LIMIT: ['Cell exceeds the text length limit.', 'الخلية تتجاوز طول النص المسموح.'],
  INVALID_OPTIONS: ['Invalid explicit import configuration.', 'إعدادات الاستيراد الصريحة غير صحيحة.'],
};
function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.issue = { code, severity: 'error', messageEn: MESSAGES[code][0], messageAr: MESSAGES[code][1] };
  throw error;
}
function limits(options = {}) {
  const result = { ...XLSX_LIMITS };
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS');
  for (const [key, value] of Object.entries(options)) {
    if (!(key in XLSX_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > XLSX_LIMITS[key]) fail('INVALID_OPTIONS');
    result[key] = value;
  }
  return result;
}

function unescapeXml(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#[xX]([0-9a-fA-F]{1,8})|#(\d{1,8})|(amp|lt|gt|quot|apos));/g, (_, hex, dec, name) => {
    if (hex !== undefined) {
      const point = parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    if (dec !== undefined) {
      const point = Number(dec);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
  });
}

// Scientific notation is rewritten only when the value is exactly representable
// with at most two fraction digits; anything else stays raw so the preview's
// exact-decimal rule rejects it instead of inventing precision.
function normalizeNumber(raw) {
  if (!/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(raw)) return raw;
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) return raw;
  const scaled = Math.round(value * 100);
  if (Math.abs(value * 100 - scaled) < 1e-6) {
    if (scaled === 0) return '0';
    if (scaled % 100 === 0) return String(scaled / 100);
    return (scaled / 100).toFixed(2);
  }
  return raw;
}

function parseAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z0-9:._-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}
const colOf = letters => {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) fail('INVALID_WORKBOOK');
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
};

function zipIndex(buf, caps) {
  if (buf.length < 22) fail('INVALID_WORKBOOK');
  let eocd = -1;
  const floor = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) fail('INVALID_WORKBOOK');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total < 1 || total > caps.maxEntries || cdOffset === 0xffffffff || cdOffset + 46 > buf.length) fail('INVALID_WORKBOOK');
  const index = new Map();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('INVALID_WORKBOOK');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (!index.has(name)) index.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
    if (p > buf.length) fail('INVALID_WORKBOOK');
  }
  return index;
}

function extract(index, buf, name, caps, state) {
  const entry = index.get(name);
  if (!entry) return null;
  if (entry.compSize > caps.maxUncompressed) fail('FILE_LIMIT');
  if (entry.local + 30 > buf.length || buf.readUInt32LE(entry.local) !== 0x04034b50) fail('INVALID_WORKBOOK');
  const nameLen = buf.readUInt16LE(entry.local + 26);
  const extraLen = buf.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nameLen + extraLen;
  if (start + entry.compSize > buf.length) fail('INVALID_WORKBOOK');
  const slice = buf.subarray(start, start + entry.compSize);
  let out;
  if (entry.method === 0) out = Buffer.from(slice);
  else if (entry.method === 8) {
    try { out = inflateRawSync(slice, { maxOutputLength: caps.maxUncompressed }); }
    catch (e) { fail(e?.code === 'ERR_BUFFER_TOO_LARGE' ? 'FILE_LIMIT' : 'INVALID_WORKBOOK'); }
  } else fail('INVALID_WORKBOOK');
  state.inflatedTotal += out.length;
  if (out.length > caps.maxUncompressed || state.inflatedTotal > caps.maxUncompressed) fail('FILE_LIMIT');
  return out;
}

function pickEntries(index, buf, caps, state) {
  const workbook = index.get('xl/workbook.xml');
  const rels = index.get('xl/_rels/workbook.xml.rels');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (workbook && rels) {
    const wbXml = new TextDecoder('utf-8', { fatal: false }).decode(extract(index, buf, 'xl/workbook.xml', caps, state));
    const first = wbXml.match(/<sheet\b[^>]*>/);
    if (!first) fail('INVALID_WORKBOOK');
    const rid = parseAttrs(first[0])['r:id'];
    if (!rid) fail('INVALID_WORKBOOK');
    const relsXml = new TextDecoder('utf-8', { fatal: false }).decode(extract(index, buf, 'xl/_rels/workbook.xml.rels', caps, state));
    const rel = [...relsXml.matchAll(/<Relationship\b[^>]*>/g)]
      .map(m => parseAttrs(m[0])).find(attrs => attrs.Id === rid);
    if (!rel || typeof rel.Target !== 'string' || !rel.Target) fail('INVALID_WORKBOOK');
    const target = rel.Target.replace(/^\//, '').split('/').filter(part => part && part !== '.').join('/');
    if (target.startsWith('xl/')) sheetPath = target;
    else if (target.startsWith('../')) sheetPath = 'xl/' + target.slice(3);
    else sheetPath = 'xl/' + target;
  }
  return { sheetPath, sharedPath: 'xl/sharedStrings.xml' };
}

function sharedStrings(data) {
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(data);
  const strings = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\/>/g)) {
    const body = (si[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
    strings.push(text);
    if (text.length > 100000) fail('CELL_LIMIT');
  }
  return strings;
}

function sheetRecords(data, shared, bounds) {
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(data);
  const records = [];
  let rowOrdinal = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowOrdinal++;
    const rowAttrs = parseAttrs(rowMatch[1] || '');
    const rowNumber = Number(rowAttrs.r);
    const line = Number.isSafeInteger(rowNumber) && rowNumber > 0 && rowNumber <= 1e9 ? rowNumber : rowOrdinal;
    const cells = [];
    let fallbackColumn = 0;
    let hasContent = false;
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = parseAttrs(cellMatch[1] || '');
      let column;
      if (attrs.r) {
        const position = /^([A-Za-z]+)(\d+)$/.exec(attrs.r);
        if (!position) fail('INVALID_WORKBOOK');
        column = colOf(position[1]);
      } else column = fallbackColumn++;
      if (column >= bounds.maxColumns) fail('COLUMN_LIMIT');
      fallbackColumn = Math.max(fallbackColumn, column + 1);
      const body = cellMatch[2] ?? '';
      let value = '';
      if (attrs.t === 'e') value = '';
      else if (attrs.t === 'inlineStr') {
        const clean = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
        for (const t of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value += unescapeXml(t[1]);
      } else {
        const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? v[1] : '';
        if (attrs.t === 's') {
          const index = Number(raw.trim());
          if (!Number.isInteger(index) || index < 0 || index >= shared.length) fail('INVALID_WORKBOOK');
          value = shared[index];
        } else if (attrs.t === 'b') value = raw.trim() === '1' ? '1' : '0';
        else value = normalizeNumber(unescapeXml(raw).trim());
      }
      if (value.length > bounds.maxCellLength) fail('CELL_LIMIT');
      if (value !== '') hasContent = true;
      cells[column] = value;
    }
    if (!hasContent) continue;
    const filled = [];
    for (let i = 0; i < cells.length; i++) filled.push(cells[i] ?? '');
    records.push({ line, cells: filled });
    if (records.length > bounds.maxRows + 1) fail('ROW_LIMIT');
  }
  return records;
}

/**
 * bytes: Uint8Array of a .xlsx workbook (5MB cap by default). Returns the same
 * record shape as parseImportCsv so the preview consumes one representation.
 * The first worksheet only; legacy archive exports are single-sheet.
 */
export function parseImportXlsx(bytes, requestedLimits = {}) {
  const bounds = limits(requestedLimits);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail('INVALID_WORKBOOK');
  if (bytes.length > bounds.maxBytes) fail('FILE_LIMIT');
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = { inflatedTotal: 0 };
  const index = zipIndex(buf, bounds);
  const { sheetPath, sharedPath } = pickEntries(index, buf, bounds, state);
  let shared = [];
  if (index.has(sharedPath)) shared = sharedStrings(extract(index, buf, sharedPath, bounds, state));
  if (!index.has(sheetPath)) fail('INVALID_WORKBOOK');
  return sheetRecords(extract(index, buf, sheetPath, bounds, state), shared, bounds);
}
