import { reset, createSession, newBill, payHolder, patronWith, holdMatch, advanceClock, payer } from './helpers.js'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/config.js'
import { getBill, global } from '../server/store.js'
import { cancelHolderOrder, completeHolderPayment, startHolderPayment } from '../server/holder.js'
import { confirmHold, evaluate, openCandidates, recheckBill, releaseMatch, requestMatch, settleDue, settleMatch } from '../server/matching.js'
import { loadLedger } from '../server/ledger.js'
import { mockBiller, mockOrders, mockReverseCapture } from '../server/integrations/mockPaypal.js'
import { remainingCents, spentCents } from '../server/patron.js'
import { patronHoldView } from '../server/views.js'
import { postMessage } from '../server/messages.js'
import { captureAuthorization } from '../server/integrations/payeeOrders.js'

beforeEach(reset)

const WINDOW_MS = config.holderSettleMinutes * 60000

async function ready({ share = '1/2', total = 8240 } = {}) {
  const holder = createSession()
  const bill = await newBill(holder, { totalCents: total })
  const { payerId } = await payHolder(holder, bill, { share })
  return { holder, bill, payerId, patron: patronWith() }
}

test('end to end: holder part, patron hold, wait window, charge, PAID with two payments on the invoice', async () => {
  const { holder, bill, patron } = await ready()
  const ledger1 = await loadLedger(bill)
  assert.equal(ledger1.status, 'PARTIALLY_PAID')
  assert.equal(ledger1.dueCents, 4120)

  await holdMatch(patron, bill)
  assert.equal((await settleMatch(bill.id)).state, 'waiting')
  assert.equal((await loadLedger(bill)).status, 'PARTIALLY_PAID')

  advanceClock(WINDOW_MS + 1000)
  const settled = await settleMatch(bill.id)
  assert.equal(settled.state, 'captured')
  const ledger2 = await loadLedger(bill)
  assert.equal(ledger2.status, 'PAID')
  assert.equal(ledger2.payments.length, 2)
  assert.deepEqual(ledger2.payments.map((p) => p.cents), [4120, 4120])
  assert.ok(getBill(bill.id).closed)
  assert.ok(postMessage(holder, bill.id, '').some((m) => m.text === 'We each paid half. Thank you.'))
  assert.throws(() => postMessage(holder, bill.id, 'my cashapp is $someone'), /blocked/)
  assert.ok(postMessage(patron, bill.id, 'Glad to help.').length >= 2)
})

test('S13: the match is only held until the holder part has stayed paid for the whole window', async () => {
  const { bill, patron } = await ready()
  await holdMatch(patron, bill)
  advanceClock(WINDOW_MS - 60000)
  const early = await settleMatch(bill.id)
  assert.equal(early.state, 'waiting')
  assert.equal(getBill(bill.id).match.captureId, null)
})

test('S13: holder reverses during the window -> the hold is voided, nothing charged, budget restored', async () => {
  const { bill, patron } = await ready()
  await holdMatch(patron, bill)
  assert.equal(spentCents(patron), 4120)
  mockReverseCapture(getBill(bill.id).holder.captureId)
  advanceClock(WINDOW_MS + 1000)
  const result = await settleMatch(bill.id)
  assert.equal(result.state, 'voided')
  assert.equal(result.voidReason, 'holder_reversed')
  assert.equal(spentCents(patron), 0)
  assert.equal(remainingCents(patron), 30000)
  assert.match(patronHoldView(patron, getBill(bill.id)).notices[0], /Your hold was released, nothing was charged/)
  await assert.rejects(captureAuthorization({ authorizationId: getBill(bill.id).match.authorizationId, amountCents: 4120, invoiceId: 'x' }), /ALREADY_COMPLETED/)
})

