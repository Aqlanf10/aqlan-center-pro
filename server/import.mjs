// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Legacy import staging (IMP-01..03). The pure domain preview decides row
// verdicts; this module persists them, supplies durable dedup references
// (committed legacy plans + other staged batches), and drives the resumable
// commit through clinic.import_commit_rows. It never invents money or merges
// identities: file numbers stay legacy references and attachment to an
// existing patient is always an explicit operator decision.
import { previewLegacyImport, parseImportCsv, normalizeImportPhone } from '../packages/domain/import-preview.mjs';
import { parseImportXlsx as parseWorkbook } from '../packages/domain/import-xlsx.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DELIMITERS = [',', ';', '\t'];
const FAIL = (status, code) => { throw Object.assign(new Error(code), { status }); };
const MESSAGES = {
  INVALID_STAGE_INPUT: ['Staged import configuration is invalid.', 'إعدادات الاستيراد المُرحَّل غير صحيحة.'],
  UNKNOWN_SPECIALTY: ['The chosen specialty is not configured.', 'التخصص المختار غير معرّف.'],
  FUTURE_OPENING_DATE: ['The opening statement date cannot be in the future.', 'تاريخ كشف الافتتاحي لا يمكن أن يكون مستقبليا.'],
  BATCH_NOT_FOUND: ['Import batch not found.', 'دفعة الاستيراد غير موجودة.'],
  BATCH_NOT_ACTIVE: ['This import batch is no longer active.', 'دفعة الاستيراد لم تعد نشطة.'],
  FILE_ALREADY_KNOWN: ['This supplied file hash was previously registered.', 'بصمة الملف المقدمة مسجلة سابقا.'],
  INVALID_DECISIONS: ['Approval decisions are invalid.', 'قرارات الاعتماد غير صحيحة.'],
  ROW_NOT_FOUND: ['Imported row not found.', 'صف الاستيراد غير موجود.'],
  ROW_REJECTED: ['Rejected rows can never be approved.', 'الصفوف المرفوضة لا يمكن اعتمادها أبدا.'],
  EVIDENCE_REQUIRED: ['Unknown historical amounts need evidence review first.', 'المبالغ التاريخية غير المعروفة تحتاج مراجعة إثبات أولا.'],
  ROW_ALREADY_IMPORTED: ['This row was already imported.', 'هذا الصف مستورد سابقا.'],
  ROW_FAILED: ['This row failed; see the exception report.', 'فشل هذا الصف؛ راجع تقرير الاستثناء.'],
  ATTACH_PATIENT_NOT_FOUND: ['The attached patient does not exist in this branch.', 'المريض المرفق غير موجود في هذا الفرع.'],
  IMPORT_FAILED: ['Import failed; see the exception report.', 'فشل الاستيراد؛ راجع تقرير الاستثناء.'],
};
const errorFrom = e => {
  if (e?.issue?.code) return Object.assign(new Error(e.issue.code), { status: 400, messageAr: e.issue.messageAr, messageEn: e.issue.messageEn });
  const code = /^[A-Z_]+$/.test(e.message || '') ? e.message : 'IMPORT_FAILED';
  return Object.assign(new Error(code), { status: 400, messageAr: MESSAGES[code]?.[1], messageEn: MESSAGES[code]?.[0] });
};

