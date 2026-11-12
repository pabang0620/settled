import { holdReleasesAt } from './matching.js'
import { aliasOf } from './store.js'
import { billerOf, loadLedger } from './ledger.js'
import { selfPaidCents, statusClass } from './bills.js'
import { holderPart, matchPart } from './money.js'
import { patronDemand } from './patron.js'
import { messagesFor } from './messages.js'
import { config } from './config.js'

// The holder's view of their own bill. Patron identity appears only as an alias.
export async function holderBillView(session, bill) {
  const biller = billerOf(bill)
  let ledger = null
  try {
    ledger = await loadLedger(bill)
  } catch {
    ledger = null
  }
  const demand = patronDemand(biller)
  const total = ledger?.totalCents ?? null
  return {
    id: bill.id,
    billerName: biller.name,
    invoiceNumber: bill.invoiceNumber,
    accountMask: `••${String(bill.accountRef).slice(-4)}`,
    sponsorable: bill.sponsorable,
    disconnectDate: bill.disconnectDate,
    dueDate: ledger?.dueDate ?? null,
    ledgerStatus: ledger?.status ?? 'UNKNOWN',
    statusClass: ledger ? statusClass(ledger.status) : 'unknown',
    totalCents: total,
    dueCents: ledger?.dueCents ?? null,
    paymentModes: biller.paymentModes,
    payPageLink: biller.paymentModes.includes('payee_order') ? null : ledger?.payPageLink ?? null,
    share: bill.share,
    shareOptions: biller.allowedShares.map((share) => ({ share, holderCents: total == null ? null : holderPart(total, share), matchCents: total == null ? null : matchPart(total, share), patronsMatching: demand.byShare[share] })),
    defaultShare: biller.holderShare,
    demandLine: `${demand.requireAtLeastHalf} of ${demand.total} patrons matching ${biller.name} bills require you to pay at least 1/2`,
    holder: { status: bill.holder.status, amountCents: bill.holder.amountCents, recorded: bill.holder.ledgerRecorded, selfPaidCents: ledger ? selfPaidCents(bill, ledger) : null, approvalUrl: bill.holder.status === 'ordered' ? bill.holder.approvalUrl : null, orderId: bill.holder.orderId },
    match: {
      status: bill.match.status,
      amountCents: bill.match.amountCents,
      patron: bill.match.patronSessionId ? aliasOf(bill.match.patronSessionId, 'Patron') : null,
      chargeAfter: bill.match.status === 'held' ? holdReleasesAt(bill) : null,
      voidReason: bill.match.voidReason,
    },
    holdWindowMinutes: config.holderSettleMinutes,
    holderReversed: bill.holderReversed,
    closed: bill.closed,
    story: bill.story || null,
    notices: bill.notices.filter((n) => n.to === 'holder').map((n) => n.text),
    messages: messagesFor(session, bill),
    inMatchFlight: ['ordered', 'held', 'captured'].includes(bill.match.status),
  }
}

// The patron's view of a bill they hold or paid. The holder's payer id, email and account never appear.
export function patronHoldView(patron, bill) {
  const biller = billerOf(bill)
  return {
    billId: bill.id,
    billerName: biller.name,
    invoiceNumber: bill.invoiceNumber,
    holderAlias: aliasOf(bill.holder.payerId, 'Holder'),
    status: bill.match.status,
    matchCents: bill.match.amountCents,
    holderPaidCents: bill.holder.amountCents,
    chargeAfter: bill.match.status === 'held' ? holdReleasesAt(bill) : null,
    voidReason: bill.match.voidReason,
    approvalUrl: bill.match.status === 'ordered' ? bill.match.approvalUrl : null,
    orderId: bill.match.orderId,
    closed: bill.closed,
    notices: bill.notices.filter((n) => n.to === 'patron' && n.patronSessionId === patron.id).map((n) => n.text),
    messages: messagesFor(patron, bill),
    story: bill.story ? { text: bill.story, verified: false } : null,
  }
}
