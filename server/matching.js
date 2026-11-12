import { HttpError } from './http.js'
import { withLock } from './locks.js'
import { now } from './clock.js'
import { config } from './config.js'
import { allBills, aliasOf, getBill, global, logActivity } from './store.js'
import { billerOf, loadLedger } from './ledger.js'
import { meetsHolderFloor, selfPaidCents, statusClass, urgencyOf } from './bills.js'
import { holderPart, matchPart, usd } from './money.js'
import { PAYER_MONTHLY_MATCH_CAP_CENTS, payerMonthlyMatchCents, remainingCents, rulesOf } from './patron.js'
import { callBiller, registerAppCapture } from './billerGateway.js'
import { approvalLink, authorizationIdOf, authorizeOrder, captureAuthorization, captureIdOf, captureOrder, createMatchOrder, getCapture, getOrder, voidAuthorization } from './integrations/payeeOrders.js'

const ORDER_TTL_MS = 30 * 60 * 1000
const REVERSED_CAPTURE_STATUSES = ['REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED', 'DECLINED']

const matchInFlight = (bill, nowMs) => {
  const { status, orderedAt } = bill.match
  if (status === 'held' || status === 'captured') return true
  return status === 'ordered' && nowMs - orderedAt < ORDER_TTL_MS
}

const notify = (bill, to, text) => { bill.notices = [...bill.notices, { at: now(), to, patronSessionId: bill.match.patronSessionId, text }] }

export const visibleTo = (bill, patron) => config.publicFeed || bill.audience === patron.id

// ---- Eligibility: one function decides whether a bill may become a match card (S2, S3, S10, S11, S4, S8) ----
export function evaluate(bill, ledger, patron, nowMs = now()) {
  const reasons = []
  const biller = billerOf(bill)
  const rules = rulesOf(patron)
  if (!visibleTo(bill, patron)) reasons.push('not_visible')
  if (!bill.sponsorable) reasons.push('not_sponsorable')
  if (!biller.paymentModes.includes('payee_order')) reasons.push('route_not_matchable')
  if (bill.closed || statusClass(ledger.status) === 'closed') reasons.push('closed')
  if (bill.holderReversed) reasons.push('holder_reversed')
  if (bill.holder.status !== 'captured' || !bill.holder.ledgerRecorded || !bill.share) reasons.push('holder_not_paid')
  if (statusClass(ledger.status) !== 'partial') reasons.push('ledger_not_partially_paid')
  if (matchInFlight(bill, nowMs)) reasons.push('match_in_progress')
  // capture_after_window: no hold exists, so the card waits until the holder's part has stayed paid for the whole window.
  if (config.matchMode === 'capture_after_window' && bill.holder.capturedAt != null && nowMs < holdReleasesAt(bill)) reasons.push('holder_window_open')
  if (global.excludedPayers.has(bill.holder.payerId) || global.excludedAccounts.has(bill.accountHash)) reasons.push('holder_excluded')

  let matchCents = 0
  let holderCents = 0
  if (bill.share) {
    holderCents = holderPart(ledger.totalCents, bill.share)
    matchCents = matchPart(ledger.totalCents, bill.share)
    if (selfPaidCents(bill, ledger) < holderCents) reasons.push('self_paid_short')
    if (ledger.dueCents <= 0 || ledger.dueCents !== matchCents) reasons.push('due_differs_from_match')
    if (!meetsHolderFloor(bill.share, rules.minHolderShare)) reasons.push('holder_share_below_floor')
  }
  if (matchCents > rules.perBillCapCents) reasons.push('over_per_bill_cap')
  if (biller.category !== rules.category) reasons.push('category_mismatch')
  if (biller.region !== rules.region) reasons.push('region_mismatch')
  if (matchCents > remainingCents(patron)) reasons.push('over_budget')
  if (bill.holder.payerId && payerMonthlyMatchCents(bill.holder.payerId, nowMs) + matchCents > PAYER_MONTHLY_MATCH_CAP_CENTS) reasons.push('holder_monthly_limit')
  return { eligible: reasons.length === 0, reasons, matchCents, holderCents }
}

