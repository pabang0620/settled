// X2 check through the local Claude Code account (LLM_BACKEND=account). PayPal stays on the stand-in.
// Run: LLM_BACKEND=account PAYPAL_CLIENT_ID= PAYPAL_CLIENT_SECRET= node scripts/account-check.js
import { llmLabel, modes } from '../server/config.js'

const out = (line) => process.stdout.write(`${line}\n`)
if (modes.llm !== 'live' || modes.paypal !== 'mock') {
  out(`Refusing to run: needs LLM_BACKEND=account and empty PayPal keys (llm=${modes.llm}, paypal=${modes.paypal}).`)
  process.exit(2)
}
const { createSession } = await import('../server/store.js')
const { seedSession, seedPlanBills } = await import('../server/seed.js')
const { analyzeDocument } = await import('../server/agent/bills.js')
const { planAllocations } = await import('../server/agent/allocations.js')
const { draftPatronRules } = await import('../server/agent/rules.js')
const { LOCAL_SCRIPT } = await import('../server/agent/liveGuard.js')
const { saveRules } = await import('../server/patron.js')

out(`backend: ${llmLabel()}`)
const only = process.argv[2] || 'all'
if (only === 'all' || only === 'docs') {
  const session = createSession()
  const seeded = await seedSession(session, 'riverside', { totalCents: 8240 })
  for (const doc of seeded.documents) {
    const result = await analyzeDocument(session, doc.id, LOCAL_SCRIPT)
    out(JSON.stringify({ kind: doc.kind, sources: result.sources, route: result.decision.route, code: result.decision.code, payee: result.payee?.name, instructions: result.document.instructions, amountOnPaper: result.document.amountCents, explanation: result.explanation }))
  }
}
if (only === 'all' || only === 'plan') {
  const patron = createSession()
  saveRules(patron, { monthlyBudgetCents: 30000, minHolderShare: '1/2', perBillCapCents: 25000, category: 'utilities', region: 'OH', type: 'individual' })
  await seedPlanBills(patron)
  const plan = await planAllocations(patron, 'Use my last $300 this month, most urgent first', LOCAL_SCRIPT)
  out(JSON.stringify({ source: plan.source, options: plan.options.map((o) => ({ id: o.id, count: o.count, totalCents: o.totalCents })), events: plan.events.map((e) => e.tool), narrative: plan.narrative }))
}
if (only === 'all' || only === 'rules') {
  const rules = await draftPatronRules('I can give about $200 a month, up to $120 per bill, and the holder should pay at least 1/2. I live in OH.', LOCAL_SCRIPT)
  out(JSON.stringify(rules))
}
