import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_HEADERS, parseImportCsv, previewLegacyImport } from '../packages/domain/import-preview.mjs';
const hash = 'a'.repeat(64);
const headers = 'sourceRecordId,fullName,currency,agreed,previouslyPaid,remaining,fileNumber,phone';
const preview = (body, changes = {}) => previewLegacyImport({ csv: `${headers}\n${body}`, sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en, ...changes });
const codes = row => row.issues.map(i => i.code);

test('import preview: BOM, Arabic headers, quoted comma, multiline and escaped quotes preserve values', () => {
  const result = previewLegacyImport({ csv: '\uFEFFمعرف المصدر,اسم المريض,العملة,المتفق عليه,المدفوع سابقا,المتبقي,رقم الملف,الهاتف\r\nold-1,"مريض، \"\"أحمد\"\"\r\nعلي",سعودي,1000,400,600,0123,777\r\n', sourceSystem: 'paper', fileHash: hash, headerMap: IMPORT_HEADERS.ar, currencyMap: { سعودي: 'SAR' } });
  assert.equal(result.rows[0].data.fullName, 'مريض، "أحمد"\nعلي');
  assert.equal(result.rows[0].data.fileNumber, '0123');
  assert.equal(result.rows[0].data.calculatedRemaining, '600.00');
  assert.equal(result.summary.perCurrency.SAR.openingReceivable, '600.00');
  assert.equal(result.mode, 'preview_only');
  assert.equal(result.fileHashVerified, false);
  assert.equal(result.requiresHumanApproval, true);
});

test('CSV parser: malformed quoting and bounded bytes/rows/columns/cells fail deterministically', () => {
  for (const input of ['a,b\n"unterminated,b', 'a,b\nabc"def,b', 'a,b\n"abc"tail,b']) assert.throws(() => parseImportCsv(input), /INVALID_CSV/);
  assert.throws(() => parseImportCsv('أأ', { maxBytes: 3 }), /FILE_LIMIT/);
  assert.throws(() => parseImportCsv('h\na\nb', { maxRows: 1 }), /ROW_LIMIT/);
  assert.throws(() => parseImportCsv('a,b', { maxColumns: 1 }), /COLUMN_LIMIT/);
  assert.throws(() => parseImportCsv('abcd', { maxCellLength: 3 }), /CELL_LIMIT/);
  assert.throws(() => parseImportCsv('x', { maxRows: 10001 }), /INVALID_OPTIONS/);
  assert.throws(() => parseImportCsv('x', { delimiter: '|' }), /INVALID_OPTIONS/);
  assert.deepEqual(parseImportCsv('a;b\r1;"two;three"\r', { delimiter: ';' }), [{ line: 1, cells: ['a','b'] }, { line: 2, cells: ['1','two;three'] }]);
});

test('CSV parser: physical row numbers follow multiline cells and blank lines', () => {
  const rows = parseImportCsv('a,b\n\n1,"two\nthree"\n2,last\n');
  assert.deepEqual(rows.map(x => x.line), [1,3,5]);
});

test('import preview: explicit mappings are required, missing and duplicate headers fail', () => {
  assert.throws(() => preview('1,مريض,SAR,100,0,100,,', { headerMap: undefined }), /INVALID_OPTIONS/);
  assert.throws(() => preview('1,مريض,SAR,100,0,100,,', { headerMap: { ...IMPORT_HEADERS.en, fullName: 'Name' } }), /INVALID_HEADERS/);
  assert.throws(() => preview('1,مريض,SAR,100,0,100,,', { headerMap: { ...IMPORT_HEADERS.en, fullName: 'sourceRecordId' } }), /INVALID_HEADERS/);
  assert.throws(() => preview('', { csv: 'a,a\nx,x', headerMap: { sourceRecordId:'a',fullName:'a',currency:'a' } }), /INVALID_HEADERS/);
  assert.throws(() => preview('', { csv: headers }), /EMPTY_FILE/);
  assert.throws(() => preview('1,مريض,SAR,100,0,100,,', { fileHash: 'not-a-hash' }), /INVALID_OPTIONS/);
});