// ---- Observation: reversal and closure checks, always under the invoice lock ----
async function holderWasReversed(bill, ledger) {
  if (bill.holderReversed) return true
  if (bill.holder.status !== 'captured') return false
  if (ledger.refunds.length || bill.disputeFlag) return true
  const capture = await getCapture(bill.holder.captureId)
  return REVERSED_CAPTURE_STATUSES.includes(capture.status)
}

async function voidMatch(bill, reason) {
  if (bill.match.status === 'held' && bill.match.authorizationId) await voidAuthorization(bill.match.authorizationId, billerOf(bill))
  bill.match = { ...bill.match, status: 'voided', voidReason: reason }
}

async function observe(bill, ledger) {
  if (!bill.holderReversed && await holderWasReversed(bill, ledger)) {
    bill.holderReversed = true
    if (bill.match.status === 'held' || bill.match.status === 'ordered') {
      await voidMatch(bill, 'holder_reversed')
      notify(bill, 'patron', "The holder's part was reversed. Your hold was released, nothing was charged.")
      notify(bill, 'holder', 'Your part was reversed, so the patron hold was released.')
    } else if (bill.match.status === 'captured') {
      bill.reversedAfterCapture = true
      global.excludedPayers.add(bill.holder.payerId)
      global.excludedAccounts.add(bill.accountHash)
      notify(bill, 'patron', "The holder's part was reversed after your match was charged. Your match stays with the biller, never a person.")
    }
  }
  if (!bill.closed && statusClass(ledger.status) === 'closed') {
    bill.closed = true
    if ((bill.match.status === 'held' || bill.match.status === 'ordered') && !bill.match.captureId) {
      await voidMatch(bill, 'invoice_closed')
      notify(bill, 'patron', 'The invoice was closed by someone else. Your hold was released, nothing was charged.')
    }
  }
}

async function freshLedger(bill, opts) {
  const ledger = await loadLedger(bill, opts)
  await observe(bill, ledger)
  return ledger
}

// Open bills a patron could match right now. A bill whose ledger fails is skipped and reported.
export async function openCandidates(patron) {
  const candidates = []
  const skipped = []
  for (const bill of allBills()) {
    if (bill.holder.status !== 'captured' || !visibleTo(bill, patron)) continue
    try {
      const ledger = await withLock(bill.invoiceId, () => freshLedger(bill, { listing: true }))
      const check = evaluate(bill, ledger, patron)
      if (check.eligible) candidates.push({ bill, ledger, check })
    } catch (err) {
      skipped.push({ invoiceNumber: bill.invoiceNumber, reason: err.code === 'ledger_timeout' ? 'ledger timeout' : 'ledger error' })
    }
  }
  return { candidates, skipped }
}

// ---- Card -> hold -> charge ----
export async function requestMatch(patron, billId) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  return withLock(bill.invoiceId, async () => {
    const ledger = await freshLedger(bill)
    const check = evaluate(bill, ledger, patron)
    if (!check.eligible) throw new HttpError(409, `This bill can not be matched: ${check.reasons[0].replaceAll('_', ' ')}.`, check.reasons[0])
    const biller = billerOf(bill)
    const order = await createMatchOrder(biller, {
      amountCents: check.matchCents,
      invoiceId: `${ledger.number}-M`,
      description: `Match for ${biller.name} invoice ${ledger.number}`,
      returnUrl: `${config.publicUrl}/?paypal=return&role=patron&bill=${bill.id}`,
      cancelUrl: `${config.publicUrl}/?paypal=cancel&role=patron&bill=${bill.id}`,
    })
    bill.match = { status: 'ordered', patronSessionId: patron.id, patronPayerId: null, orderId: order.id, authorizationId: null, captureId: null, amountCents: check.matchCents, orderedAt: now(), heldAt: null, ledgerRecorded: false, voidReason: null, approvalUrl: approvalLink(order) }
    logActivity(patron, { source: 'paypal', tool: `create_order(payee, ${config.matchMode === 'capture_after_window' ? 'CAPTURE' : 'AUTHORIZE'})`, ok: true, detail: `match ${usd(check.matchCents)} to ${biller.name}` })
    return matchOrderView(bill)
  })
}

