import { reset, createSession, newBill } from './helpers.js'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerBiller, getBiller, validateBillerEntry } from '../server/registry.js'
import { createHolderOrder, createMatchOrder } from '../server/integrations/payeeOrders.js'
import { callBiller, ALLOWED_BILLER_CALLS } from '../server/billerGateway.js'
import { startHolderPayment } from '../server/holder.js'
import { global } from '../server/store.js'

beforeEach(reset)

const goodEntry = { id: 'x', name: 'X Water', entityType: 'public_utility', paypalBusinessAccount: true, issuesPayPalInvoices: true, operatorApproved: true, creditPledge: true, merchantId: 'XMERCH', paymentModes: ['payee_order'] }

test('S1: an individual landlord is rejected, and so is any entry missing a registry criterion', () => {
  assert.throws(() => registerBiller({ ...goodEntry, entityType: 'individual' }), /not accepted/)
  assert.throws(() => registerBiller({ ...goodEntry, operatorApproved: false }), /criterion/)
  assert.throws(() => registerBiller({ ...goodEntry, creditPledge: false }), /criterion/)
  assert.throws(() => registerBiller({ ...goodEntry, entityType: 'business_verified' }), /operator who checked/)
  assert.doesNotThrow(() => validateBillerEntry({ ...goodEntry, entityType: 'business_verified', businessVerifiedBy: 'ops-1' }))
  assert.ok(registerBiller(goodEntry))
})

test('S1: a merchant id that is not in the registry can not receive an order', async () => {
  const stranger = { id: 'fake', name: 'Stranger', merchantId: 'SOMEPERSON', paymentModes: ['payee_order'] }
  await assert.rejects(createHolderOrder(stranger, { amountCents: 100, invoiceId: 'A-H' }), /registered biller/)
  await assert.rejects(createMatchOrder(stranger, { amountCents: 100, invoiceId: 'A-M' }), /registered biller/)
})

test('S12: an email, a string merchant id or a lookalike object can not be the payee', async () => {
  const real = getBiller('riverside')
  await assert.rejects(createHolderOrder('helpme@example.com', { amountCents: 100, invoiceId: 'A-H' }), /registered biller/)
  await assert.rejects(createHolderOrder(real.merchantId, { amountCents: 100, invoiceId: 'A-H' }), /registered biller/)
  await assert.rejects(createHolderOrder({ ...real }, { amountCents: 100, invoiceId: 'A-H' }), /registered biller/)
  const order = await createHolderOrder(real, { amountCents: 100, invoiceId: 'A-H' })
  assert.equal(order.purchase_units[0].payee.merchant_id, real.merchantId)
})

test('S12: a biller that only takes payment on the invoice page can not get an order created', async () => {
  const holder = createSession()
  const bill = await newBill(holder, { biller: 'cedar' })
  await assert.rejects(startHolderPayment(holder, bill.id, '1/2'), /own invoice page/)
})

test('S6: the biller gateway allow-list rejects create_invoice, send_invoice and unknown calls', async () => {
  const biller = getBiller('riverside')
  assert.deepEqual([...ALLOWED_BILLER_CALLS].sort(), ['create_refund', 'get_invoice', 'record_payment_for_invoice'])
  await assert.rejects(callBiller(biller, 'create_invoice', {}), /allow-list/)
  await assert.rejects(callBiller(biller, 'send_invoice', {}), /allow-list/)
  await assert.rejects(callBiller(biller, 'delete_invoice', {}), /allow-list/)
})

test('S6: record_payment_for_invoice only accepts a capture the app made', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  await assert.rejects(callBiller(getBiller('riverside'), 'record_payment_for_invoice', { invoiceId: bill.invoiceId, captureId: 'FORGED123', amountCents: 100 }), /made by Settled/)
})

test('S6: sample seeding is one open bill per biller per session and capped per day', async () => {
  const session = createSession()
  const first = await newBill(session)
  const again = await newBill(session)
  assert.equal(first.id, again.id)
  global.seedDay = { day: new Date().toISOString().slice(0, 10), count: 50 }
  await assert.rejects(newBill(createSession()), /daily sample-bill limit/)
})
