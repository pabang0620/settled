import { HttpError } from './http.js'
import { withLock } from './locks.js'
import { now } from './clock.js'
import { config } from './config.js'
import { allBills, getBill, global, logActivity, monthKey } from './store.js'
import { billerOf, loadLedger } from './ledger.js'
import { statusClass } from './bills.js'
import { holderPart, minimumDue, usd } from './money.js'
import { callBiller, registerAppCapture } from './billerGateway.js'
import { approvalLink, captureIdOf, captureOrder, createHolderOrder, getOrder } from './integrations/payeeOrders.js'

export function ownBill(session, billId) {
  const bill = getBill(billId)
  // Another session's bill looks like a missing bill (no information about it leaks).
  if (!bill || bill.sessionId !== session.id) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  return bill
}

const openBillsOfPayer = (payerId, exceptId) =>
  allBills().filter((b) => b.id !== exceptId && b.holder.payerId === payerId && b.holder.status === 'captured' && !b.closed)

/**
 * Step 1 of the flow: the holder (the person with the bill) presses "Pay my part".
 * The share is fixed on this invoice from this moment (S11); the amount is computed here, never by the model.
 */
export async function startHolderPayment(session, billId, share, urls) {
  const bill = ownBill(session, billId)
  return withLock(bill.invoiceId, async () => {
    const biller = billerOf(bill)
    if (!biller.paymentModes.includes('payee_order')) throw new HttpError(409, 'This biller takes payment on its own invoice page. Matching is not available.', 'route_not_matchable')
    if (!biller.allowedShares.includes(share)) throw new HttpError(400, `${share} is not one of the shares ${biller.name} allows.`, 'share_not_allowed')
    if (bill.share && bill.share !== share) throw new HttpError(409, 'The share is fixed on this invoice.', 'share_locked')
    if (bill.holder.status === 'captured') throw new HttpError(409, 'Your part is already paid.', 'holder_already_paid')
    if (bill.holder.status === 'ordered') return holderOrderView(bill)
    if (bill.holderReversed) throw new HttpError(409, 'This bill can not be matched anymore.', 'holder_reversed')
    if (global.excludedAccounts.has(bill.accountHash)) throw new HttpError(403, 'This account can not use matching.', 'account_excluded')
    const monthly = `${bill.accountHash}:${monthKey()}`
    if (global.accountMonths.has(monthly) && global.accountMonths.get(monthly) !== bill.id) throw new HttpError(409, 'This biller account already used matching this month.', 'account_monthly_limit')

    const ledger = await loadLedger(bill)
    if (statusClass(ledger.status) !== 'payable') throw new HttpError(409, `The invoice is ${ledger.status}. Only an unpaid invoice can start.`, 'invoice_not_payable')
    const amountCents = holderPart(ledger.totalCents, share)
    if (amountCents < minimumDue(ledger.totalCents, biller.allowedShares)) throw new HttpError(409, 'Your part is below the biller minimum.', 'below_minimum')

    const order = await createHolderOrder(biller, {
      amountCents,
      invoiceId: `${ledger.number}-H`,
      description: `Your part of ${biller.name} invoice ${ledger.number}`,
      returnUrl: `${config.publicUrl}/?paypal=return&role=holder&bill=${bill.id}`,
      cancelUrl: `${config.publicUrl}/?paypal=cancel&role=holder&bill=${bill.id}`,
    })
    bill.share = share
    bill.holder = { ...bill.holder, status: 'ordered', orderId: order.id, amountCents, approvalUrl: approvalLink(order) }
    logActivity(session, { source: 'paypal', tool: 'create_order(payee)', ok: true, detail: `holder part ${usd(amountCents)} to ${biller.name}` })
    return holderOrderView(bill)
  })
}

export const holderOrderView = (bill) => ({
  billId: bill.id,
  orderId: bill.holder.orderId,
  approvalUrl: bill.holder.approvalUrl,
  amountCents: bill.holder.amountCents,
  share: bill.share,
})

// Abandoned or cancelled approval: nothing was captured, so the share is free again.
export async function cancelHolderOrder(session, billId) {
  const bill = ownBill(session, billId)
  return withLock(bill.invoiceId, async () => {
    if (bill.holder.status !== 'ordered') throw new HttpError(409, 'There is no open order to cancel.', 'no_open_order')
    bill.holder = { ...bill.holder, status: 'none', orderId: null, amountCents: 0, approvalUrl: null }
    bill.share = null
    return { billId: bill.id }
  })
}

/**
 * Step 2: after the holder approved on PayPal, capture, record on the biller's invoice, remember payer_id (S4, S10).
 */
export async function completeHolderPayment(session, billId) {
  const bill = ownBill(session, billId)
  return withLock(bill.invoiceId, async () => {
    if (bill.holder.status === 'captured') {
      if (!bill.holder.ledgerRecorded) await recordHolderOnLedger(bill)
      return { billId: bill.id, status: 'captured', recorded: bill.holder.ledgerRecorded }
    }
    if (bill.holder.status !== 'ordered') throw new HttpError(409, 'Press "Pay my part" first.', 'no_open_order')
    const order = await getOrder(bill.holder.orderId)
    if (order.status !== 'APPROVED') throw new HttpError(409, 'PayPal has not approved this payment yet.', 'order_not_approved')
    const payerId = order.payer?.payer_id
    if (!payerId) throw new HttpError(409, 'PayPal did not return a payer id.', 'payer_missing')
    if (global.excludedPayers.has(payerId)) throw new HttpError(403, 'This PayPal account can not use matching.', 'payer_excluded')
    if (openBillsOfPayer(payerId, bill.id).length) throw new HttpError(409, 'This PayPal account already has an open matched bill.', 'payer_open_bill')
    const ledger = await loadLedger(bill)
    if (statusClass(ledger.status) !== 'payable') throw new HttpError(409, `The invoice changed (${ledger.status}). Nothing was charged.`, 'invoice_changed')

    const captured = await captureOrder(bill.holder.orderId)
    const capture = captured.purchase_units?.[0]?.payments?.captures?.[0]
    const captureId = captureIdOf(captured)
    if (!capture || capture.status !== 'COMPLETED') throw new HttpError(502, 'PayPal did not complete the capture.', 'capture_failed')
    registerAppCapture(captureId)
    bill.holder = { ...bill.holder, status: 'captured', captureId, payerId, capturedAt: now() }
    global.accountMonths.set(`${bill.accountHash}:${monthKey()}`, bill.id)
    logActivity(session, { source: 'paypal', tool: 'capture(holder)', ok: true, detail: `${usd(bill.holder.amountCents)} captured, order ${bill.holder.orderId}` })
    await recordHolderOnLedger(bill)
    return { billId: bill.id, status: 'captured', recorded: bill.holder.ledgerRecorded }
  })
}

async function recordHolderOnLedger(bill) {
  try {
    await callBiller(billerOf(bill), 'record_payment_for_invoice', { invoiceId: bill.invoiceId, captureId: bill.holder.captureId, amountCents: bill.holder.amountCents })
    bill.holder = { ...bill.holder, ledgerRecorded: true }
  } catch (err) {
    // The money is captured; the ledger line is retried by the next completeHolderPayment call.
    process.stderr.write(`[settled] recording holder capture ${bill.holder.captureId} on ${bill.invoiceId} failed: ${err?.message || err}\n`)
    bill.notices = [...bill.notices, { at: now(), text: 'Your payment was captured and is being recorded on the invoice.' }]
  }
}