export const matchOrderView = (bill) => ({ billId: bill.id, orderId: bill.match.orderId, approvalUrl: bill.match.approvalUrl, amountCents: bill.match.amountCents })

function ownMatch(patron, bill) {
  if (bill.match.patronSessionId !== patron.id) throw new HttpError(404, 'Match not found.', 'match_not_found')
}

export async function confirmHold(patron, billId) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  ownMatch(patron, bill)
  return withLock(bill.invoiceId, async () => {
    if (bill.match.status === 'held') return holdView(bill)
    if (bill.match.status !== 'ordered') throw new HttpError(409, 'There is no open match order.', 'no_open_match')
    const order = await getOrder(bill.match.orderId)
    if (order.status !== 'APPROVED') throw new HttpError(409, 'PayPal has not approved this hold yet.', 'order_not_approved')
    // The same PayPal account can not be both sides of a bill (S4).
    if (order.payer?.payer_id && order.payer.payer_id === bill.holder.payerId) {
      await voidMatch(bill, 'own_bill')
      throw new HttpError(409, 'The same PayPal account can not pay both parts of a bill.', 'own_bill')
    }
    const ledger = await freshLedger(bill)
    if (bill.match.status !== 'ordered') throw new HttpError(409, 'This hold was released.', 'hold_released')
    if (bill.holderReversed || ledger.dueCents !== bill.match.amountCents) {
      await voidMatch(bill, 'ledger_changed')
      throw new HttpError(409, 'The invoice changed before the hold started. Nothing was held.', 'ledger_changed')
    }
    if (config.matchMode === 'capture_after_window') return captureMatchNow(patron, bill, order)
    const authorized = await authorizeOrder(bill.match.orderId)
    const authorizationId = authorizationIdOf(authorized)
    if (!authorizationId) throw new HttpError(502, 'PayPal did not create the hold.', 'authorize_failed')
    bill.match = { ...bill.match, status: 'held', authorizationId, patronPayerId: order.payer?.payer_id || null, heldAt: now() }
    logActivity(patron, { source: 'paypal', tool: 'authorize(match)', ok: true, detail: `${usd(bill.match.amountCents)} held, not charged` })
    return holdView(bill)
  })
}

// capture_after_window: the approval is the charge. The window was checked before the card was shown and is checked again here.
async function captureMatchNow(patron, bill, order) {
  if (holdReleasesAt(bill) - now() > 0) throw new HttpError(409, 'The holder\'s part has not stayed paid for the whole window yet. Nothing was charged.', 'window_open')
  const captured = await captureOrder(bill.match.orderId)
  const capture = captured.purchase_units?.[0]?.payments?.captures?.[0]
  if (!capture || capture.status !== 'COMPLETED') throw new HttpError(502, 'PayPal did not complete the match capture.', 'capture_failed')
  const captureId = captureIdOf(captured)
  registerAppCapture(captureId)
  bill.match = { ...bill.match, status: 'captured', captureId, patronPayerId: order.payer?.payer_id || null, heldAt: now() }
  logActivity(patron, { source: 'paypal', tool: 'capture(match)', ok: true, detail: `${usd(bill.match.amountCents)} captured after the window` })
  await recordMatch(bill)
  return holdView(bill)
}

export async function releaseMatch(patron, billId) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  ownMatch(patron, bill)
  return withLock(bill.invoiceId, async () => {
    if (!['ordered', 'held'].includes(bill.match.status)) throw new HttpError(409, 'Nothing to release.', 'nothing_to_release')
    await voidMatch(bill, 'patron_released')
    return { billId: bill.id, status: 'voided' }
  })
}

export const holdWindowMs = () => config.holderSettleMinutes * 60000
export const holdReleasesAt = (bill) => (bill.holder.capturedAt ?? now()) + holdWindowMs()

