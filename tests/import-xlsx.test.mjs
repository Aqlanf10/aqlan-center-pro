// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// MIG-01 XLSX evidence: the bounded reader extracts shared strings, inline
// text, numbers and entities into the same record shape as CSV, enforces the
// same limits, and rejects hostile workbooks without reading beyond caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportXlsx } from '../packages/domain/import-xlsx.mjs';
import { buildXlsx, buildZip } from './helpers/xlsx.mjs';
import { previewLegacyImport } from '../packages/domain/import-preview.mjs';

const HEADERS = ['sourceRecordId', 'fullName', 'currency', 'agreed', 'previouslyPaid', 'remaining', 'fileNumber', 'phone'];
const map = Object.fromEntries(HEADERS.map(h => [h, h]));

test('xlsx reader: shared strings, inline text, numbers and entities become one record shape', () => {
  const bytes = buildXlsx([
    HEADERS,
    ['L-1', 'مريض & أول <خاص>', 'SAR', '=15000', '=250.5', '', '0500', '777-000-001'],
    ['L-2', 'مريض ثان', 'SAR', '1000', '400', '600', '', ''],
  ]);
  const records = parseImportXlsx(bytes);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0].cells, HEADERS);
  assert.equal(records[1].line, 2);
  // Scientific notation is normalized only when exactly representable.
  assert.equal(records[1].cells[3], '15000');
  assert.equal(records[1].cells[4], '250.5');
  assert.equal(records[1].cells[7], '777-000-001');
  assert.equal(records[2].cells[5], '600');
  // The preview consumes the records directly (MIG-01 path).
  const preview = previewLegacyImport({ records, fileHash: 'a'.repeat(64), sourceSystem: 'desktop',
    headerMap: map, currencyMap: {}, delimiter: ',' });
  assert.equal(preview.summary.totalRows, 2);
  assert.equal(preview.summary.perCurrency.SAR.openingReceivable, '15349.50');
});

test('xlsx reader: rows without r attributes and skipped empty rows keep sheet positions', () => {
  const rawXml = '<row><c t="inlineStr"><is><t>headerA</t></is></c><c t="inlineStr"><is><t>headerB</t></is></c></row>'
    + '<row r="7"><c r="A7" t="inlineStr"><is><t>x1</t></is></c><c r="C7"><v>42</v></c></row>';
  const bytes = buildXlsx([['unused']], { rawXml });
  const records = parseImportXlsx(bytes);
  assert.equal(records.length, 2);
  assert.equal(records[0].line, 1);
  assert.deepEqual(records[0].cells, ['headerA', 'headerB']);
  assert.equal(records[1].line, 7);
  assert.deepEqual(records[1].cells, ['x1', '', '42']);
});

test('xlsx reader: boolean, error and sparse cells stay safe', () => {
  const rawXml = '<row><c t="inlineStr"><is><t>a</t></is></c></row>'
    + '<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#DIV/0!</v></c><c r="D2"><v>1.5E2</v></c></row>';
  const bytes = buildXlsx([['unused']], { rawXml });
  const records = parseImportXlsx(bytes);
  assert.deepEqual(records[1].cells, ['1', '', '', '150']);
});

test('xlsx reader: deflate-compressed workbooks parse identically', () => {
  const bytes = buildXlsx([HEADERS, ['L-1', 'مريض مضغوط', 'YER', '5000', '0', '5000', '', '']], { deflate: true });
  const records = parseImportXlsx(bytes);
  assert.equal(records[1].cells[1], 'مريض مضغوط');
  assert.equal(records[1].cells[3], '5000');
});

test('xlsx reader: malformed bytes, missing sheet and corrupted zip fail deterministically', () => {
  assert.throws(() => parseImportXlsx(new TextEncoder().encode('not a zip')), /INVALID_WORKBOOK/);
  assert.throws(() => parseImportXlsx(buildZip([{ name: 'xl/other.xml', data: '<x/>' }])), /INVALID_WORKBOOK/);
  const good = buildXlsx([HEADERS, ['L-1', 'n', 'SAR', '1', '0', '1', '', '']]);
  assert.throws(() => parseImportXlsx(good.subarray(0, good.length - 12)), /INVALID_WORKBOOK/);
  assert.throws(() => parseImportXlsx(Buffer.alloc(0)), /INVALID_WORKBOOK/);
});

test('xlsx reader: bounded bytes, rows, columns and cells (MIG-01 limits)', () => {
  const good = buildXlsx([HEADERS, ['L-1', 'n', 'SAR', '1', '0', '1', '', '']]);
  assert.throws(() => parseImportXlsx(good, { maxBytes: 10 }), /FILE_LIMIT/);
  const manyRows = [HEADERS, ...Array.from({ length: 10001 }, (_, i) => [`L-${i}`, 'n', 'SAR', '1', '0', '1', '', ''])];
  assert.throws(() => parseImportXlsx(buildXlsx(manyRows)), /ROW_LIMIT/);
  const wide = [HEADERS.slice(0, 1), ['x']];
  const wideXml = `<row><c t="inlineStr"><is><t>h</t></is></c>${Array.from({ length: 64 }, (_, i) => `<c><v>${i}</v></c>`).join('')}</row>`;
  assert.throws(() => parseImportXlsx(buildXlsx([['unused']], { rawXml: wideXml })), /COLUMN_LIMIT/);
  const longXml = '<row><c t="inlineStr"><is><t>' + 'س'.repeat(10001) + '</t></is></c></row>';
  assert.throws(() => parseImportXlsx(buildXlsx([['unused']], { rawXml: longXml })), /CELL_LIMIT/);
  assert.throws(() => parseImportXlsx(good, { maxUncompressed: 10 }), /FILE_LIMIT/);
  assert.throws(() => parseImportXlsx(good, { bogusLimit: 5 }), /INVALID_OPTIONS/);
});

test('xlsx reader: zip bomb stays capped by uncompressed output (FILE_LIMIT)', () => {
  const bomb = buildZip([
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(21 * 1024 * 1024), deflate: true },
    { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
  ]);
  assert.ok(bomb.length < 1024 * 1024);
  assert.throws(() => parseImportXlsx(bomb), /FILE_LIMIT/);
});

test('xlsx reader: workbook rels resolve the first sheet across renamed parts', () => {
  const bytes = buildZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="أرشيف" sheetId="1" r:id="rId7"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Target="worksheets/export2025.xml"/></Relationships>' },
    { name: 'xl/worksheets/export2025.xml', data: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>sourceRecordId</t></is></c></row><row><c><v>L-9</v></c></row></sheetData></worksheet>' },
  ]);
  const records = parseImportXlsx(bytes);
  assert.equal(records.length, 2);
  assert.equal(records[1].cells[0], 'L-9');
});
