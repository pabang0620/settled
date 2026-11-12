import { findBillerByName } from './registry.js'
import { shareValue } from './money.js'

// ---- S3: ledger status table ----
export const STATUS_CLASS = Object.freeze({
  DRAFT: 'blocked', SCHEDULED: 'blocked', CANCELLED: 'blocked',
  SENT: 'payable', UNPAID: 'payable', SHARED: 'payable',
  PAYMENT_PENDING: 'pending',
  PARTIALLY_PAID: 'partial',
  PAID: 'closed', MARKED_AS_PAID: 'closed', PAID_EXTERNAL: 'closed',
  REFUNDED: 'refund', PARTIALLY_REFUNDED: 'refund', MARKED_AS_REFUNDED: 'refund',
})
export const statusClass = (status) => STATUS_CLASS[status] || 'blocked'

// ---- Document versus ledger (the document is untrusted input) ----
const normalizeNumber = (s) => String(s || '').trim().toUpperCase()

/**
 * Compare what the document says with what the registry and the biller's ledger say.
 * The result only decides whether the bill can be paid. Nothing in the document reaches the payee or the amount.
 * A payment instruction in the document is never backed by the ledger (the ledger names no other payee), so it blocks the bill.
 */
export function reconcile(fields, biller, ledger) {
  const findings = []
  const add = (code, ok, detail) => findings.push({ code, ok, detail })
  const instructions = fields.instructions || []
  add('unbacked_instruction', instructions.length === 0, instructions.length ? `${instructions.length} line(s) ask for payment the ledger does not back` : 'none')
  const docBiller = findBillerByName(fields.billerName)
  add('biller_in_registry', !!docBiller && (!biller || docBiller.id === biller.id), docBiller ? docBiller.name : 'not in the registry')
  if (ledger) {
    add('invoice_in_ledger', true, ledger.number)
    add('number_match', normalizeNumber(fields.invoiceNumber) === normalizeNumber(ledger.number), `paper ${fields.invoiceNumber} / ledger ${ledger.number}`)
    add('amount_match', fields.amountCents === ledger.totalCents, `paper ${fields.amountCents} / ledger ${ledger.totalCents}`)
    add('due_match', !fields.dueDate || fields.dueDate === (ledger.dueDate || 'none'), `paper ${fields.dueDate} / ledger ${ledger.dueDate}`)
  } else {
    add('invoice_in_ledger', false, 'no invoice with this number at the biller')
  }
  return { findings, blockers: findings.filter((f) => !f.ok).map((f) => f.code), instructions }
}

// ---- The three server-decided payment paths ----
export const ROUTES = Object.freeze({ R1: 'match_on_invoice', R2: 'pay_on_invoice_page', R3: 'decline_with_next_step' })

/**
 * R1 / R2 / R3 is decided here from the registry entry, the ledger and the reconcile result.
 * The model only explains the result afterwards.
 */
export function decideRoute({ biller, ledger, reconciliation, sponsorable = false, holderReversed = false }) {
  const decline = (code, nextStep) => ({ route: 'R3', code, nextStep })
  // Highest priority: a bill that tells the payer where to send money is refused because of that instruction, whatever else matches.
  if (reconciliation.blockers.includes('unbacked_instruction')) return decline('unbacked_instruction', 'check_with_biller')
  if (!biller) return decline('biller_not_in_registry', 'ask_biller_to_join')
  if (!ledger) return decline('invoice_not_in_ledger', 'retake_or_check_number')
  if (reconciliation.blockers.length) return decline(reconciliation.blockers[0], 'retake_or_check_number')
  const klass = statusClass(ledger.status)
  if (klass === 'blocked') return decline('invoice_not_payable', 'ask_biller')
  if (klass === 'pending') return decline('payment_pending', 'wait_for_payment_to_clear')
  if (klass === 'closed') return decline('already_paid', 'nothing_to_do')
  if (klass === 'refund' || holderReversed) return decline('refund_state', 'ask_biller')
  if (biller.paymentModes.includes('payee_order')) {
    if (!sponsorable) return decline('not_sponsorable', 'ask_biller_to_enable_sponsorable')
    return { route: 'R1', code: 'ok', nextStep: 'pay_my_part' }
  }
  if (biller.paymentModes.includes('invoice_page')) return { route: 'R2', code: 'invoice_page_only', nextStep: 'open_invoice_page' }
  return decline('no_payment_mode', 'ask_biller')
}

// ---- S10: self_paid ----
// Only a holder capture that the app made AND recorded on the ledger counts. Everything else on the ledger does not.
export function selfPaidCents(bill, ledger) {
  const ids = bill.holder.captureId && bill.holder.ledgerRecorded ? [bill.holder.captureId] : []
  return ledger.payments.filter((p) => ids.includes(p.paymentId) && p.paymentId !== bill.match.captureId).reduce((s, p) => s + p.cents, 0)
}

export const holderRefundedOnLedger = (bill, ledger) => ledger.refunds.length > 0 && !!bill.holder.captureId

// ---- Redacted views ----
export const maskAccount = (ref) => `••${String(ref || '').slice(-4)}`

export function urgencyOf(bill, ledger, nowMs) {
  // Urgency is measured only from biller-owned values: the biller's shutoff date, else days past the ledger due date.
  const dayMs = 86400000
  if (bill.disconnectDate) return { kind: 'shutoff', date: bill.disconnectDate, days: Math.ceil((Date.parse(bill.disconnectDate) - nowMs) / dayMs) }
  if (ledger?.dueDate) return { kind: 'past_due', date: ledger.dueDate, days: Math.floor((nowMs - Date.parse(ledger.dueDate)) / dayMs) }
  return { kind: 'none', date: null, days: 0 }
}

export const meetsHolderFloor = (billShare, floorShare) => shareValue(billShare) >= shareValue(floorShare)
