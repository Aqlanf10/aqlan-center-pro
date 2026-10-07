// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Minimal XLSX (ZIP/OOXML) builder for tests: no dependencies, supports
// stored and deflate entries, shared strings and inline values. Used to feed
// the bounded import-xlsx reader with both valid and hostile workbooks.
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data:Buffer|string, deflate?:boolean }] → ZIP bytes */
export function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(0, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = index => {
  let name = '', n = index + 1;
  while (n > 0) { name = String.fromCharCode(64 + ((n - 1) % 26) + 1) + name; n = Math.floor((n - 1) / 26); }
  return name;
};

/**
 * rows: string[][] (first row = header). Cells starting with '=' are emitted
 * as raw numbers; options.rawXml replaces the sheet body for edge cases.
 */
export function buildXlsx(rows, { shared = true, rawXml, deflate = false } = {}) {
  const strings = [];
  const indexOf = value => {
    let i = strings.indexOf(value);
    if (i < 0) { i = strings.length; strings.push(value); }
    return i;
  };
  let sheetBody = '';
  if (rawXml !== undefined) sheetBody = rawXml;
  else {
    sheetBody = rows.map((cells, rowIndex) => {
      const cellsXml = cells.map((value, colIndex) => {
        if (value === '' || value === null || value === undefined) return '';
        const ref = `${colName(colIndex)}${rowIndex + 1}`;
        if (/^=/.test(value)) return `<c r="${ref}"><v>${esc(value.slice(1))}</v></c>`;
        return shared ? `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
    }).join('');
  }
  const sharedXml = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetBody}</sheetData></worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  return buildZip([
    { name: 'xl/workbook.xml', data: workbookXml, deflate },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml, deflate },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml, deflate },
    ...(strings.length ? [{ name: 'xl/sharedStrings.xml', data: sharedXml, deflate }] : []),
  ]);
}
