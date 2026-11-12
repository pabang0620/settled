// Judge path with default settings, honest replay of recorded model runs, and the REVIEW_3 defect fixes.
process.env.HOLDER_SETTLE_MINUTES = ''
process.env.SETTLE_JOB_SECONDS = ''
process.env.PAYPAL_CLIENT_ID = ''
process.env.PAYPAL_CLIENT_SECRET = ''
const { reset, createSession, newBill, payHolder, patronWith, holdMatch } = await import('./helpers.js')
const { default: test, beforeEach } = await import('node:test')
const { default: assert } = await import('node:assert/strict')
const { config, PRODUCTION_WINDOW_MINUTES } = await import('../server/config.js')
const { settleMatch, requestMatch, confirmHold } = await import('../server/matching.js')
const { seedPlanBills, seedSession, RECORDED_SAMPLE } = await import('../server/seed.js')
const { mockOrders } = await import('../server/integrations/mockPaypal.js')
const { analyzeDocument, sameRecordedPaper } = await import('../server/agent/bills.js')
const { planAllocations, planTools } = await import('../server/agent/allocations.js')
const { draftPatronRules, draftSource } = await import('../server/agent/rules.js')
const { screenText } = await import('../server/screen.js')
const { buildAllocations, MAX_ENUMERATED } = await import('../server/allocation.js')
const { startTrace, endTrace } = await import('../server/agent/trace.js')
const { accountToolLoop, setSdkForTests } = await import('../server/agent/accountClaude.js')

beforeEach(reset)

test('C1: with HOLDER_SETTLE_MINUTES empty the stand-in window is 1 minute and the settle job runs every 5 seconds', () => {
  assert.equal(config.holderSettleMinutes, 1)
  assert.equal(config.settleJobSeconds, 5)
  assert.equal(PRODUCTION_WINDOW_MINUTES, 4320)
})

test('C1: a waiting settle says until when, and the hold is charged once the window is over', async () => {
  const holder = createSession()
  const bill = await newBill(holder)
  await payHolder(holder, bill)
  const patron = patronWith()
  await holdMatch(patron, bill)
  const early = await settleMatch(bill.id)
  assert.equal(early.state, 'waiting')
  assert.ok(early.chargeAfter > Date.now() && early.chargeAfter <= Date.now() + 61000)
  const { advanceClock } = await import('./helpers.js')
  advanceClock(61000)
  assert.equal((await settleMatch(bill.id)).state, 'captured')
})

test('C1: a prepared plan bill can be held and charged at once even with the production window', async () => {
  const previous = config.holderSettleMinutes
  config.holderSettleMinutes = PRODUCTION_WINDOW_MINUTES
  try {
    const patron = patronWith({ perBillCapCents: 25000 })
    const [first] = await seedPlanBills(patron)
    const order = await requestMatch(patron, first.id)
    mockOrders.approve(order.orderId, { payer_id: 'PLANPATRON1', email_address: 'p@example.com', name: { given_name: 'P', surname: 'Q' } })
    await confirmHold(patron, first.id)
    const result = await settleMatch(first.id)
    assert.equal(result.state, 'captured')
    assert.equal(result.invoiceStatus, 'PAID')
  } finally {
    config.holderSettleMinutes = previous
  }
})

test('C2: the Riverside sample on the stand-in is the recorded paper, and the hidden instruction replays the recorded Claude run', async () => {
  const session = createSession()
  const seeded = await seedSession(session, 'riverside')
  assert.equal(seeded.bill.invoiceNumber, RECORDED_SAMPLE.invoiceNumber)
  const hidden = seeded.documents.find((d) => d.kind === 'hidden_instruction')
  const result = await analyzeDocument(session, hidden.id)
  assert.match(result.sources.reader, /^Recorded run: Claude Sonnet, \d{4}-\d{2}-\d{2}$/)
  assert.match(result.sources.explainer, /^Recorded run: Claude Sonnet/)
  assert.equal(result.decision.code, 'unbacked_instruction')
  assert.deepEqual(result.findings.filter((f) => !f.ok).map((f) => f.code), ['unbacked_instruction'])
  assert.equal(result.payee.name, 'Riverside Water')
  assert.ok(result.recording.steps.some((s) => s.type === 'tool_call' && s.name === 'report_bill_fields'))
})

test('C2: a paper that differs from the recording falls back to the stand-in, never to a recording label', async () => {
  const session = createSession()
  const seeded = await seedSession(session, 'riverside', { totalCents: 9610 })
  const real = seeded.documents.find((d) => d.kind === 'real')
  const result = await analyzeDocument(session, real.id)
  assert.equal(result.sources.reader, 'stand-in reader')
  assert.equal(result.sources.explainer, 'stand-in agent')
  assert.equal(result.recording, null)
  assert.equal(sameRecordedPaper('A\nAccount: X-1\nB', 'A\nAccount: Y-2\nB'), true)
  assert.equal(sameRecordedPaper('A\nAmount due: $1.00', 'A\nAmount due: $2.00'), false)
})