test('import preview: unknown historical values remain null and no remainder is invented', () => {
  const result = preview('1,مريض,SAR,1000,?,600,,\n2,مريض,USD,,20,,,');
  assert.equal(result.rows[0].data.previouslyPaid, null);
  assert.equal(result.rows[0].data.suppliedRemaining, '600.00');
  assert.equal(result.rows[0].data.calculatedRemaining, null);
  assert.equal(result.rows[1].data.agreed, null);
  assert.ok(codes(result.rows[0]).includes('UNKNOWN_FINANCE'));
  assert.equal(result.summary.perCurrency.SAR.openingReceivable, '0.00');
  assert.equal(result.summary.perCurrency.SAR.unknownFinanceCount, 1);
  assert.equal(result.rows[0].status, 'review_required');
});

test('import preview: exact decimal arithmetic and conflicting supplied remainder', () => {
  const result = preview('1,مريض,SAR,9999999999999999.99,0.01,9999999999999999.98,,\n2,مريض,SAR,1000,400,1000,,');
  assert.equal(result.rows[0].data.calculatedRemaining, '9999999999999999.98');
  assert.equal(result.rows[1].status, 'rejected');
  assert.ok(codes(result.rows[1]).includes('REMAINDER_CONFLICT'));
  assert.equal(result.summary.perCurrency.SAR.openingReceivable, '9999999999999999.98');
});

test('import preview: negative historical paid, fractional cents and localized numbers need correction', () => {
  const result = preview('1,مريض,SAR,100,-1,101,,\n2,مريض,SAR,100.001,0,100,,\n3,مريض,SAR,١٠٠,0,100,,');
  assert.equal(result.summary.rejectedRows, 3);
  assert.ok(result.rows.every(row => codes(row).includes('INVALID_AMOUNT')));
  assert.equal(result.summary.perCurrency.SAR.rowCount, 0);
});

test('import preview: historic overpayment is patient credit, not negative cash or debt', () => {
  const result = preview('1,مريض,SAR,100,120,-20,,');
  assert.equal(result.rows[0].data.calculatedRemaining, '-20.00');
  assert.equal(result.summary.perCurrency.SAR.openingReceivable, '0.00');
  assert.equal(result.summary.perCurrency.SAR.historicalCredit, '20.00');
  assert.equal(result.summary.rejectedRows, 0);
});

test('import preview: duplicates block BOTH rows, currency remains part of source identity', () => {
  const result = preview('1,مريض,SAR,100,0,100,,\n1,مريض,SAR,100,0,100,,\n1,مريض,USD,100,0,100,,');
  assert.equal(result.summary.rejectedRows, 2);
  assert.ok(codes(result.rows[0]).includes('SOURCE_DUPLICATE'));
  assert.ok(codes(result.rows[1]).includes('SOURCE_DUPLICATE'));
  assert.equal(result.rows[2].status, 'review_required');
});

test('import preview: known equivalent source references and file hashes block re-import', () => {
  const reference = { sourceSystem: 'desktop', sourceRecordId:'1', currency:'SAR' };
  const one = preview('1,مريض,SAR,100,0,100,,', { existingSources: [reference] });
  assert.ok(codes(one.rows[0]).includes('SOURCE_ALREADY_KNOWN'));
  const two = preview('changed-id,مريض,SAR,100,0,100,,', { existingFileHashes: [hash.toUpperCase()] });
  assert.equal(two.repeatedFile, true);
  assert.equal(two.summary.rejectedRows, 1);
  assert.ok(codes(two.rows[0]).includes('FILE_ALREADY_KNOWN'));
});

test('import preview: same phone never auto-deduplicates, exact file numbers only propose human review', () => {
  const result = preview('1,مريض أول,SAR,100,0,100,0123,777\n2,مريض ثان,SAR,200,0,200,123,777\n3,مريض ثالث,SAR,300,0,300,,777', {
    identityCandidates: [{fileNumber:'0123',patientId:'p-1'}, {fileNumber:'0123',patientId:'p-2'}, {fileNumber:'999',patientId:'p-3'}],
  });
  assert.deepEqual(result.rows.map(x => x.candidates), [['p-1','p-2'],[],[]]);
  assert.ok(result.rows.every(x => x.canAutoMerge === false));
  assert.equal(result.summary.rejectedRows, 0);
  assert.ok(codes(result.rows[0]).includes('IDENTITY_REVIEW'));
});

