// Records the real model scenes through the local Claude Code account (LLM_BACKEND=account) and saves each run as a
// transcript in server/recorded-runs/. PayPal stays on the stand-in. The stand-in app replays these, labelled as recordings.
// Run: LLM_BACKEND=account PAYPAL_CLIENT_ID= PAYPAL_CLIENT_SECRET= node scripts/record-runs.js [docs|plan|rules]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config, modes } from '../server/config.js'

const out = (line) => process.stdout.write(`${line}\n`)
if (config.llmBackend !== 'account' || modes.llm !== 'live' || modes.paypal !== 'mock') {
  out(`Refusing to run: needs LLM_BACKEND=account and empty PayPal keys (llm=${modes.llm}, paypal=${modes.paypal}).`)
  process.exit(2)
}
const { createSession } = await import('../server/store.js')
const { seedSession, seedPlanBills } = await import('../server/seed.js')
const { analyzeDocument } = await import('../server/agent/bills.js')
const { planAllocations, planKey } = await import('../server/agent/allocations.js')
const { draftPatronRules } = await import('../server/agent/rules.js')
const { LOCAL_SCRIPT } = await import('../server/agent/liveGuard.js')
const { startTrace, endTrace } = await import('../server/agent/trace.js')
const { RUNS_DIR } = await import('../server/agent/recordedRuns.js')

const recordedAt = new Date().toISOString().slice(0, 10)
const base = { model: config.anthropicModel, backend: 'Claude Agent SDK, local Claude Code login (no API key)', recordedAt }
mkdirSync(RUNS_DIR, { recursive: true })

function save(scene, run) {
  writeFileSync(path.join(RUNS_DIR, `${scene}.json`), `${JSON.stringify({ scene, ...base, ...run }, null, 2)}\n`)
  out(`saved ${scene}: ${run.steps.filter((s) => s.type === 'tool_call').map((s) => s.name).join(' -> ')} (${run.durationMs} ms)`)
}

// Retry once on a transient error, as the account brief asks.
async function traced(fn) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    startTrace()
    try {
      const result = await fn()
      return { result, trace: endTrace() }
    } catch (err) {
      endTrace()
      out(`attempt ${attempt} failed: ${err.message}`)
      if (attempt === 2) throw err
    }
  }
  return null
}

const only = process.argv[2] || 'all'
if (only === 'all' || only === 'docs') {
  const session = createSession()
  const seeded = await seedSession(session, 'riverside')
  for (const doc of seeded.documents) {
    const { result, trace } = await traced(() => analyzeDocument(session, doc.id, LOCAL_SCRIPT))
    const reader = trace.steps.find((s) => s.type === 'tool_call' && s.name === 'report_bill_fields')
    save(`document-${doc.kind}`, {
      input: { documentText: doc.text },
      ...trace,
      result: { readerInput: reader.input, explanation: result.explanation, route: result.decision.route, code: result.decision.code, failedChecks: result.findings.filter((f) => !f.ok).map((f) => f.code) },
    })
  }
}
if (only === 'all' || only === 'plan') {
  const patron = createSession()
  await seedPlanBills(patron)
  const text = 'Use my last $300 this month, most urgent first'
  const { result, trace } = await traced(() => planAllocations(patron, text, LOCAL_SCRIPT))
  save('plan', {
    input: { text, planKey: planKey(text, result.options, result.skipped) },
    ...trace,
    result: { narrative: result.narrative, options: result.options.map((o) => ({ id: o.id, count: o.count, totalCents: o.totalCents })), skipped: result.skipped },
  })
}
if (only === 'all' || only === 'rules') {
  const text = 'I can give about $200 a month, up to $120 per bill, and the holder should pay at least 1/2. I live in OH.'
  const { result, trace } = await traced(() => draftPatronRules(text, LOCAL_SCRIPT))
  const call = trace.steps.find((s) => s.type === 'tool_call')
  save('rules', { input: { text }, ...trace, result: { toolInput: call.input, rules: result } })
}
