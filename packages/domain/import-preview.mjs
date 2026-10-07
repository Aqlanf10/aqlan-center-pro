// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Pure dry-run only. Never writes patients, cash, balances or source records.
import { minor, decimal, currency } from './money.mjs';

export const IMPORT_HEADERS = Object.freeze({
  en: Object.freeze({ sourceRecordId: 'sourceRecordId', fullName: 'fullName', currency: 'currency', agreed: 'agreed', previouslyPaid: 'previouslyPaid', remaining: 'remaining', fileNumber: 'fileNumber', phone: 'phone' }),
  ar: Object.freeze({ sourceRecordId: 'معرف المصدر', fullName: 'اسم المريض', currency: 'العملة', agreed: 'المتفق عليه', previouslyPaid: 'المدفوع سابقا', remaining: 'المتبقي', fileNumber: 'رقم الملف', phone: 'الهاتف' }),
});
const LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxRows: 10000, maxColumns: 64, maxCellLength: 10000 });
const MESSAGES = {
  INVALID_CSV: ['Malformed CSV quoting.', 'صياغة اقتباس CSV غير صحيحة.'],
  FILE_LIMIT: ['File exceeds the preview size limit.', 'الملف يتجاوز حد حجم المعاينة.'],
  ROW_LIMIT: ['File exceeds the row limit.', 'الملف يتجاوز عدد الصفوف المسموح.'],
  COLUMN_LIMIT: ['Row exceeds the column limit.', 'الصف يتجاوز عدد الأعمدة المسموح.'],
  CELL_LIMIT: ['Cell exceeds the text length limit.', 'الخلية تتجاوز طول النص المسموح.'],
  INVALID_OPTIONS: ['Invalid explicit import configuration.', 'إعدادات الاستيراد الصريحة غير صحيحة.'],
  EMPTY_FILE: ['File has no data rows.', 'الملف لا يحتوي صفوف بيانات.'],
  INVALID_HEADERS: ['Mapped headers are missing, duplicated or ambiguous.', 'الأعمدة المحددة مفقودة أو مكررة أو ملتبسة.'],
  ROW_WIDTH: ['Column count does not match the header.', 'عدد أعمدة الصف لا يطابق العناوين.'],
  REQUIRED_SOURCE_ID: ['A source record identifier is required.', 'معرف السجل في المصدر مطلوب.'],
  REQUIRED_NAME: ['A patient name of 2–200 characters is required.', 'اسم المريض مطلوب بطول من 2 إلى 200 حرف.'],
  INVALID_CURRENCY: ['Currency needs an explicit supported mapping.', 'العملة تحتاج ربطا صريحا بعملة مدعومة.'],
  INVALID_AMOUNT: ['Amount must be an exact decimal with at most two fraction digits.', 'المبلغ يجب أن يكون عشريا دقيقا بمنزلتين كحد أقصى.'],
  UNKNOWN_FINANCE: ['Unknown agreement or historical payment requires evidence review.', 'المتفق عليه أو المدفوع السابق غير معروف ويحتاج مراجعة الإثبات.'],
  REMAINDER_CONFLICT: ['Supplied remainder differs from agreed less previously paid.', 'المتبقي المقدم لا يساوي المتفق عليه ناقص المدفوع السابق.'],
  SOURCE_DUPLICATE: ['Source identity and currency repeat within this file.', 'هوية المصدر والعملة مكررتان داخل الملف.'],
  SOURCE_ALREADY_KNOWN: ['This source identity and currency already exist in known references.', 'هوية المصدر والعملة موجودتان في المراجع السابقة.'],
  FILE_ALREADY_KNOWN: ['This supplied file hash was previously registered.', 'بصمة الملف المقدمة مسجلة سابقا.'],
  IDENTITY_REVIEW: ['Exact file-number candidates require human confirmation; no automatic merge.', 'مرشحو رقم الملف المطابق يحتاجون تأكيدا بشريا؛ لا دمج تلقائي.'],
};
function issue(code, field, severity = 'error') {
  return { code, severity, ...(field ? { field } : {}), messageEn: MESSAGES[code][0], messageAr: MESSAGES[code][1] };
}
function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.issue = issue(code);
  throw error;
}
function limits(options = {}) {
  const result = { ...LIMITS };
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS');
  for (const [key, value] of Object.entries(options)) {
    if (!(key in LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) fail('INVALID_OPTIONS');
    result[key] = value;
  }
  return result;
}

/** Strict RFC-style CSV parser with bounded allocation and physical start-line numbers. */
export function parseImportCsv(text, { delimiter = ',', ...requestedLimits } = {}) {
  const bounds = limits(requestedLimits);
  if (typeof text !== 'string' || ![',', ';', '\t'].includes(delimiter)) fail('INVALID_OPTIONS');
  if (text.length > bounds.maxBytes || new TextEncoder().encode(text).length > bounds.maxBytes) fail('FILE_LIMIT');
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const records = [];
  let cells = [], cell = '', state = 'start', line = 1, startLine = 1, touched = false;
  function append(char) {
    cell += char;
    if (cell.length > bounds.maxCellLength) fail('CELL_LIMIT');
  }
  function endCell() {
    cells.push(cell);
    if (cells.length > bounds.maxColumns) fail('COLUMN_LIMIT');
    cell = ''; state = 'start';
  }
  function endRecord() {
    endCell();
    // Physically blank lines are ignored. Delimiter-only rows remain visible errors.
    if (touched || cells.length > 1 || cells[0] !== '') {
      records.push({ line: startLine, cells });
      if (records.length > bounds.maxRows + 1) fail('ROW_LIMIT');
    }
    cells = []; touched = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { append('"'); i++; } else state = 'closed';
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        append('\n'); line++;
      } else append(char);
      continue;
    }
    if (char === delimiter) { touched = true; endCell(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRecord(); line++; startLine = line; continue;
    }
    if (state === 'closed') fail('INVALID_CSV');
    touched = true;
    if (char === '"') {
      if (state !== 'start') fail('INVALID_CSV');
      state = 'quoted';
    } else { state = 'unquoted'; append(char); }
  }
  if (state === 'quoted') fail('INVALID_CSV');
  if (touched || cells.length || cell.length) endRecord();
  return records;
}
const sourceKey = ref => JSON.stringify([ref.sourceSystem, ref.recordType ?? 'legacy_plan', ref.sourceRecordId, ref.currency]);
const signedDecimal = value => value < 0n ? `-${decimal(-value)}` : decimal(value);
function normalizedAmount(raw, signed = false) {
  if (signed && raw.startsWith('-')) return signedDecimal(-minor(raw.slice(1)));
  return decimal(minor(raw));
}
function signedMinor(value) { return value.startsWith('-') ? -minor(value.slice(1)) : minor(value); }
// The bounded normalized phone form is what candidate matching compares; the
// human-readable legacy string stays on the record untouched.
export function normalizeImportPhone(phone) {
  if (phone === null || phone === '') return null;
  const trimmed = String(phone).replace(/[\s\-().]/g, '');
  if (!trimmed || trimmed.length > 40) return null;
  return trimmed;
}

