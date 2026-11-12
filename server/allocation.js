import { now } from './clock.js'

// Allocation options are computed here, in code, from server-validated candidates.
// Two objectives pull apart: cover the bills the biller says are about to be shut off, or close the most bills.
// The model may describe the options; it can not add, remove or reprice one.
export const URGENT_WINDOW_DAYS = 5
const MAX_ENUMERATED = 18

export const isUrgent = (c) => c.urgency?.kind === 'shutoff' && c.urgency.days <= URGENT_WINDOW_DAYS

const metrics = (subset) => ({
  count: subset.length,
  urgent: subset.filter(isUrgent).length,
  spend: subset.reduce((s, c) => s + c.matchCents, 0),
})

// X dominates Y when X is at least as good on every axis and strictly better on one.
export function dominates(x, y) {
  const better = x.count > y.count || x.urgent > y.urgent || x.spend < y.spend
  const noWorse = x.count >= y.count && x.urgent >= y.urgent && x.spend <= y.spend
  return noWorse && better
}

export function feasibleSubsets(candidates, { budgetCents, capCents }) {
  const pool = candidates.filter((c) => c.matchCents <= capCents).slice(0, MAX_ENUMERATED)
  const out = []
  for (let mask = 1; mask < (1 << pool.length); mask += 1) {
    const subset = pool.filter((_, i) => mask & (1 << i))
    const m = metrics(subset)
    if (m.spend <= budgetCents) out.push({ subset, ...m })
  }
  return out
}

const keyOf = (s) => s.subset.map((c) => c.billId).sort().join(',')

function best(subsets, order) {
  return subsets.reduce((top, s) => {
    if (!top) return s
    for (const [field, dir] of order) {
      if (s[field] !== top[field]) return (s[field] - top[field]) * dir > 0 ? s : top
    }
    return keyOf(s) < keyOf(top) ? s : top
  }, null)
}

const byUrgency = (a, b) => {
  const da = a.urgency?.kind === 'shutoff' ? Date.parse(a.urgency.date) : Infinity
  const db = b.urgency?.kind === 'shutoff' ? Date.parse(b.urgency.date) : Infinity
  return da - db || a.matchCents - b.matchCents
}

/**
 * Returns the options worth showing. Each option is Pareto-optimal over (bills closed, urgent bills covered, money spent):
 * no other affordable set of bills closes more, covers more urgent ones, and costs less.
 * If one objective's best set is the same as, or dominated by, the other's, only one option is returned.
 */
export function buildAllocations(candidates, { budgetCents, capCents }) {
  const subsets = feasibleSubsets(candidates, { budgetCents, capCents })
  if (!subsets.length) return { options: [], considered: candidates.length }
  const urgentFirst = best(subsets, [['urgent', 1], ['count', 1], ['spend', -1]])
  const mostClosed = best(subsets, [['count', 1], ['urgent', 1], ['spend', -1]])
  const raw = [{ id: 'A', objective: 'urgent_first', pick: urgentFirst }, { id: 'B', objective: 'most_closed', pick: mostClosed }]
  const distinct = raw.filter((o, i) => raw.findIndex((p) => keyOf(p.pick) === keyOf(o.pick)) === i)
  const kept = distinct.filter((o) => !distinct.some((p) => p !== o && dominates(p.pick, o.pick)))
  const options = kept.map((o, index) => {
    const ordered = [...o.pick.subset].sort(byUrgency)
    const urgentAll = candidates.filter(isUrgent)
    return {
      id: kept.length === 1 ? 'A' : o.id,
      objective: kept.length === 1 ? 'best_fit' : o.objective,
      bills: ordered.map((c) => ({ billId: c.billId, invoiceNumber: c.invoiceNumber, matchCents: c.matchCents, urgency: c.urgency })),
      count: o.pick.count,
      urgentCovered: o.pick.urgent,
      totalCents: o.pick.spend,
      budgetCents,
      leavesUrgent: urgentAll.filter((u) => !o.pick.subset.some((c) => c.billId === u.billId)).map((u) => u.invoiceNumber),
      position: index,
    }
  })
  return { options, considered: candidates.length, tradeoff: options.length > 1 }
}

// Server-side recheck before an option is shown or chosen.
export function validateOption(option, { budgetCents, capCents }) {
  const total = option.bills.reduce((s, b) => s + b.matchCents, 0)
  return total === option.totalCents && total <= budgetCents && option.bills.every((b) => b.matchCents <= capCents)
}

export const urgencyDaysFrom = (date, nowMs = now()) => Math.ceil((Date.parse(date) - nowMs) / 86400000)