export function importApi({ db, now = () => Date.now() }) {
  const rowStatus = (row) => {
    if (row.issues.some(x => x.severity === 'error')) return 'rejected';
    if (row.data.agreed === null || row.data.previouslyPaid === null) return 'needs_evidence';
    return 'staged';
  };
  // Authoritative header/sample extraction for the mapping screen: the client
  // never parses the file itself, so client-side quirks cannot produce a wrong
  // map. This is a pre-mapping verb: only the file payload is required — the
  // full stage contract (names, hash, maps, statement date) applies to stage().
  async function parse(actor, branch, input) {
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'patient.write']);
    if (!input || typeof input !== 'object' || Array.isArray(input)) FAIL(400, 'INVALID_STAGE_INPUT');
    const format = input.format === undefined ? 'csv' : input.format;
    if (format !== 'csv' && format !== 'xlsx') FAIL(400, 'INVALID_STAGE_INPUT');
    const delimiter = input.delimiter === undefined ? ',' : input.delimiter;
    const dataBase64 = typeof input.dataBase64 === 'string' ? input.dataBase64 : '';
    if (format === 'csv' && !DELIMITERS.includes(delimiter)) FAIL(400, 'INVALID_STAGE_INPUT');
    if (format === 'xlsx' && (!dataBase64 || dataBase64.length > 7 * 1024 * 1024)) FAIL(400, 'INVALID_STAGE_INPUT');
    try {
      const records = format === 'xlsx' ? parseWorkbook(decodeBase64(dataBase64)) : parseImportCsv(typeof input.csv === 'string' ? input.csv : '', { delimiter });
      if (records.length < 2) FAIL(400, 'EMPTY_FILE');
      return { headers: records[0].cells.map(x => x.trim()), samples: records.slice(1, 4).map(r => r.cells), format };
    } catch (e) { throw errorFrom(e); }
  }
  async function stage(actor, branch, input) {
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'patient.write']);
    const { format, sourceSystem, fileName, fileHash, csv, delimiter, dataBase64, headerMap, currencyMap, defaultSpecialty, asOfDate } = parseInput(input);
    if (!/^[a-z0-9_-]{1,50}$/.test(defaultSpecialty)) FAIL(400, 'INVALID_STAGE_INPUT');
    if (!DATE.test(asOfDate)) FAIL(400, 'INVALID_STAGE_INPUT');
    const specialty = await db.query('SELECT 1 FROM clinic.specialty WHERE code=$1', [defaultSpecialty]);
    if (!specialty.rows.length) FAIL(400, 'UNKNOWN_SPECIALTY');
    const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Aden')::date::text AS d")).rows[0].d;
    if (asOfDate > today) FAIL(400, 'FUTURE_OPENING_DATE');
    // Durable references the domain preview needs: every legacy source identity
    // already committed, every source identity staged in an active batch, and
    // every non-cancelled file hash of this branch.
    const knownSources = (await db.query(
      `SELECT source_system AS "sourceSystem",source_record_id AS "sourceRecordId",currency FROM clinic.plan WHERE branch_id=$1 AND origin='legacy'
       UNION ALL
       SELECT b.source_system AS "sourceSystem",r.source_record_id AS "sourceRecordId",r.currency FROM clinic.import_row r
       JOIN clinic.import_batch b ON b.id=r.batch_id
       WHERE b.branch_id=$1 AND b.status='staged' AND r.status IN ('staged','needs_evidence')`, [branch])).rows;
    const knownHashes = (await db.query(
      "SELECT file_hash FROM clinic.import_batch WHERE branch_id=$1 AND status<>'cancelled'", [branch])).rows.map(r => r.file_hash);
    // Candidate proposals (MIG-03): exact legacy file numbers already imported
    // into this branch, plus normalized phone matches. Both are advisory only;
    // the operator attaches or creates per row during approval.
    const candidateRefs = (await db.query(
      `SELECT r.legacy_file_number AS "fileNumber",NULL::text AS phone,r.patient_id::text AS "patientId",p.full_name AS "fullName"
         FROM clinic.import_row r
         JOIN clinic.import_batch b ON b.id=r.batch_id
         JOIN clinic.patient p ON p.id=r.patient_id
        WHERE b.branch_id=$1 AND r.status='imported' AND r.legacy_file_number IS NOT NULL AND r.patient_id IS NOT NULL
        UNION ALL
       SELECT NULL::text,p.phone::text,p.id::text,p.full_name
         FROM clinic.patient p
         JOIN clinic.patient_branch pb ON pb.patient_id=p.id AND pb.branch_id=$1
        WHERE p.phone IS NOT NULL
        LIMIT 20000`, [branch])).rows;
    const candidateNames = new Map();
    const identityCandidates = [];
    for (const ref of candidateRefs) {
      // Phones that do not survive normalization (empty, overlong) carry no
      // identity signal and must not reach the preview as empty proposals.
      if (ref.fileNumber !== null && ref.fileNumber !== '') {
        candidateNames.set(ref.patientId, ref.fullName);
        identityCandidates.push({ fileNumber: ref.fileNumber, patientId: ref.patientId });
      } else if (ref.phone !== null) {
        const normalized = normalizeImportPhone(ref.phone);
        if (normalized) {
          candidateNames.set(ref.patientId, ref.fullName);
          identityCandidates.push({ phone: normalized, patientId: ref.patientId });
        }
      }
    }
    let preview;
    try {
      preview = previewLegacyImport({ csv: format === 'xlsx' ? undefined : csv,
        records: format === 'xlsx' ? parseWorkbook(decodeBase64(dataBase64)) : undefined,
        fileHash, sourceSystem, headerMap, currencyMap, delimiter, existingSources: knownSources, existingFileHashes: knownHashes,
        identityCandidates });
    } catch (e) { throw errorFrom(e); }
    // The identical bytes are already staged or approved in this branch: block
    // the re-upload outright instead of persisting a wholly rejected batch.
    if (preview.repeatedFile) FAIL(409, 'FILE_ALREADY_KNOWN');
    const statuses = preview.rows.map(rowStatus);
    const counts = { staged: 0, needs_evidence: 0, rejected: 0 };
    for (const s of statuses) counts[s]++;
    const batchId = (await db.query(
      `INSERT INTO clinic.import_batch(branch_id,created_by,source_system,file_name,file_hash,
        default_specialty,as_of_date,header_map,currency_map,row_count,staged_rows,evidence_rows,rejected_rows,per_currency)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [branch, actor, sourceSystem, fileName, preview.fileHash, defaultSpecialty, asOfDate,
        JSON.stringify(headerMap), JSON.stringify(currencyMap), preview.rows.length,
        counts.staged, counts.needs_evidence, counts.rejected, JSON.stringify(preview.summary.perCurrency)])).rows[0].id;
    // Column-wise unnest keeps one bounded statement for up to 10k rows.
    const cols = {
      line: preview.rows.map(r => r.sourceLine), status: statuses,
      data: preview.rows.map(r => JSON.stringify(r.data)), sourceRecordId: preview.rows.map(r => r.data.sourceRecordId),
      currency: preview.rows.map(r => r.data.currency), agreed: preview.rows.map(r => r.data.agreed),
      previouslyPaid: preview.rows.map(r => r.data.previouslyPaid), suppliedRemaining: preview.rows.map(r => r.data.suppliedRemaining),
      fullName: preview.rows.map(r => r.data.fullName), phone: preview.rows.map(r => normalizeImportPhone(r.data.phone)),
      fileNumber: preview.rows.map(r => r.data.fileNumber),
      issues: preview.rows.map(r => JSON.stringify(r.issues)),
      candidates: preview.rows.map(r => JSON.stringify((r.candidates || []).map(id => ({
        patientId: id, fullName: candidateNames.get(id) ?? null,
        matchedBy: r.data.fileNumber ? 'fileNumber' : 'phone' })))),
    };
    await db.query(
      `INSERT INTO clinic.import_row(batch_id,line,status,data,source_record_id,currency,agreed,previously_paid,
        supplied_remaining,full_name,phone,legacy_file_number,issues,candidates)
       SELECT $1,x.line,x.status,x.data::jsonb,x.source_record_id,x.currency,x.agreed::numeric,x.previously_paid::numeric,
        x.supplied_remaining::numeric,x.full_name,x.phone,x.file_number,x.issues::jsonb,x.candidates::jsonb
       FROM unnest($2::int[],$3::text[],$4::jsonb[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[],$12::text[],$13::jsonb[],$14::jsonb[])
       AS x(line,status,data,source_record_id,currency,agreed,previously_paid,supplied_remaining,full_name,phone,file_number,issues,candidates)`,
      [batchId, cols.line, cols.status, cols.data, cols.sourceRecordId, cols.currency, cols.agreed,
        cols.previouslyPaid, cols.suppliedRemaining, cols.fullName, cols.phone, cols.fileNumber, cols.issues, cols.candidates]);
    return { batchId, summary: preview.summary, repeatedFile: preview.repeatedFile };
  }
  async function list(actor, branch) {
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'patient.read']);
    const r = await db.query(
      `SELECT b.id,b.source_system,b.file_name,b.status,b.row_count,b.staged_rows,b.evidence_rows,b.rejected_rows,
        b.as_of_date::text AS as_of_date,b.per_currency,b.created_at,
        coalesce((SELECT count(*)::int FROM clinic.import_row x WHERE x.batch_id=b.id AND x.status='imported'),0) AS imported_rows
       FROM clinic.import_batch b WHERE b.branch_id=$1 ORDER BY b.created_at DESC,b.id LIMIT 50`, [branch]);
    return { batches: r.rows };
  }
  async function get(actor, branch, batchId, { status, limit, offset }) {
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'patient.read']);
    if (!UUID.test(batchId || '')) FAIL(404, 'BATCH_NOT_FOUND');
    const batch = (await db.query('SELECT * FROM clinic.import_batch WHERE id=$1 AND branch_id=$2', [batchId, branch])).rows[0];
    if (!batch) FAIL(404, 'BATCH_NOT_FOUND');
    if (status !== undefined && !['staged', 'needs_evidence', 'rejected', 'imported', 'failed'].includes(status)) FAIL(400, 'INVALID_STAGE_INPUT');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) FAIL(400, 'INVALID_STAGE_INPUT');
    const rows = (await db.query(
      `SELECT id,line,status,data,currency,agreed::text AS agreed,previously_paid::text AS previously_paid,
        supplied_remaining::text AS supplied_remaining,full_name,phone,legacy_file_number,issues,candidates,
        patient_id,plan_id,error_code
       FROM clinic.import_row WHERE batch_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY line LIMIT $3 OFFSET $4`, [batchId, status ?? null, limit, offset])).rows;
    return { batch, rows };
  }
  async function cancel(actor, branch, batchId) {
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'patient.write']);
    if (!UUID.test(batchId || '')) FAIL(404, 'BATCH_NOT_FOUND');
    const r = await db.query(
      "UPDATE clinic.import_batch SET status='cancelled' WHERE id=$1 AND branch_id=$2 AND status='staged' RETURNING id", [batchId, branch]);
    if (!r.rows.length) FAIL(409, 'BATCH_NOT_ACTIVE');
    return { ok: true };
  }
  // Approval walks the decisions row by row: each row commits in its own
  // statement-level transaction (patient+plan+journal together), a failing row
  // stays staged, and the batch finishes when nothing approvable remains.
  // Non-staged rows are reported without touching their state; rejected and
  // evidence rows can never be approved (IMP-03).
  async function approve(actor, branch, batchId, decisions) {
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'patient.write']);
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'clinical.write']);
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'finance.agree']);
    await db.query('SELECT clinic.require_permission($1,$2,$3)', [actor, branch, 'finance.opening']);
    if (!UUID.test(batchId || '')) FAIL(404, 'BATCH_NOT_FOUND');
    if (!Array.isArray(decisions) || !decisions.length || decisions.length > 10000 ||
        decisions.some(d => !d || typeof d !== 'object' || Array.isArray(d) ||
          typeof d.rowId !== 'string' || !UUID.test(d.rowId) ||
          (d.attachPatientId !== undefined && d.attachPatientId !== null && (!UUID.test(d.attachPatientId))))) FAIL(400, 'INVALID_DECISIONS');
    const batch = (await db.query('SELECT status FROM clinic.import_batch WHERE id=$1 AND branch_id=$2', [batchId, branch])).rows[0];
    if (!batch) FAIL(404, 'BATCH_NOT_FOUND');
    if (batch.status !== 'staged') FAIL(409, 'BATCH_NOT_ACTIVE');
    const known = (await db.query('SELECT id,status FROM clinic.import_row WHERE batch_id=$1 AND id=ANY($2)',
      [batchId, decisions.map(d => d.rowId)])).rows;
    const statusOf = new Map(known.map(r => [r.id, r.status]));
    let imported = 0; const failedRows = [];
    for (const decision of decisions) {
      const status = statusOf.get(decision.rowId);
      if (status !== 'staged') {
        const code = status === 'needs_evidence' ? 'EVIDENCE_REQUIRED'
          : status === 'rejected' ? 'ROW_REJECTED'
          : status === 'imported' ? 'ROW_ALREADY_IMPORTED'
          : status === 'failed' ? 'ROW_FAILED' : 'ROW_NOT_FOUND';
        failedRows.push({ rowId: decision.rowId, code });
        continue;
      }
      try {
        await db.query('SELECT clinic.import_commit_row($1,$2,$3,$4,$5)',
          [actor, branch, batchId, decision.rowId, decision.attachPatientId ?? null]);
        imported++;
      } catch (e) {
        // A permission failure or an inactive batch aborts the whole approval;
        // only row-scoped problems are recorded on the row.
        if (e?.code === '42501') throw e;
        const code = e?.code === '23505' && String(e?.message || '').includes('one_legacy_source') ? 'SOURCE_ALREADY_KNOWN'
          : /^[A-Z_]+$/.test(e?.message || '') ? e.message : 'IMPORT_FAILED';
        await db.query("UPDATE clinic.import_row SET status='failed',error_code=$2 WHERE id=$1 AND status='staged'", [decision.rowId, code]);
        failedRows.push({ rowId: decision.rowId, code });
      }
    }
    const tail = (await db.query(
      `SELECT (SELECT count(*) FROM clinic.import_row WHERE batch_id=$1 AND status IN ('staged','needs_evidence')) AS remaining,
              (SELECT status FROM clinic.import_batch WHERE id=$1) AS batch_status`, [batchId])).rows[0];
    // A late row failure (after the last successful commit) can leave zero
    // approvable rows; finalize the batch so reporting stays consistent.
    await db.query(
      `UPDATE clinic.import_batch SET status='approved',approved_by=$2,approved_at=now()
       WHERE id=$1 AND status='staged'
         AND NOT EXISTS(SELECT 1 FROM clinic.import_row WHERE batch_id=$1 AND status IN ('staged','needs_evidence'))`,
      [batchId, actor]);
    const final = (await db.query('SELECT status FROM clinic.import_batch WHERE id=$1', [batchId])).rows[0];
    return { imported, failed: failedRows.length, failedRows, remaining: Number(tail.remaining), batchStatus: final.status };
  }
  function parseInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) FAIL(400, 'INVALID_STAGE_INPUT');
    const format = input.format === undefined ? 'csv' : input.format;
    if (format !== 'csv' && format !== 'xlsx') FAIL(400, 'INVALID_STAGE_INPUT');
    const sourceSystem = typeof input.sourceSystem === 'string' ? input.sourceSystem.trim() : '';
    const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : '';
    const fileHash = typeof input.fileHash === 'string' ? input.fileHash.trim().toLowerCase() : '';
    const csv = typeof input.csv === 'string' ? input.csv : '';
    const delimiter = input.delimiter === undefined ? ',' : input.delimiter;
    const dataBase64 = typeof input.dataBase64 === 'string' ? input.dataBase64 : '';
    const headerMap = input.headerMap;
    const currencyMap = input.currencyMap === undefined ? {} : input.currencyMap;
    const defaultSpecialty = typeof input.defaultSpecialty === 'string' ? input.defaultSpecialty : '';
    const asOfDate = typeof input.asOfDate === 'string' ? input.asOfDate : '';
    if (!sourceSystem || sourceSystem.length > 100) FAIL(400, 'INVALID_STAGE_INPUT');
    if (!fileName || fileName.length > 200) FAIL(400, 'INVALID_STAGE_INPUT');
    if (!SHA256.test(fileHash)) FAIL(400, 'INVALID_STAGE_INPUT');
    if (format === 'xlsx' ? dataBase64.length > 7 * 1024 * 1024 : !DELIMITERS.includes(delimiter)) FAIL(400, 'INVALID_STAGE_INPUT');
    if (!defaultSpecialty || !DATE.test(asOfDate)) FAIL(400, 'INVALID_STAGE_INPUT');
    return { format, sourceSystem, fileName, fileHash, csv, delimiter, dataBase64, headerMap, currencyMap, defaultSpecialty, asOfDate };
  }
  // Base64 text is validated and bounded before decoding; the workbook parser
  // enforces the byte cap itself.
  function decodeBase64(dataBase64) {
    if (!dataBase64 || dataBase64.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(dataBase64)) FAIL(400, 'INVALID_STAGE_INPUT');
    const bytes = Buffer.from(dataBase64, 'base64');
    if (!bytes.length) FAIL(400, 'INVALID_STAGE_INPUT');
    return bytes;
  }
  return { parse, stage, list, get, cancel, approve };
}
