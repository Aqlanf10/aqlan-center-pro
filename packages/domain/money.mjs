// Copyright (c) 2026 Dr. Aqlan Alkamel. All rights reserved.
// Monetary API values are decimal strings; never accept binary floating point.
const currencies = new Set(['YER', 'SAR', 'USD']);
export function currency(value) {
  if (!currencies.has(value)) throw new Error('UNSUPPORTED_CURRENCY');
  return value;
}
export function minor(value) {
  if (typeof value !== 'string' || !/^\d{1,16}(\.\d{1,2})?$/.test(value)) {
    throw new Error('INVALID_NONNEGATIVE_AMOUNT');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function decimal(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('INVALID_MINOR_AMOUNT');
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function rateFraction(value) {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,12})?$/.test(value)) {
    throw new Error('INVALID_RATE');
  }
  const [whole, fraction = ''] = value.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction);
  if (numerator <= 0n) throw new Error('INVALID_RATE');
  return { numerator, denominator };
}
export function convertPayment({ amount, paymentCurrency, debtCurrency, rate }) {
  currency(paymentCurrency);
  currency(debtCurrency);
  const paid = minor(amount);
  if (paid <= 0n) throw new Error('PAYMENT_MUST_BE_POSITIVE');
  const { numerator, denominator } = rateFraction(rate);
  if (paymentCurrency === debtCurrency && numerator !== denominator) {
    throw new Error('SAME_CURRENCY_RATE_MUST_BE_ONE');
  }
  // rate = payment-currency units per ONE debt-currency unit.
  // Example: YER 14000 / (YER 140 per SAR 1) = SAR 100.
  const raw = paid * denominator;
  const credited = (raw * 2n + numerator) / (2n * numerator);
  if (credited === 0n) throw new Error('PAYMENT_ROUNDS_TO_ZERO');
  return Object.freeze({
    paymentAmount: decimal(paid), paymentCurrency,
    debtAmount: decimal(credited), debtCurrency, rate,
    rateConvention: 'payment_currency_per_debt_currency',
    rounding: 'HALF_UP_2DP',
    roundingResidualNumerator: String(raw - credited * numerator),
    roundingResidualDenominator: String(numerator),
  });
}
