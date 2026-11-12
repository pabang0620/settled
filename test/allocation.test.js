import { reset, patronWith } from './helpers.js'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildAllocations, dominates, feasibleSubsets, isUrgent, validateOption } from '../server/allocation.js'
import { documentView, seedPlanBills, seedSession } from '../server/seed.js'
import { planAllocations, proposeBatch, budgetFromText } from '../server/agent/allocations.js'
import { createSession } from '../server/store.js'
import { analyzeDocument } from '../server/agent/bills.js'
import { now } from '../server/clock.js'

beforeEach(reset)

const shutoff = (days) => ({ kind: 'shutoff', date: new Date(now() + days * 86400000).toISOString().slice(0, 10), days })
const mk = (billId, matchCents, urgency = { kind: 'none', days: 0 }) => ({ billId, invoiceNumber: billId, matchCents, urgency })

function metrics(subset) {
  return { count: subset.length, urgent: subset.filter(isUrgent).length, spend: subset.reduce((s, c) => s + c.matchCents, 0) }
}

// Brute force: no affordable set of bills may beat an offered option on every axis.
function assertNoneDominated(candidates, params, result) {
  const all = feasibleSubsets(candidates, params)
  for (const option of result.options) {
    const m = { count: option.count, urgent: option.urgentCovered, spend: option.totalCents }
    for (const other of all) assert.equal(dominates(other, m), false, `option ${option.id} is dominated`)
  }
}

test('JUDGE_5: the demo candidates give two options and neither is dominated by any affordable set of bills', () => {
  const candidates = [mk('INV-1187', 4120, shutoff(4)), mk('INV-1203', 11840, shutoff(5)), mk('INV-1211', 4410), mk('INV-1214', 5230), mk('INV-1226', 6180), mk('INV-1231', 7950)]
  const params = { budgetCents: 30000, capCents: 12000 }
  const result = buildAllocations(candidates, params)
  assert.equal(result.options.length, 2)
  const [a, b] = result.options
  assert.equal(a.totalCents, 25600)
  assert.equal(a.count, 4)
  assert.equal(a.urgentCovered, 2)
  assert.deepEqual(a.bills.map((x) => x.invoiceNumber), ['INV-1187', 'INV-1203', 'INV-1211', 'INV-1214'])
  assert.equal(b.totalCents, 27890)
  assert.equal(b.count, 5)
  assert.deepEqual(b.leavesUrgent, ['INV-1203'])
  assert.ok(result.tradeoff)
  assertNoneDominated(candidates, params, result)
  assert.ok(result.options.every((o) => validateOption(o, params)))
})

test('JUDGE_5: the old numbers (Plan B dominated by Plan A plus two cheaper bills) now collapse to one option', () => {
  const candidates = [mk('A', 4120, shutoff(4)), mk('B', 9680, shutoff(5)), mk('C', 5493), mk('D', 7627), mk('E', 11710)]
  const params = { budgetCents: 30000, capCents: 12000 }
  const result = buildAllocations(candidates, params)
  assertNoneDominated(candidates, params, result)
  const old = result.options.find((o) => o.totalCents === 28950)
  assert.equal(old, undefined)
})

test('property: for random candidate sets no offered option is dominated, and options respect budget and cap', () => {
  let seed = 7
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  for (let round = 0; round < 150; round += 1) {
    const n = 2 + rand(9)
    const candidates = Array.from({ length: n }, (_, i) => mk(`B${i}`, 1000 + rand(11000), rand(3) === 0 ? shutoff(1 + rand(9)) : { kind: 'none', days: 0 }))
    const params = { budgetCents: 10000 + rand(30000), capCents: 6000 + rand(6000) }
    const result = buildAllocations(candidates, params)
    assertNoneDominated(candidates, params, result)
    for (const o of result.options) {
      assert.ok(o.totalCents <= params.budgetCents)
      assert.ok(o.bills.every((b) => b.matchCents <= params.capCents))
      assert.ok(validateOption(o, params))
    }
    if (result.options.length > 1) {
      const [a, b] = result.options
      assert.ok(a.urgentCovered >= b.urgentCovered && b.count >= a.count)
    }
  }
})

test('a single best set is offered once, labelled as the best fit', () => {
  const candidates = [mk('A', 3000, shutoff(2)), mk('B', 4000, shutoff(3))]
  const result = buildAllocations(candidates, { budgetCents: 30000, capCents: 12000 })
  assert.equal(result.options.length, 1)
  assert.equal(result.options[0].objective, 'best_fit')
  assert.equal(result.tradeoff, false)
})

test('the agent plan on the prepared demo bills: A = 4 bills $256.00, B = 5 bills $278.90, flaky ledger skipped, cards in shutoff order', async () => {
  const patron = patronWith()
  await seedPlanBills(patron)
  const plan = await planAllocations(patron, 'Use my last $300 this month, most urgent first')
  assert.equal(plan.skipped.length, 1)
  assert.match(plan.skipped[0].reason, /ledger timeout/)
  assert.equal(plan.options.length, 2)
  assert.equal(plan.options[0].totalCents, 25600)
  assert.equal(plan.options[1].totalCents, 27890)
  assert.ok(plan.events.some((e) => e.tool === 'draft_allocations'))
  assert.match(plan.narrative, /Plan A/)
  const batch = await proposeBatch(patron, 'A')
  assert.deepEqual(batch.cards.map((c) => c.invoiceNumber), ['INV-1187', 'INV-1203', 'INV-1211', 'INV-1214'])
  assert.equal(batch.cards[0].matchCents, 4120)
  assert.equal(batch.cards[1].matchCents, 11840)
  assert.equal(JSON.stringify(batch).includes('DEMOPAYER'), false)
})

test('the saved budget can be lowered by the sentence but never raised', async () => {
  const patron = patronWith({ monthlyBudgetCents: 20000, perBillCapCents: 12000 })
  assert.equal(budgetFromText('Use my last $100', patron), 10000)
  assert.equal(budgetFromText('Use $9,000 now', patron), 20000)
  assert.equal(budgetFromText('most urgent first', patron), 20000)
})

test('document text about a final notice does not change the plan order: urgency is the biller date', async () => {
  const session = createSession()
  const seeded = await seedSession(session, 'riverside', { totalCents: 8240, disconnectDate: '2099-01-01' })
  const hidden = seeded.documents.find((d) => d.kind === 'hidden_instruction')
  assert.match(documentView(hidden).text, /FINAL DISCONNECTION NOTICE/)
  const analysis = await analyzeDocument(session, hidden.id)
  assert.equal(analysis.decision.route, 'R3')
  assert.equal(seeded.bill.disconnectDate, '2099-01-01')
})