const holdView = (bill) => ({ billId: bill.id, status: bill.match.status, amountCents: bill.match.amountCents, chargeAfter: holdReleasesAt(bill) })

/**
 * Charge the hold only when the holder's part has stayed paid for the whole window (S13).
 * Runs from the settle job; the demo has a button for it.
 */
export async function settleMatch(billId) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  return withLock(bill.invoiceId, async () => {
    if (bill.match.status === 'captured' && !bill.match.ledgerRecorded) return recordMatch(bill)
    if (bill.match.status !== 'held') return { state: bill.match.status, voidReason: bill.match.voidReason }
    const ledger = await freshLedger(bill)
    if (bill.match.status !== 'held') return { state: bill.match.status, voidReason: bill.match.voidReason }
    if (ledger.dueCents !== bill.match.amountCents) {
      await voidMatch(bill, 'ledger_changed')
      notify(bill, 'patron', 'The invoice balance changed. Your hold was released, nothing was charged.')
      return { state: 'voided', voidReason: 'ledger_changed' }
    }
    const waitMs = holdReleasesAt(bill) - now()
    if (waitMs > 0) return { state: 'waiting', waitMs }
    const capture = await captureAuthorization({ authorizationId: bill.match.authorizationId, amountCents: bill.match.amountCents, invoiceId: `${ledger.number}-M` })
    if (capture.status !== 'COMPLETED') throw new HttpError(502, 'PayPal did not complete the match capture.', 'capture_failed')
    registerAppCapture(capture.id)
    bill.match = { ...bill.match, status: 'captured', captureId: capture.id }
    return recordMatch(bill)
  })
}

async function recordMatch(bill) {
  await callBiller(billerOf(bill), 'record_payment_for_invoice', { invoiceId: bill.invoiceId, captureId: bill.match.captureId, amountCents: bill.match.amountCents })
  bill.match = { ...bill.match, ledgerRecorded: true }
  const ledger = await loadLedger(bill)
  if (statusClass(ledger.status) === 'closed') bill.closed = true
  notify(bill, 'holder', `Paid at the source: your part ${usd(bill.holder.amountCents)}, a patron's match ${usd(bill.match.amountCents)}.`)
  return { state: 'captured', invoiceStatus: ledger.status }
}

// Settle job: capture every hold whose window is over, void the ones that were reversed.
export async function settleDue() {
  const results = []
  for (const bill of allBills()) {
    const open = bill.match.status === 'held' || (bill.match.status === 'captured' && !bill.match.ledgerRecorded)
    if (!open) continue
    try {
      results.push({ billId: bill.id, ...(await settleMatch(bill.id)) })
    } catch (err) {
      results.push({ billId: bill.id, state: 'error', error: err.message })
    }
  }
  return results
}

// Called by the biller webhook handler (V9) or the demo button: look at the bill again right now.
export async function recheckBill(billId) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  return withLock(bill.invoiceId, async () => {
    await freshLedger(bill)
    return { billId: bill.id, holderReversed: bill.holderReversed, match: bill.match.status }
  })
}

export async function flagDispute(billId) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  bill.disputeFlag = true
  return recheckBill(billId)
}

// ---- Views ----
export function cardView(bill, ledger, check, nowMs = now()) {
  const urgency = urgencyOf(bill, ledger, nowMs)
  const biller = billerOf(bill)
  return {
    billId: bill.id,
    billerName: biller.name,
    category: biller.category,
    region: biller.region,
    invoiceNumber: ledger.number,
    accountMask: `••${String(bill.accountRef).slice(-4)}`,
    dueDate: ledger.dueDate,
    urgency,
    holderAlias: aliasOf(bill.holder.payerId, 'Holder'),
    share: bill.share,
    holderPaidCents: selfPaidCents(bill, ledger),
    matchCents: check.matchCents,
    noRefundsSoFar: ledger.refunds.length === 0,
    closesBill: true,
    waitMinutes: config.holderSettleMinutes,
  }
}
