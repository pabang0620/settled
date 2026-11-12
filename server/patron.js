import { z } from 'zod'
import { HttpError, parse } from './http.js'
import { allBills, monthKey } from './store.js'
import { now } from './clock.js'
import { parseShare } from './money.js'

export const rulesSchema = z.object({
  monthlyBudgetCents: z.number().int().min(100).max(1000000),
  minHolderShare: z.string().refine((v) => { try { parseShare(v); return true } catch { return false } }, 'must look like 1/2'),
  perBillCapCents: z.number().int().min(100).max(1000000),
  category: z.enum(['utilities']),
  region: z.string().min(2).max(2),
  type: z.enum(['individual', 'organization']).default('individual'),
})

export const DEFAULT_RULES = Object.freeze({ monthlyBudgetCents: 30000, minHolderShare: '1/2', perBillCapCents: 12000, category: 'utilities', region: 'OH', type: 'individual' })

// Cap on what one holder (payer id) can receive in matches per month (S4).
export const PAYER_MONTHLY_MATCH_CAP_CENTS = 40000

export function saveRules(session, input) {
  const rules = parse(rulesSchema, input)
  if (rules.perBillCapCents > rules.monthlyBudgetCents) throw new HttpError(400, 'The per-bill cap can not exceed the monthly budget.', 'rules_invalid')
  session.patron = { ...session.patron, rules }
  return rules
}

export const rulesOf = (session) => session.patron.rules || DEFAULT_RULES

// S8: a match counts against the budget from the moment its order is placed until it is voided.
const COUNTED = ['ordered', 'held', 'captured']

export function spentCents(session, nowMs = now()) {
  const month = monthKey(nowMs)
  return allBills()
    .filter((b) => b.match.patronSessionId === session.id && COUNTED.includes(b.match.status) && monthKey(b.match.orderedAt ?? nowMs) === month)
    .reduce((sum, b) => sum + b.match.amountCents, 0)
}

export const remainingCents = (session) => Math.max(0, rulesOf(session).monthlyBudgetCents - spentCents(session))

export function payerMonthlyMatchCents(payerId, nowMs = now()) {
  const month = monthKey(nowMs)
  return allBills()
    .filter((b) => b.holder.payerId === payerId && COUNTED.includes(b.match.status) && monthKey(b.match.orderedAt ?? nowMs) === month)
    .reduce((sum, b) => sum + b.match.amountCents, 0)
}

// ---- What the holder sees about patron demand (computed from saved rules + the demo patrons) ----
import { allSessions } from './store.js'
import { shareValue } from './money.js'

const DEMO_PATRON_FLOORS = ['1/2', '1/2', '2/3', '1/3']

export function patronDemand(biller) {
  const floors = [
    ...DEMO_PATRON_FLOORS,
    ...allSessions().filter((s) => s.patron.rules && s.patron.rules.category === biller.category && s.patron.rules.region === biller.region).map((s) => s.patron.rules.minHolderShare),
  ]
  const byShare = Object.fromEntries(biller.allowedShares.map((share) => [share, floors.filter((f) => shareValue(share) >= shareValue(f)).length]))
  return { total: floors.length, requireAtLeastHalf: floors.filter((f) => shareValue(f) >= 0.5).length, byShare }
}
