import test from 'node:test';
import assert from 'node:assert/strict';
import { minor, decimal, convertPayment } from '../packages/domain/money.mjs';
import { reviewLegacyAgreement, proposeLegacyOpening } from '../packages/domain/legacy.mjs';

const legacy = { agreed: '5000', previouslyPaid: '2000', currency: 'SAR',
  branchId: 'taiz', patientId: 'patient-1', planId: 'ortho-1', sourceSystem: 'paper',
  sourceRecordId: 'file-120-plan-1', reviewedBy: 'manager-1', asOfDate: '2026-10-05' };

test('old orthodontic payments open remaining debt only; never cash or revenue', () => {
  const result = proposeLegacyOpening(legacy);
  assert.equal(result.historical.receivable, '3000.00');
  assert.deepEqual(result.journal.map(e => e.account), ['PATIENT_RECEIVABLE', 'LEGACY_OPENING_CLEARING']);
  assert.equal(result.journal.reduce((sum, e) => sum + minor(e.debit) - minor(e.credit), 0n), 0n);
});
test('unknown and disputed payments remain unresolved, not zero', () => {
  for (const change of [{ previouslyPaid: null }, { agreed: null }, { disputed: true }]) {
    const input = { ...legacy, ...change };
    assert.equal(reviewLegacyAgreement(input).receivable, null);
    assert.throws(() => proposeLegacyOpening(input), /REVIEW_REQUIRED/);
  }
});
test('historic overpayment creates patient credit without negative debt', () => {
  const result = proposeLegacyOpening({ ...legacy, previouslyPaid: '5100' });
  assert.equal(result.historical.receivable, '0.00');
  assert.equal(result.historical.patientCredit, '100.00');
  assert.equal(result.journal[1].account, 'PATIENT_CREDIT');
});
test('settled legacy case creates no opening journal', () => {
  assert.deepEqual(proposeLegacyOpening({ ...legacy, previouslyPaid: '5000' }).journal, []);
});
test('YER payment reduces SAR debt using explicit historical rate direction', () => {
  const result = convertPayment({ amount: '14000', paymentCurrency: 'YER', debtCurrency: 'SAR', rate: '140' });
  assert.equal(result.debtAmount, '100.00');
  assert.equal(result.paymentAmount, '14000.00');
  assert.equal(result.rate, '140');
});
test('every payment/debt currency pairing works, with exact same-currency identity', () => {
  for (const from of ['YER', 'SAR', 'USD']) for (const to of ['YER', 'SAR', 'USD']) {
    const result = convertPayment({ amount: '10.05', paymentCurrency: from, debtCurrency: to, rate: '1' });
    assert.equal(result.debtAmount, '10.05');
  }
});
test('half-up rounding retains an exact residual', () => {
  const result = convertPayment({ amount: '0.01', paymentCurrency: 'USD', debtCurrency: 'SAR', rate: '2' });
  assert.equal(result.debtAmount, '0.01');
  assert.equal(result.roundingResidualNumerator, '-1');
  assert.equal(result.roundingResidualDenominator, '2');
});
test('invalid money, currency, rate and unrepresentable payment fail closed', () => {
  for (const value of [1.1, '-1', 'NaN', '1e3', '1.001', '', ' 1', 'Infinity']) assert.throws(() => minor(value));
  const input = { amount: '100', paymentCurrency: 'YER', debtCurrency: 'SAR', rate: '140' };
  for (const change of [{ rate: '0' }, { rate: '-1' }, { amount: '0' }, { paymentCurrency: 'EUR' },
    { paymentCurrency: 'SAR', rate: '2' }, { amount: '0.01', rate: '100' }]) {
    assert.throws(() => convertPayment({ ...input, ...change }));
  }
});
test('amounts beyond Number safe integer retain all digits', () => {
  assert.equal(decimal(minor('9999999999999999.99')), '9999999999999999.99');
});
test('legacy source key is stable and currency scoped; incomplete identity rejected', () => {
  assert.equal(proposeLegacyOpening(legacy).sourceKey, proposeLegacyOpening(legacy).sourceKey);
  assert.notEqual(proposeLegacyOpening(legacy).sourceKey, proposeLegacyOpening({ ...legacy, currency: 'USD' }).sourceKey);
  assert.throws(() => proposeLegacyOpening({ ...legacy, planId: '' }));
  assert.throws(() => proposeLegacyOpening({ ...legacy, asOfDate: '2026-02-30' }));
});