test('S13: holder reverses after the charge -> payer and account excluded for good, match stays with the biller', async () => {
  const { bill, patron, payerId } = await ready()
  await holdMatch(patron, bill)
  advanceClock(WINDOW_MS + 1000)
  await settleMatch(bill.id)
  mockReverseCapture(getBill(bill.id).holder.captureId)
  await recheckBill(bill.id)
  assert.ok(global.excludedPayers.has(payerId))
  assert.ok(global.excludedAccounts.has(getBill(bill.id).accountHash))
  assert.ok(getBill(bill.id).reversedAfterCapture)
  // the same PayPal account can not start another matched bill
  const holder2 = createSession()
  const bill2 = await newBill(holder2)
  const started = await startHolderPayment(holder2, bill2.id, '1/2')
  mockOrders.approve(started.orderId, payer(payerId))
  await assert.rejects(completeHolderPayment(holder2, bill2.id), /can not use matching/)
})

test('S2: after the holder part is refunded, a balance that reappears never gets a new match card', async () => {
  const { bill } = await ready()
  const patron = patronWith()
  mockReverseCapture(getBill(bill.id).holder.captureId)
  await recheckBill(bill.id)
  const ledger = await loadLedger(bill)
  assert.ok(ledger.dueCents > 0)
  const { candidates } = await openCandidates(patron)
  assert.equal(candidates.length, 0)
  await assert.rejects(requestMatch(patron, bill.id), /holder reversed|holder_reversed|can not be matched/i)
})

test('S2: the match amount must equal the ledger due amount at the moment of the hold', async () => {
  const { bill, patron } = await ready()
  mockBiller.recordExternal(bill.invoiceId, 1000)
  await assert.rejects(requestMatch(patron, bill.id), /due differs from match/)
})

test('S10: only the capture Settled made and recorded counts as self_paid', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  const patron = patronWith()
  mockBiller.recordExternal(bill.invoiceId, 4120) // someone pays the same amount at the counter
  const ledger = await loadLedger(bill)
  assert.equal(ledger.status, 'PARTIALLY_PAID')
  const check = evaluate(getBill(bill.id), ledger, patron)
  assert.ok(check.reasons.includes('holder_not_paid'))
  assert.equal(check.eligible, false)
})

test('S10: the match capture is not counted as self_paid', async () => {
  const { bill, patron } = await ready()
  await holdMatch(patron, bill)
  advanceClock(WINDOW_MS + 1000)
  await settleMatch(bill.id)
  const { selfPaidCents } = await import('../server/bills.js')
  const ledger = await loadLedger(bill)
  assert.equal(selfPaidCents(getBill(bill.id), ledger), 4120)
})

test('S11: the share is fixed when the holder presses Pay my part, and only biller-allowed shares work', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  await assert.rejects(startHolderPayment(holder, bill.id, '3/4'), /not one of the shares/)
  const started = await startHolderPayment(holder, bill.id, '1/3')
  assert.equal(started.amountCents, 2747)
  await assert.rejects(startHolderPayment(holder, bill.id, '1/2'), /fixed on this invoice/)
  await cancelHolderOrder(holder, bill.id)
  const again = await startHolderPayment(holder, bill.id, '2/3')
  assert.equal(again.amountCents, 5493)
})

test('S11: a patron floor is a filter, it never changes the fixed share', async () => {
  const { bill } = await ready({ share: '1/3' })
  const strict = patronWith({ minHolderShare: '1/2' })
  const open = patronWith({ minHolderShare: '1/3' })
  const strictFeed = await openCandidates(strict)
  const openFeed = await openCandidates(open)
  assert.equal(strictFeed.candidates.length, 0)
  assert.equal(openFeed.candidates.length, 1)
  assert.equal(openFeed.candidates[0].check.matchCents, 5493)
  assert.equal(getBill(bill.id).share, '1/3')
})

test('S4: one open matched bill per PayPal account, and one matched bill per biller account per month', async () => {
  const holder = createSession()
  const bill1 = await newBill(holder)
  const { payerId } = await payHolder(holder, bill1)
  const holder2 = createSession()
  const bill2 = await newBill(holder2)
  const started = await startHolderPayment(holder2, bill2.id, '1/2')
  mockOrders.approve(started.orderId, payer(payerId))
  await assert.rejects(completeHolderPayment(holder2, bill2.id), /already has an open matched bill/)

  const holder3 = createSession()
  const bill3 = await newBill(holder3, { accountRef: getBill(bill1.id).accountRef })
  await assert.rejects(startHolderPayment(holder3, bill3.id, '1/2'), /already used matching this month/)
})

