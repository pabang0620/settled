// Sandbox finding 2026-11-12: record-payment refuses a payment_id (404) and stores EXTERNAL entries with EXTR- ids.
// The app links its capture through the note and never records the same capture twice.
process.env.PAYPAL_CLIENT_ID = ''
process.env.PAYPAL_CLIENT_SECRET = ''
const { reset } = await import('./helpers.js')
const { default: test, beforeEach } = await import('node:test')
const { default: assert } = await import('node:assert/strict')
const { mockInvoicing } = await import('../server/integrations/mockPaypal.js')
const { invoicing, readLedger, captureRefOf, captureNote } = await import('../server/integrations/invoicing.js')

beforeEach(reset)

const seed = () => {
  const created = mockInvoicing.create({
  invoice_number: 'INV-9001', totalCents: 10000, due_date: '2026-12-01', reference: 'A-1',
  recipient: { billing_info: { email_address: 'r@example.com', name: { given_name: 'R' } } },
  allow_partial_payment: true, minimum_amount_due: 1000, invoicer: { business_name: 'Riverside Water' },
  })
  mockInvoicing.send(created.id)
  return created
}

test('ledger: captureRef comes from the app note, else from a PayPal payment id', () => {
  assert.equal(captureRefOf({ note: captureNote('13L29824N61046411'), payment_id: 'EXTR-5NM32853CE3202225' }), '13L29824N61046411')
  assert.equal(captureRefOf({ payment_id: 'ABC' }), 'ABC')
  assert.equal(captureRefOf({ note: 'counter payment' }), null)
})

test('ledger: the stand-in refuses a payment_id like the sandbox does', () => {
  const { id } = seed()
  assert.throws(() => mockInvoicing.recordPayment({ invoice_id: id, payment_id: 'CAP1', method: 'PAYPAL', amount: { currency_code: 'USD', value: '10.00' } }), /RESOURCE_NOT_FOUND/)
})

test('ledger: recording a capture writes the note once, a second call finds it and adds nothing', async () => {
  const { id } = seed()
  const first = await invoicing.recordPayment('riverside', { invoiceId: id, captureId: 'CAP1', amountCents: 5000 })
  assert.match(first.payment_id, /^EXTR-/)
  const again = await invoicing.recordPayment('riverside', { invoiceId: id, captureId: 'CAP1', amountCents: 5000 })
  assert.equal(again.alreadyRecorded, true)
  const ledger = readLedger(mockInvoicing.get(id))
  assert.equal(ledger.payments.length, 1)
  assert.equal(ledger.payments[0].captureRef, 'CAP1')
  assert.equal(ledger.payments[0].type, 'EXTERNAL')
  assert.equal(ledger.dueCents, 5000)
})
