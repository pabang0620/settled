// Live model protection: per-IP hourly cap, per-host daily cap, and fallback when the model errors. No real model call is made.
import { reset, createSession } from './helpers.js'
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { config, modes } from '../server/config.js'
import { advanceClock } from '../server/clock.js'
import { setClientForTests } from '../server/agent/claude.js'
import { beginRun, resetLiveGuard, takeLiveRun, LOCAL_SCRIPT } from '../server/agent/liveGuard.js'
import { analyzeDocument } from '../server/agent/bills.js'
import { planAllocations } from '../server/agent/allocations.js'
import { draftWithSource } from '../server/agent/rules.js'
import { seedPlanBills, seedSession } from '../server/seed.js'

const SENTENCE = 'I can give about $200 a month, up to $120 per bill, and the holder should pay at least 1/2. I live in OH.'
const saved = { ...config }
let calls = 0

// A fake Anthropic client. `behavior` returns a response or throws, so no network is ever used.
const fakeClient = (behavior) => ({ messages: { create: async (args) => { calls += 1; return behavior(args) } } })
const failing = () => fakeClient(() => { throw new Error('529 overloaded (secret detail)') })

beforeEach(() => {
  reset()
  resetLiveGuard()
  calls = 0
  modes.llm = 'live'
  config.llmBackend = 'api'
  config.llmLivePerIpHour = 10
  config.llmLivePerDay = 150
  config.llmLiveTimeoutMs = 1000
})
afterEach(() => {
  modes.llm = 'mock'
  Object.assign(config, saved)
  setClientForTests(null)
})

test('hourly cap: the 11th run from one IP is refused, another IP still runs, and the window moves with the clock', () => {
  for (let i = 0; i < 10; i += 1) assert.equal(takeLiveRun('1.1.1.1').ok, true)
  assert.deepEqual(takeLiveRun('1.1.1.1'), { ok: false, reason: 'live limit reached' })
  assert.equal(takeLiveRun('2.2.2.2').ok, true)
  advanceClock(59 * 60 * 1000)
  assert.equal(takeLiveRun('1.1.1.1').ok, false)
  advanceClock(2 * 60 * 1000)
  assert.equal(takeLiveRun('1.1.1.1').ok, true)
})

test('daily cap: all IPs together stop at the host limit, then it frees after 24 hours', () => {
  config.llmLivePerDay = 3
  assert.equal(takeLiveRun('a').ok, true)
  assert.equal(takeLiveRun('b').ok, true)
  assert.equal(takeLiveRun('c').ok, true)
  assert.equal(takeLiveRun('d').ok, false)
  advanceClock(25 * 60 * 60 * 1000)
  assert.equal(takeLiveRun('d').ok, true)
})

test('a refused run takes nothing from either window', () => {
  config.llmLivePerIpHour = 1
  assert.equal(takeLiveRun('a').ok, true)
  assert.equal(takeLiveRun('a').ok, false)
  config.llmLivePerIpHour = 2
  assert.equal(takeLiveRun('a').ok, true)
  assert.equal(takeLiveRun('a').ok, false)
})

test('one action costs one run even when it makes several model calls', async () => {
  const run = beginRun('9.9.9.9')
  await run.call(async () => 1)
  await run.call(async () => 2)
  config.llmLivePerIpHour = 2
  assert.equal(takeLiveRun('9.9.9.9').ok, true)
  assert.equal(takeLiveRun('9.9.9.9').ok, false)
})

test('a model that throws: the recorded paper replays with an honest label and no raw error', async () => {
  setClientForTests(failing())
  const session = createSession()
  const seeded = await seedSession(session, 'riverside')
  const hidden = seeded.documents.find((d) => d.kind === 'hidden_instruction')
  const result = await analyzeDocument(session, hidden.id, '3.3.3.3')
  assert.equal(calls, 1)
  assert.match(result.sources.reader, /^Recorded run: Claude Sonnet, \d{4}-\d{2}-\d{2} \(live model unavailable\)$/)
  assert.match(result.sources.explainer, /^Recorded run: .*\(live model unavailable\)$/)
  assert.equal(result.decision.code, 'unbacked_instruction')
  assert.ok(result.recording)
  assert.doesNotMatch(JSON.stringify(result), /529|secret detail/)
})