test('S7: two patrons asking for the same match at the same moment -> exactly one gets it', async () => {
  const { bill } = await ready()
  const a = patronWith()
  const b = patronWith()
  const results = await Promise.allSettled([requestMatch(a, bill.id), requestMatch(b, bill.id)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
})

test('S7: double click on settle charges once', async () => {
  const { bill, patron } = await ready()
  await holdMatch(patron, bill)
  advanceClock(WINDOW_MS + 1000)
  const results = await Promise.all([settleMatch(bill.id), settleMatch(bill.id), settleDue()])
  const ledger = await loadLedger(bill)
  assert.equal(ledger.payments.length, 2)
  assert.equal(ledger.status, 'PAID')
  assert.ok(results[0].state)
})

test('S8: budget and per-bill cap are checked, a void gives the budget back', async () => {
  const { bill } = await ready()
  const poor = patronWith({ monthlyBudgetCents: 4000, perBillCapCents: 4000 })
  await assert.rejects(requestMatch(poor, bill.id), /over budget|over per bill cap/)
  const patron = patronWith({ monthlyBudgetCents: 5000, perBillCapCents: 5000 })
  await holdMatch(patron, bill)
  assert.equal(remainingCents(patron), 880)
  await releaseMatch(patron, bill.id)
  assert.equal(remainingCents(patron), 5000)
})

test('S8: a new match is rejected when the earlier ones used up the budget', async () => {
  const patron = patronWith({ monthlyBudgetCents: 5000, perBillCapCents: 5000 })
  const holderA = createSession()
  const billA = await newBill(holderA)
  await payHolder(holderA, billA)
  const holderB = createSession()
  const billB = await newBill(holderB)
  await payHolder(holderB, billB)
  await holdMatch(patron, billA)
  await assert.rejects(requestMatch(patron, billB.id), /over budget/)
})

test('sessions: another session can not pay, cancel or see a holder bill, and patrons can not act on a hold that is not theirs', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  const intruder = createSession()
  await assert.rejects(startHolderPayment(intruder, bill.id, '1/2'), /Bill not found/)
  await assert.rejects(completeHolderPayment(intruder, bill.id), /Bill not found/)
  await assert.rejects(cancelHolderOrder(intruder, bill.id), /Bill not found/)

  await payHolder(holder, bill)
  const patron = patronWith()
  const other = patronWith()
  const order = await requestMatch(patron, bill.id)
  mockOrders.approve(order.orderId, payer('PATRONX'))
  await assert.rejects(confirmHold(other, bill.id), /Match not found/)
  await assert.rejects(releaseMatch(other, bill.id), /Match not found/)
  await confirmHold(patron, bill.id)
})

test('S4: the same PayPal account can not pay both parts, and the patron view hides who the holder is', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  const { payerId } = await payHolder(holder, bill)
  const order = await requestMatch(holder, bill.id)
  mockOrders.approve(order.orderId, payer(payerId))
  await assert.rejects(confirmHold(holder, bill.id), /same PayPal account/)
  assert.equal(getBill(bill.id).match.status, 'voided')

  const patron = patronWith()
  await holdMatch(patron, bill)
  const view = JSON.stringify(patronHoldView(patron, getBill(bill.id)))
  assert.equal(view.includes(payerId), false)
  assert.equal(view.includes('@'), false)
  assert.equal(view.includes(getBill(bill.id).accountRef), false)
})

test('visibility: with a private feed a sample bill is only offered to the session that created it', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  await payHolder(holder, bill)
  const stranger = patronWith()
  config.publicFeed = false
  try {
    assert.equal((await openCandidates(stranger)).candidates.length, 0)
    await assert.rejects(requestMatch(stranger, bill.id), /not visible/)
    assert.equal((await openCandidates(holder)).candidates.length, 1)
  } finally {
    config.publicFeed = true
  }
})

test('a closed invoice voids an open hold (someone else paid at the counter)', async () => {
  const { bill, patron } = await ready()
  await holdMatch(patron, bill)
  mockBiller.recordExternal(bill.invoiceId, 4120)
  const result = await settleMatch(bill.id)
  assert.equal(result.state, 'voided')
})
