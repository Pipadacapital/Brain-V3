// FIXTURE: should trigger no-float-money (I-S07)
// This file must NOT be imported in production code. It exists only for lint verification.

// Violation 1: float literal assigned to a *_amount variable
const revenue_amount: number = 9.99;

// Violation 2: float literal assigned to a *_minor variable
const price_minor = 1299.50;

// Violation 3: number type on a *_fee property (TSPropertySignature)
type InvoiceRow = {
  service_fee: number;   // should be bigint minor units
};

// Passing (intentionally safe — these should NOT trigger):
// const price_minor_safe: bigint = BigInt(1299);