test('a model that throws on a paper with no recording: the rule-based stand-in finishes the action', async () => {
  setClientForTests(failing())
  const session = createSession()
  const seeded = await seedSession(session, 'riverside', { totalCents: 9610 })
  const real = seeded.documents.find((d) => d.kind === 'real')
  const result = await analyzeDocument(session, real.id, '3.3.3.3')
  assert.equal(result.sources.reader, 'Rule-based stand-in (live model unavailable)')
  assert.equal(result.sources.explainer, 'Rule-based stand-in (live model unavailable)')
  assert.equal(result.recording, null)
  assert.equal(result.decision.route, 'R1')
})

test('cap reached: the action completes from the recording without calling the model', async () => {
  setClientForTests(failing())
  config.llmLivePerIpHour = 0
  const patron = createSession()
  await seedPlanBills(patron)
  const plan = await planAllocations(patron, 'Use my last $300 this month, most urgent first', '4.4.4.4')
  assert.equal(calls, 0)
  assert.match(plan.source, /^Recorded run: Claude Sonnet, .*\(live limit reached\)$/)
  assert.equal(plan.options.length, 2)
})

test('cap reached with an unrecorded request: rule-based stand-in, labelled with the reason', async () => {
  setClientForTests(failing())
  config.llmLiveTimeoutMs = 1000
  config.llmLivePerDay = 0
  const result = await draftWithSource('$50 a month', '5.5.5.5')
  assert.equal(calls, 0)
  assert.equal(result.source, 'Rule-based stand-in (live limit reached)')
  assert.equal(result.rules.monthlyBudgetCents, 5000)
})

test('rules draft: the recorded sentence replays when the model errors', async () => {
  setClientForTests(failing())
  const result = await draftWithSource(SENTENCE, '6.6.6.6')
  assert.match(result.source, /^Recorded run: .*\(live model unavailable\)$/)
  assert.equal(result.rules.monthlyBudgetCents, 20000)
})

test('a model that never answers times out and falls back', async () => {
  config.llmLiveTimeoutMs = 20
  setClientForTests(fakeClient(() => new Promise(() => {})))
  const result = await draftWithSource('$75 a month', '7.7.7.7')
  assert.equal(result.source, 'Rule-based stand-in (live model unavailable)')
  assert.equal(result.rules.monthlyBudgetCents, 7500)
})

test('a live answer that fails validation is treated as an error, not shown', async () => {
  setClientForTests(fakeClient(() => ({ content: [{ type: 'tool_use', name: 'draft_rules', input: { monthlyBudgetDollars: -5 } }] })))
  const result = await draftWithSource('$75 a month', '8.8.8.8')
  assert.match(result.source, /live model unavailable/)
})

test('a healthy live answer is labelled live and uses one run', async () => {
  setClientForTests(fakeClient(() => ({ content: [{ type: 'tool_use', name: 'draft_rules', input: { monthlyBudgetDollars: 80 } }] })))
  const result = await draftWithSource('about eighty a month', '10.0.0.1')
  assert.equal(result.source, 'Claude (API key)')
  assert.equal(result.rules.monthlyBudgetCents, 8000)
  assert.equal(calls, 1)
})

test('local recording scripts are not capped and their model errors are thrown, never replaced', async () => {
  setClientForTests(failing())
  config.llmLivePerIpHour = 0
  await assert.rejects(draftWithSource(SENTENCE, LOCAL_SCRIPT), /overloaded/)
  assert.equal(calls, 1)
})

test('not live: labels stay as before and no run is taken', async () => {
  modes.llm = 'mock'
  const result = await draftWithSource('$50 a month', 'x')
  assert.equal(result.source, 'stand-in parser')
  config.llmLivePerIpHour = 1
  assert.equal(takeLiveRun('x').ok, true)
})
