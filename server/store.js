import { randomUUID, createHash } from 'node:crypto'
import { now } from './clock.js'
import { resetClaims } from './integrations/claims.js'

// In-memory state. Restarting the server resets every session.
const sessions = new Map()
const bills = new Map()

export const global = {
  appCaptureIds: new Set(),          // every capture the app created (holder part or match)
  seedDay: { day: '', count: 0 },    // daily sample-invoice counter (S6)
  excludedPayers: new Set(),         // payer_id values that reversed a part after the match was captured (S13)
  excludedAccounts: new Set(),       // account hashes, same reason
  accountMonths: new Map(),          // `${accountHash}:${YYYY-MM}` -> billId
}

export function resetStore() {
  sessions.clear()
  bills.clear()
  global.appCaptureIds.clear()
  global.seedDay = { day: '', count: 0 }
  global.excludedPayers.clear()
  global.excludedAccounts.clear()
  global.accountMonths.clear()
  resetClaims()
}

export const hashAccount = (billerId, accountRef) => createHash('sha256').update(`${billerId}:${accountRef}`).digest('hex').slice(0, 24)
export const aliasOf = (value, prefix) => `${prefix} #${createHash('sha256').update(String(value)).digest('hex').slice(0, 3).toUpperCase()}`
export const monthKey = (ms = now()) => new Date(ms).toISOString().slice(0, 7)

export function createSession() {
  const session = {
    id: randomUUID(),
    createdAt: now(),
    billerId: null,
    sampleSeeded: false,
    billIds: [],
    patron: { rules: null, activity: [] },
    activity: [],
  }
  sessions.set(session.id, session)
  return session
}

export const getSession = (id) => sessions.get(id) || null
export const allSessions = () => [...sessions.values()]

export function addBill(bill) {
  bills.set(bill.id, bill)
  const owner = sessions.get(bill.sessionId)
  if (owner) owner.billIds = [...owner.billIds, bill.id]
  return bill
}

export const getBill = (id) => bills.get(id) || null
export const allBills = () => [...bills.values()]

export function logActivity(session, entry) {
  const record = { at: now(), ...entry }
  session.activity = [...session.activity.slice(-199), record]
  return record
}

export function newBillRecord({ sessionId, biller, invoiceId, ledger, accountRef, sponsorable = true, disconnectDate = null, demo = false, audience = sessionId }) {
  return {
    id: randomUUID(),
    sessionId,
    audience, // the patron session that may see this bill while the feed is not public
    billerId: biller.id,
    invoiceId,
    invoiceNumber: ledger.number,
    accountRef,
    accountHash: hashAccount(biller.id, accountRef),
    sponsorable,
    disconnectDate,
    demo,
    share: null, // fixed when the holder presses "Pay my part" (S11)
    holder: { status: 'none', orderId: null, captureId: null, payerId: null, capturedAt: null, amountCents: 0, ledgerRecorded: false },
    match: { status: 'none', patronSessionId: null, patronPayerId: null, orderId: null, authorizationId: null, captureId: null, amountCents: 0, orderedAt: null, heldAt: null, ledgerRecorded: false, voidReason: null },
    holderReversed: false,
    reversedAfterCapture: false,
    closed: false,
    notices: [],
    ledgerFlaky: false,
    createdAt: now(),
  }
}