test('import preview: totals stay per-currency and do not add mixed money', () => {
  const result = preview('1,مريض,YER,1000,100,900,,\n2,مريض,SAR,200,50,150,,\n3,مريض,USD,300,100,200,,');
  assert.deepEqual(Object.fromEntries(Object.entries(result.summary.perCurrency).map(([c,b]) => [c,b.openingReceivable])), {YER:'900.00',SAR:'150.00',USD:'200.00'});
  assert.equal(Object.hasOwn(result.summary, 'grandTotal'), false);
});

test('import preview: row errors have bilingual safe codes without interpolated patient data', () => {
  const result = preview(',اسم سري,ريال,100,0,100,,\n2,اسم سري,SAR,100,0,100');
  assert.ok(codes(result.rows[0]).includes('REQUIRED_SOURCE_ID'));
  assert.ok(codes(result.rows[0]).includes('INVALID_CURRENCY'));
  assert.ok(codes(result.rows[1]).includes('ROW_WIDTH'));
  for (const row of result.rows) for (const error of row.issues) {
    assert.ok(error.messageEn && error.messageAr && error.code);
    assert.equal(JSON.stringify(error).includes('اسم سري'), false);
  }
});

test('import preview: pre-parsed records (XLSX path) flow through the same row logic', () => {
  const records = [
    { line: 1, cells: ['sourceRecordId', 'fullName', 'currency', 'agreed', 'previouslyPaid', 'remaining', 'fileNumber', 'phone'] },
    { line: 5, cells: ['xl-1', 'مريض ورقة عمل', 'SAR', '800', '300', '500', '0777', '777 000 111'] },
    { line: 9, cells: ['xl-2', 'مريض ثان', 'SAR', '?,?,0', '', '', '', ''] },
  ];
  const result = previewLegacyImport({ records, sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en });
  assert.equal(result.summary.totalRows, 2);
  assert.equal(result.rows[0].sourceLine, 5);
  assert.equal(result.rows[0].data.calculatedRemaining, '500.00');
  // Records path keeps the same human-review semantics as the CSV path.
  const matched = previewLegacyImport({ records: records.slice(0, 2), sourceSystem: 'desktop', fileHash: hash,
    headerMap: IMPORT_HEADERS.en, identityCandidates: [{ fileNumber: '0777', patientId: 'p-x' }] });
  assert.deepEqual(matched.rows[0].candidates, ['p-x']);
});

test('import preview: records path enforces bounds and shape without parsing csv', () => {
  const headerRow = { line: 1, cells: ['sourceRecordId', 'fullName', 'currency', 'agreed', 'previouslyPaid', 'remaining', 'fileNumber', 'phone'] };
  assert.throws(() => previewLegacyImport({ records: [headerRow], sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en }), /EMPTY_FILE/);
  assert.throws(() => previewLegacyImport({ records: 'nope', sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en }), /INVALID_OPTIONS/);
  const bad = { ...headerRow, cells: 'nope' };
  assert.throws(() => previewLegacyImport({ records: [headerRow, bad], sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en }), /INVALID_OPTIONS/);
  const tooWide = { line: 2, cells: Array.from({ length: 65 }, () => 'x') };
  assert.throws(() => previewLegacyImport({ records: [headerRow, tooWide], sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en }), /INVALID_OPTIONS/);
  const many = [headerRow, ...Array.from({ length: 10001 }, (_, i) => ({ line: i + 2, cells: [`r${i}`, 'اسم مقبول', 'SAR', '1', '0', '1', '', ''] }))];
  assert.throws(() => previewLegacyImport({ records: many, sourceSystem: 'desktop', fileHash: hash, headerMap: IMPORT_HEADERS.en }), /ROW_LIMIT/);
});

test('import preview: normalized phone candidates propose review without merging', () => {
  const result = preview('1,مريض أول,SAR,100,0,100,,777-000-001\n2,مريض ثان,SAR,200,0,200,0500,777000002', {
    identityCandidates: [{ phone: '777 (000) 001', patientId: 'p-1' }, { phone: '777-000-003', patientId: 'p-2' }, { fileNumber: '0500', patientId: 'p-3' }],
  });
  assert.deepEqual(result.rows.map(x => x.candidates), [['p-1'], ['p-3']]);
  assert.ok(result.rows.every(x => x.canAutoMerge === false));
  assert.equal(result.summary.rejectedRows, 0);
  // A candidate reference with neither file number nor phone is a caller bug.
  assert.throws(() => preview('1,مريض,SAR,100,0,100,,', { identityCandidates: [{ patientId: 'p-9' }] }), /INVALID_OPTIONS/);
});
