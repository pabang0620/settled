import { reset, createSession, patronWith, newBill, payHolder, holdMatch, advanceClock } from './helpers.js'
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { config, configWarnings } from '../server/config.js'
import { openCandidates, requestMatch, confirmHold } from '../server/matching.js'
import { mockOrders } from '../server/integrations/mockPaypal.js'
import { payer } from './helpers.js'
import { getBill } from '../server/store.js'

const previous = { matchMode: config.matchMode, minutes: config.holderSettleMinutes }
beforeEach(() => { reset(); config.matchMode = 'capture_after_window'; config.holderSettleMinutes = 60 })
afterEach(() => { config.matchMode = previous.matchMode; config.holderSettleMinutes = previous.minutes })

async function paidBill() {
  const holder = createSession()
  const bill = await newBill(holder)
  await payHolder(holder, bill)
  return { holder, bill }
}

test('capture_after_window: no card while the window is open, a card after it', async () => {
  const { bill } = await paidBill()
  const patron = patronWith()
  let feed = await openCandidates(patron)
  assert.equal(feed.candidates.length, 0)
  advanceClock(61 * 60000)
  feed = await openCandidates(patron)
  assert.equal(feed.candidates.length, 1)
  assert.equal(feed.candidates[0].bill.id, bill.id)
})

test('capture_after_window: approval captures once and records the match, nothing is held or voidable', async () => {
  const { bill } = await paidBill()
  advanceClock(61 * 60000)
  const patron = patronWith()
  const order = await requestMatch(patron, bill.id)
  assert.equal(mockOrders.get(order.orderId).intent, 'CAPTURE')
  mockOrders.approve(order.orderId, payer('PATRONCAP1'))
  const view = await confirmHold(patron, bill.id)
  assert.equal(view.status, 'captured')
  const after = getBill(bill.id)
  assert.equal(after.match.status, 'captured')
  assert.equal(after.match.authorizationId, null)
  assert.equal(after.match.ledgerRecorded, true)
  assert.equal(after.closed, true)
})

test('hold mode is unchanged: the card shows at once and the match is held, not charged', async () => {
  config.matchMode = 'hold'
  const { bill } = await paidBill()
  const patron = patronWith()
  assert.equal((await openCandidates(patron)).candidates.length, 1)
  const held = await holdMatch(patron, bill)
  assert.equal(held.status, 'held')
  assert.equal(getBill(bill.id).match.captureId, null)
})

test('configWarnings: PUBLIC_URL on another port and a missing biller app are both reported', () => {
  const base = { port: 3917, publicUrl: 'http://localhost:3001', matchMode: 'hold', billerCredentials: { riverside: { clientId: '', clientSecret: '' } } }
  const warnings = configWarnings(base, { paypal: 'sandbox' })
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /PUBLIC_URL/)
  assert.match(warnings[1], /capture_after_window/)
  assert.deepEqual(configWarnings({ ...base, port: 3001, matchMode: 'capture_after_window' }, { paypal: 'sandbox' }), [])
  assert.deepEqual(configWarnings({ ...base, port: 3001 }, { paypal: 'mock' }), [])
})

test('toolkit: an {ok:false} answer is a failure, never a recorded payment', async () => {
  const { checkToolkitResult } = await import('../server/integrations/invoicing.js')
  assert.throws(() => checkToolkitResult('record_payment_for_invoice', { ok: false, status: 404, message: 'The specified resource does not exist' }), /404 The specified resource does not exist/)
  assert.throws(() => checkToolkitResult('get_invoice', { error: { message: 'boom' } }), /boom/)
  assert.deepEqual(checkToolkitResult('get_invoice', { id: 'INV2-1', status: 'SENT' }), { id: 'INV2-1', status: 'SENT' })
})