/**
 * fileHash is a caller-supplied SHA-256 identity, NOT cryptographically verified here.
 * headerMap maps canonical field names to exact source headers; no fuzzy guessing.
 * Input is either `csv` (+delimiter) parsed here, or pre-parsed `records`
 * ({line,cells}) produced by parseImportXlsx — both flow through one row logic.
 * existingSources must include equivalent source identities discovered across Mini/desktop.
 * identityCandidates propose human review only: exact legacy file numbers and
 * normalized phone matches. Matching never merges identities or money.
 * A clear preview still requires explicit human approval and a separate atomic importer.
 */
export function previewLegacyImport({ csv, records, fileHash, sourceSystem, headerMap, currencyMap = {},
  existingSources = [], existingFileHashes = [], identityCandidates = [], unknownTokens = ['', '?', 'غير معروف'],
  delimiter = ',', limits: requestedLimits = {} } = {}) {
  if (typeof fileHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(fileHash) ||
      typeof sourceSystem !== 'string' || !sourceSystem.trim() || sourceSystem.length > 100 ||
      !headerMap || typeof headerMap !== 'object' || Array.isArray(headerMap) ||
      !currencyMap || typeof currencyMap !== 'object' || Array.isArray(currencyMap) ||
      !Array.isArray(unknownTokens) || unknownTokens.some(x => typeof x !== 'string') ||
      !Array.isArray(existingSources) || !Array.isArray(existingFileHashes) || !Array.isArray(identityCandidates) ||
      existingSources.length > 100000 || existingFileHashes.length > 100000 || identityCandidates.length > 100000) fail('INVALID_OPTIONS');
  const bounds = limits(requestedLimits);
  const allowedFields = Object.keys(IMPORT_HEADERS.en);
  if (Object.entries(headerMap).some(([field, header]) => !allowedFields.includes(field) || typeof header !== 'string' || !header.trim()) ||
      ['sourceRecordId', 'fullName', 'currency'].some(field => !headerMap[field])) fail('INVALID_HEADERS');
  let parsed;
  const fromRecords = records !== undefined;
  if (fromRecords) {
    if (!Array.isArray(records) || records.length < 2) fail(records === null || typeof records !== 'object' ? 'INVALID_OPTIONS' : 'EMPTY_FILE');
    if (records.length > bounds.maxRows + 1) fail('ROW_LIMIT');
    parsed = records.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Array.isArray(record.cells) ||
          record.cells.length > bounds.maxColumns || record.cells.some(c => typeof c !== 'string' || c.length > bounds.maxCellLength)) fail('INVALID_OPTIONS');
      return { line: Number.isSafeInteger(record.line) && record.line > 0 ? record.line : index + 1, cells: record.cells };
    });
  } else {
    parsed = parseImportCsv(csv, { delimiter, ...requestedLimits });
  }
  if (parsed.length < 2) fail('EMPTY_FILE');
  const headers = parsed.shift().cells.map(x => x.trim());
  // XLSX writers omit trailing empty cells, so a short record is empty padding
  // in Excel semantics, not a ragged row. CSV rows stay strict: a real width
  // mismatch there remains a ROW_WIDTH verdict.
  if (fromRecords) {
    parsed = parsed.map(record => record.cells.length >= headers.length ? record
      : { ...record, cells: [...record.cells, ...Array.from({ length: headers.length - record.cells.length }, () => '')] });
  }
  const indices = {};
  for (const [field, header] of Object.entries(headerMap)) {
    const matches = headers.flatMap((value, index) => value === header.trim() ? [index] : []);
    if (matches.length !== 1 || Object.values(indices).includes(matches[0])) fail('INVALID_HEADERS');
    indices[field] = matches[0];
  }
  if (new Set(headers).size !== headers.length) fail('INVALID_HEADERS');
  const knownKeys = new Set();
  for (const ref of existingSources) {
    if (!ref || typeof ref.sourceSystem !== 'string' || typeof ref.sourceRecordId !== 'string' ||
        !ref.sourceSystem.trim() || !ref.sourceRecordId.trim() || !['YER', 'SAR', 'USD'].includes(ref.currency) ||
        (ref.recordType !== undefined && typeof ref.recordType !== 'string')) fail('INVALID_OPTIONS');
    knownKeys.add(sourceKey({ ...ref, sourceSystem: ref.sourceSystem.trim(), sourceRecordId: ref.sourceRecordId.trim() }));
  }
  // Candidate maps: exact legacy file numbers and normalized phone strings
  // both propose the same human review decision; neither ever merges silently.
  const candidateFiles = new Map();
  const candidatePhones = new Map();
  for (const ref of identityCandidates) {
    if (!ref || typeof ref.patientId !== 'string' || !ref.patientId) fail('INVALID_OPTIONS');
    const fileNumber = typeof ref.fileNumber === 'string' ? ref.fileNumber : '';
    const phone = typeof ref.phone === 'string' ? normalizeImportPhone(ref.phone) : null;
    if (!fileNumber && !phone) fail('INVALID_OPTIONS');
    if (fileNumber) {
      const ids = candidateFiles.get(fileNumber) ?? new Set();
      ids.add(ref.patientId); candidateFiles.set(fileNumber, ids);
    }
    if (phone) {
      const ids = candidatePhones.get(phone) ?? new Set();
      ids.add(ref.patientId); candidatePhones.set(phone, ids);
    }
  }
  if (existingFileHashes.some(hash => typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash))) fail('INVALID_OPTIONS');
  const normalizedHash = fileHash.toLowerCase();
  const repeatedFile = existingFileHashes.some(hash => hash.toLowerCase() === normalizedHash);
  const unknown = new Set(unknownTokens.map(x => x.trim())); unknown.add('');
  const seen = new Map();
  const rows = parsed.map((record, index) => {
    const issues = [];
    const value = field => indices[field] === undefined ? '' : (record.cells[indices[field]] ?? '').trim();
    if (record.cells.length !== headers.length) issues.push(issue('ROW_WIDTH'));
    const data = { sourceSystem: sourceSystem.trim(), recordType: 'legacy_plan', sourceRecordId: value('sourceRecordId'),
      fullName: value('fullName'), fileNumber: value('fileNumber') || null, phone: value('phone') || null,
      currency: null, agreed: null, previouslyPaid: null, suppliedRemaining: null, calculatedRemaining: null };
    if (!data.sourceRecordId || data.sourceRecordId.length > 200) issues.push(issue('REQUIRED_SOURCE_ID', 'sourceRecordId'));
    if (data.fullName.length < 2 || data.fullName.length > 200) issues.push(issue('REQUIRED_NAME', 'fullName'));
    const rawCurrency = value('currency');
    try { data.currency = currency(Object.hasOwn(currencyMap, rawCurrency) ? currencyMap[rawCurrency] : rawCurrency); }
    catch { issues.push(issue('INVALID_CURRENCY', 'currency')); }
    for (const [field, target] of [['agreed', 'agreed'], ['previouslyPaid', 'previouslyPaid'], ['remaining', 'suppliedRemaining']]) {
      const raw = value(field);
      if (!unknown.has(raw)) {
        try { data[target] = normalizedAmount(raw, field === 'remaining'); }
        catch { issues.push(issue('INVALID_AMOUNT', field)); }
      }
    }
    if (data.agreed === null || data.previouslyPaid === null) issues.push(issue('UNKNOWN_FINANCE', undefined, 'warning'));
    else {
      data.calculatedRemaining = signedDecimal(minor(data.agreed) - minor(data.previouslyPaid));
      if (data.suppliedRemaining !== null && data.suppliedRemaining !== data.calculatedRemaining) issues.push(issue('REMAINDER_CONFLICT', 'remaining'));
    }
    const rowPhone = normalizeImportPhone(data.phone);
    const candidateIds = new Set();
    if (data.fileNumber) for (const id of candidateFiles.get(data.fileNumber) ?? []) candidateIds.add(id);
    if (rowPhone) for (const id of candidatePhones.get(rowPhone) ?? []) candidateIds.add(id);
    const candidates = [...candidateIds];
    if (candidates.length) issues.push(issue('IDENTITY_REVIEW', 'fileNumber', 'warning'));
    const row = { rowNumber: index + 1, sourceLine: record.line, data, candidates, issues, status: 'review_required', canAutoMerge: false };
    if (data.sourceRecordId && data.currency) {
      const key = sourceKey(data);
      if (knownKeys.has(key)) issues.push(issue('SOURCE_ALREADY_KNOWN', 'sourceRecordId'));
      if (seen.has(key)) {
        issues.push(issue('SOURCE_DUPLICATE', 'sourceRecordId'));
        const earlier = seen.get(key);
        if (!earlier.issues.some(x => x.code === 'SOURCE_DUPLICATE')) earlier.issues.push(issue('SOURCE_DUPLICATE', 'sourceRecordId'));
      } else seen.set(key, row);
    }
    if (repeatedFile) issues.push(issue('FILE_ALREADY_KNOWN'));
    return row;
  });
  // Aggregate only rows without blocking errors. Unknown amounts are counted, never zero-filled.
  const buckets = Object.fromEntries(['YER', 'SAR', 'USD'].map(code => [code, { rowCount: 0, knownAgreementCount: 0, knownPreviousPaymentCount: 0, knownOpeningCount: 0, unknownFinanceCount: 0,
    agreed: 0n, previouslyPaid: 0n, openingReceivable: 0n, historicalCredit: 0n }]));
  let rejectedRows = 0;
  for (const row of rows) {
    if (row.issues.some(x => x.severity === 'error')) { row.status = 'rejected'; rejectedRows++; continue; }
    const bucket = buckets[row.data.currency]; bucket.rowCount++;
    if (row.data.agreed !== null) { bucket.agreed += minor(row.data.agreed); bucket.knownAgreementCount++; }
    if (row.data.previouslyPaid !== null) { bucket.previouslyPaid += minor(row.data.previouslyPaid); bucket.knownPreviousPaymentCount++; }
    if (row.data.calculatedRemaining === null) bucket.unknownFinanceCount++;
    else {
      bucket.knownOpeningCount++;
      const remainder = signedMinor(row.data.calculatedRemaining);
      if (remainder >= 0n) bucket.openingReceivable += remainder; else bucket.historicalCredit -= remainder;
    }
  }
  const perCurrency = Object.fromEntries(Object.entries(buckets).map(([code, bucket]) => [code,
    Object.fromEntries(Object.entries(bucket).map(([key, value]) => [key, typeof value === 'bigint' ? decimal(value) : value]))]));
  return { mode: 'preview_only', fileHash: normalizedHash, fileHashVerified: false, requiresHumanApproval: true,
    repeatedFile, rows, summary: { totalRows: rows.length, rejectedRows, reviewRequiredRows: rows.length - rejectedRows, perCurrency } };
}