test('C2: a fresh patron plan replays the recorded tool loop, and the server still computes the options', async () => {
  const patron = createSession()
  await seedPlanBills(patron)
  const plan = await planAllocations(patron, 'Use my last $300 this month, most urgent first')
  assert.match(plan.source, /^Recorded run: Claude Sonnet/)
  assert.deepEqual(plan.options.map((o) => [o.id, o.count, o.totalCents]), [['A', 4, 25600], ['B', 5, 27890]])
  const tools = plan.recording.steps.filter((s) => s.type === 'tool_call').map((s) => s.name)
  assert.equal(tools[0], 'list_open_bills')
  assert.equal(tools.at(-1), 'draft_allocations')
  const other = await planAllocations(patron, 'Use my last $200 this month')
  assert.equal(other.source, 'stand-in agent')
})

test('C2: the recorded rules sentence replays its tool input; another sentence uses the stand-in parser', async () => {
  const sentence = 'I can give about $200 a month, up to $120 per bill, and the holder should pay at least 1/2. I live in OH.'
  assert.match(draftSource(sentence), /^Recorded run/)
  const rules = await draftPatronRules(sentence)
  assert.equal(rules.monthlyBudgetCents, 20000)
  assert.equal(rules.perBillCapCents, 12000)
  assert.equal(draftSource('$50 a month'), 'stand-in parser')
})

test('A2: get_bill_detail returns the server record, a skipped reason, or a refusal; it never changes an option', async () => {
  const bill = { id: 'b1', invoiceNumber: 'INV-1', share: '1/2' }
  const ledger = { status: 'PARTIALLY_PAID', dueDate: '2026-11-01' }
  const plan = { options: [{ id: 'A', totalCents: 4120 }], tradeoff: false }
  const run = planTools({ candidates: [{ bill, ledger, check: { matchCents: 4120 } }], skipped: [{ invoiceNumber: 'INV-9', reason: 'ledger timeout' }], summary: [], plan })
  const hit = await run('get_bill_detail', { invoiceNumber: 'inv-1' })
  assert.equal(hit.result.matchCents, 4120)
  assert.equal(hit.result.ledgerStatus, 'PARTIALLY_PAID')
  assert.equal((await run('get_bill_detail', { invoiceNumber: 'INV-9' })).result.reason, 'ledger timeout')
  assert.equal((await run('get_bill_detail', { invoiceNumber: 'INV-404' })).ok, false)
  assert.equal((await run('get_bill_detail', {})).ok, false)
  assert.deepEqual((await run('draft_allocations', {})).result.options, plan.options)
})

test('C2: the account tool loop writes each tool call, its input and the final text into the trace', async () => {
  const fake = {
    tool: (name, description, shape, handler) => ({ name, handler }),
    createSdkMcpServer: ({ tools }) => ({ tools }),
    query: ({ options }) => (async function* run() {
      const tools = Object.values(options.mcpServers)[0].tools
      await tools[0].handler({ invoiceNumber: 'INV-1' })
      yield { type: 'result', subtype: 'success', result: 'done' }
    }()),
  }
  setSdkForTests(fake)
  startTrace()
  try {
    await accountToolLoop({ system: 's', user: 'u', tools: [{ name: 'get_bill_detail', description: 'd', input_schema: { type: 'object', properties: { invoiceNumber: { type: 'string' } } } }], runTool: async () => ({ ok: true, result: { x: 1 } }) })
  } finally {
    setSdkForTests(null)
  }
  const trace = endTrace()
  assert.deepEqual(trace.steps.map((s) => s.type), ['tool_call', 'text'])
  assert.deepEqual(trace.steps[0].input, { invoiceNumber: 'INV-1' })
  assert.equal(endTrace(), null)
})

test('D10: asks for more money or a side channel are blocked; a plain story about this bill passes', () => {
  for (const text of ['Could you send more next month?', 'can you send money for rent too', 'Could you also cover my phone bill', 'email me later']) {
    assert.equal(screenText(text).ok, false, text)
  }
  for (const text of ['I lost my job in June and could not pay my water bill.', 'We each paid half. Thank you.']) {
    assert.equal(screenText(text).ok, true, text)
  }
})

test('D6: above the enumeration cap the most urgent bills are compared and the plan says so', () => {
  const shutoff = (days) => ({ kind: 'shutoff', date: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10), days })
  const candidates = Array.from({ length: MAX_ENUMERATED + 2 }, (_, i) => ({ billId: `b${i}`, invoiceNumber: `INV-${i}`, matchCents: 1000 + i, urgency: i >= MAX_ENUMERATED ? shutoff(2) : { kind: 'none', days: 0 } }))
  const plan = buildAllocations(candidates, { budgetCents: 3000, capCents: 5000 })
  assert.equal(plan.truncated, true)
  assert.equal(plan.enumerated, MAX_ENUMERATED)
  // The two urgent bills sit at the end of the list but are kept in the compared pool.
  assert.ok(plan.options[0].bills.some((b) => b.invoiceNumber === `INV-${MAX_ENUMERATED}`))
})
