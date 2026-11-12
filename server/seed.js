import { randomInt, randomUUID } from 'node:crypto'
import { HttpError } from './http.js'
import { now } from './clock.js'
import { config, modes } from './config.js'
import { getBiller } from './registry.js'
import { addBill, allBills, createSession, newBillRecord } from './store.js'
import { seedInvoice } from './billerGateway.js'
import { readLedger } from './integrations/invoicing.js'
import { callBiller } from './billerGateway.js'
import { minimumDue } from './money.js'
import { DOC_KINDS, renderDocument } from './documents.js'
import { completeHolderPayment, startHolderPayment } from './holder.js'
import { mockOrders } from './integrations/mockPaypal.js'

const DAY = 86400000
const isoDay = (offsetDays) => new Date(now() + offsetDays * DAY).toISOString().slice(0, 10)
const AMOUNTS = [8240, 9610, 12000, 6430, 7280, 10150]
// On the stand-in, the Riverside sample uses the same invoice values as the recorded real-model run,
// so a replayed recording describes the paper the judge sees (server/recorded-runs/). The account number stays
// per session, because one biller account may have only one open matched bill a month (S4).
export const RECORDED_SAMPLE = Object.freeze({ invoiceNumber: 'INV-4821', totalCents: 8240, dueDate: '2026-11-05' })
const pinnedSample = (billerKey, options) => (modes.paypal === 'mock' && billerKey === 'riverside' && options.totalCents == null && options.invoiceNumber == null ? RECORDED_SAMPLE : {})

// Documents are kept per session so a judge sees only the bills they created.
const documents = new Map()
export const getDocument = (id) => documents.get(id) || null

function makeDocuments(session, billRecord, fields) {
  const kinds = fields.unknown ? ['real'] : DOC_KINDS
  return kinds.map((kind) => {
    const doc = { id: randomUUID(), sessionId: session.id, billId: billRecord?.id || null, kind, text: renderDocument({ kind, ...fields }) }
    documents.set(doc.id, doc)
    return doc
  })
}

export const documentView = (doc) => ({ id: doc.id, kind: doc.kind, text: doc.text, billId: doc.billId })

/**
 * "Try a sample bill": the biller-side seed path creates a fresh invoice for this session (S6 exception).
 * One open sample per biller per session; the daily cap is enforced by the gateway.
 */
export async function seedSession(session, billerKey, options = {}) {
  if (billerKey === 'unknown') {
    const fields = { billerName: 'Unknown Power Co.', invoiceNumber: `UP-${randomInt(1000, 9999)}`, amountCents: 9400, dueDate: isoDay(-3), accountRef: `UP-${randomInt(1000, 9999)}`, unknown: true }
    return { bill: null, documents: makeDocuments(session, null, fields).map(documentView) }
  }
  const biller = getBiller(billerKey)
  if (!biller) throw new HttpError(404, 'Unknown biller.', 'biller_unknown')
  const existing = allBills().find((b) => b.sessionId === session.id && b.billerId === biller.id && !b.closed && !b.demo)
  if (existing) {
    const docs = [...documents.values()].filter((d) => d.billId === existing.id).map(documentView)
    return { bill: existing, documents: docs, reused: true }
  }
  const pinned = pinnedSample(billerKey, options)
  const totalCents = options.totalCents ?? pinned.totalCents ?? AMOUNTS[randomInt(0, AMOUNTS.length)]
  const invoiceNumber = options.invoiceNumber ?? pinned.invoiceNumber ?? `INV-${randomInt(1100, 9999)}`
  const accountRef = options.accountRef ?? pinned.accountRef ?? `${biller.id.slice(0, 2).toUpperCase()}-${randomInt(1000, 9999)}`
  const dueDate = options.dueDate ?? pinned.dueDate ?? isoDay(-7)
  const created = await seedInvoice(biller, session, {
    invoiceNumber,
    totalCents,
    dueDate,
    accountRef,
    billerName: biller.name,
    itemName: `${biller.name} statement`,
    recipientEmail: `holder+${session.id.slice(0, 8)}@example.com`,
    recipientName: 'Sample Holder',
    minimumCents: minimumDue(totalCents, biller.allowedShares),
  }, { demoPool: options.demoPool })
  const ledger = readLedger(await callBiller(biller, 'get_invoice', { invoiceId: created.id }))
  const bill = addBill(newBillRecord({
    sessionId: session.id,
    biller,
    invoiceId: created.id,
    ledger,
    accountRef,
    sponsorable: options.sponsorable ?? true,
    disconnectDate: options.disconnectDate === undefined ? isoDay(5) : options.disconnectDate,
    demo: !!options.demoPool,
    audience: options.audience ?? session.id,
  }))
  session.sampleSeeded = true
  return { bill, documents: makeDocuments(session, bill, { billerName: biller.name, invoiceNumber: ledger.number, amountCents: ledger.totalCents, dueDate: ledger.dueDate, accountRef }).map(documentView) }
}

// ---- Prepared bills (stand-in only): holders who already paid their part, built through the real code path ----
const PLAN_BILLS = [
  { invoiceNumber: 'INV-1187', total: 8240, shutoffInDays: 4 },
  { invoiceNumber: 'INV-1203', total: 23680, shutoffInDays: 5 },
  { invoiceNumber: 'INV-1211', total: 8820, shutoffInDays: null },
  { invoiceNumber: 'INV-1214', total: 10460, shutoffInDays: null },
  { invoiceNumber: 'INV-1226', total: 12360, shutoffInDays: null },
  { invoiceNumber: 'INV-1231', total: 15900, shutoffInDays: null },
  { invoiceNumber: 'INV-1219', total: 7600, shutoffInDays: null, flaky: true },
]

let payerCounter = 0
// Prepared bills start with the holder's window already over, so a hold on one can be charged at the next settle run
// whatever HOLDER_SETTLE_MINUTES is.
async function preparedBill({ invoiceNumber, total, shutoffInDays, flaky }, audience) {
  if (modes.paypal !== 'mock') throw new HttpError(409, 'Prepared bills exist only on the stand-in. In the sandbox, prepare them as described in VERIFY.md.', 'prepared_mock_only')
  const holder = createSession()
  payerCounter += 1
  const { bill } = await seedSession(holder, 'riverside', {
    invoiceNumber,
    totalCents: total,
    accountRef: `RW-${3000 + payerCounter}`,
    dueDate: isoDay(-7 - (payerCounter % 4)),
    disconnectDate: shutoffInDays == null ? null : isoDay(shutoffInDays),
    demoPool: true,
    audience: audience.id,
  })
  const started = await startHolderPayment(holder, bill.id, '1/2', {})
  mockOrders.approve(started.orderId, { payer_id: `DEMOPAYER${String(payerCounter).padStart(3, '0')}`, email_address: `holder${payerCounter}@example.com`, name: { given_name: 'Demo', surname: `Holder${payerCounter}` } })
  await completeHolderPayment(holder, bill.id)
  const settleMs = config.holderSettleMinutes * 60000
  bill.holder = { ...bill.holder, capturedAt: now() - settleMs - 60000 }
  bill.ledgerFlaky = !!flaky
  return bill
}

export async function seedPlanBills(patron) {
  const bills = []
  for (const spec of PLAN_BILLS) bills.push(await preparedBill(spec, patron))
  return bills
}

// "Watch one bill get settled": one prepared bill whose window already passed.
export async function takeFromPool(patron, counter = 1230 + payerCounter) {
  return preparedBill({ invoiceNumber: `INV-${counter}`, total: 8240, shutoffInDays: 3 }, patron)
}
