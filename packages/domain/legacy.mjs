// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
import { currency, minor, decimal } from './money.mjs';

export function reviewLegacyAgreement({ agreed, previouslyPaid, currency: unit, disputed = false }) {
  currency(unit);
  const total = agreed == null ? null : minor(agreed);
  const paid = previouslyPaid == null ? null : minor(previouslyPaid);
  if (typeof disputed !== 'boolean') throw new Error('INVALID_DISPUTE_FLAG');
  const incomplete = total === null || paid === null;
  if (disputed || incomplete) return Object.freeze({
    status: 'needs_review', reason: disputed ? 'disputed' : 'missing_amounts',
    currency: unit, agreed: total === null ? null : decimal(total),
    previouslyPaid: paid === null ? null : decimal(paid),
    receivable: null, patientCredit: null,
  });
  const difference = total - paid;
  return Object.freeze({
    status: 'reconciled', currency: unit, agreed: decimal(total), previouslyPaid: decimal(paid),
    receivable: decimal(difference > 0n ? difference : 0n),
    patientCredit: decimal(difference < 0n ? -difference : 0n),
  });
}

function required(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`INVALID_${field}`);
  return value.trim();
}

// Produces a PROPOSAL, not a posted journal. No cash entry or fake invoice.
// Persistence must enforce authorization, matching patient/plan/branch,
// unique source key, one active opening version, and an atomic journal/audit write.
export function proposeLegacyOpening(input) {
  const review = reviewLegacyAgreement(input);
  if (review.status !== 'reconciled') throw new Error('LEGACY_REVIEW_REQUIRED');
  const identity = {};
  for (const field of ['branchId', 'patientId', 'planId', 'sourceSystem', 'sourceRecordId', 'reviewedBy']) {
    identity[field] = required(input[field], field);
  }
  const date = input.asOfDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('INVALID_AS_OF_DATE');
  }
  const entries = [];
  const remaining = minor(review.receivable);
  const credit = minor(review.patientCredit);
  if (remaining > 0n) entries.push(
    { account: 'PATIENT_RECEIVABLE', debit: review.receivable, credit: '0.00' },
    { account: 'LEGACY_OPENING_CLEARING', debit: '0.00', credit: review.receivable },
  );
  if (credit > 0n) entries.push(
    { account: 'LEGACY_OPENING_CLEARING', debit: review.patientCredit, credit: '0.00' },
    { account: 'PATIENT_CREDIT', debit: '0.00', credit: review.patientCredit },
  );
  return Object.freeze({
    kind: 'legacy_opening_proposal', ...identity, asOfDate: date,
    sourceKey: JSON.stringify([identity.branchId, identity.sourceSystem, identity.sourceRecordId, review.currency]),
    historical: review,
    journal: Object.freeze(entries.map(entry => Object.freeze({ ...entry, currency: review.currency }))),
  });
}
