process.env.FORCE_MOCK = '1'
process.env.HOLDER_SETTLE_MINUTES = '0'
process.env.OPS_KEY = 'ops-secret'
process.env.PUBLIC_FEED = '1'

const { default: test, before, after } = await import('node:test')
const { default: assert } = await import('node:assert/strict')
const { createApp } = await import('../server/app.js')

let server
let base

before(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(() => server.close())

async function call(method, path, { session, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session-Id': session } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

const newSession = async () => (await call('POST', '/session')).json.data.sessionId

test('HTTP: requests without a session are refused, bad input is a 400, errors share one shape', async () => {
  assert.equal((await call('GET', '/state')).status, 401)
  const session = await newSession()
  const bad = await call('POST', '/samples', { session, body: { biller: 'someone-else' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.success, false)
  const badRules = await call('PUT', '/patron/rules', { session, body: { monthlyBudgetCents: -5 } })
  assert.equal(badRules.status, 400)
  assert.equal((await call('POST', '/ops/settle')).status, 403)
  assert.equal((await call('POST', '/ops/settle', { headers: { 'x-ops-key': 'ops-secret' } })).status, 200)
})

test('HTTP: the whole demo path through the API (sample bill, read, pay my part, patron hold, charge, PAID)', async () => {
  const holder = await newSession()
  const sample = (await call('POST', '/samples', { session: holder, body: { biller: 'riverside' } })).json.data
  const real = sample.documents.find((d) => d.kind === 'real')
  const analysis = (await call('POST', `/documents/${real.id}/analyze`, { session: holder })).json.data
  assert.equal(analysis.decision.route, 'R1')
  assert.deepEqual(analysis.sources.route, 'server')

  const started = (await call('POST', `/bills/${sample.billId}/holder/start`, { session: holder, body: { share: '1/2' } })).json.data
  assert.match(started.approvalUrl, /^mock:/)
  await call('POST', '/mock-paypal/approve', { session: holder, body: { orderId: started.orderId } })
  const done = await call('POST', `/bills/${sample.billId}/holder/complete`, { session: holder })
  assert.equal(done.json.data.recorded, true)

  const patron = await newSession()
  await call('PUT', '/patron/rules', { session: patron, body: { monthlyBudgetCents: 30000, minHolderShare: '1/2', perBillCapCents: 12000, category: 'utilities', region: 'OH', type: 'individual' } })
  const feed = (await call('GET', '/patron/feed', { session: patron })).json.data
  assert.equal(feed.cards.length, 1)
  assert.equal(JSON.stringify(feed).includes('buyer-'), false)
  const order = (await call('POST', `/matches/${sample.billId}/request`, { session: patron })).json.data
  await call('POST', '/mock-paypal/approve', { session: patron, body: { orderId: order.orderId, persona: 'patron' } })
  assert.equal((await call('POST', `/matches/${sample.billId}/confirm`, { session: patron })).json.data.status, 'held')
  const settled = await call('POST', `/matches/${sample.billId}/settle`, { session: patron })
  assert.equal(settled.json.data.state, 'captured')

  const state = (await call('GET', '/state', { session: holder })).json.data
  assert.equal(state.bills[0].ledgerStatus, 'PAID')
  assert.equal(state.bills[0].notices.at(-1).startsWith('Paid at the source'), true)
})

test('HTTP: another session gets 404 on a bill that is not theirs and 403 on biller-only actions', async () => {
  const holder = await newSession()
  const sample = (await call('POST', '/samples', { session: holder, body: { biller: 'riverside' } })).json.data
  const intruder = await newSession()
  assert.equal((await call('POST', `/bills/${sample.billId}/holder/start`, { session: intruder, body: { share: '1/2' } })).status, 404)
  const doc = sample.documents[0]
  assert.equal((await call('POST', `/documents/${doc.id}/analyze`, { session: intruder })).status, 404)
  assert.equal((await call('PATCH', `/biller/invoices/${sample.billId}`, { session: intruder, body: { sponsorable: false } })).status, 403)
  assert.equal((await call('POST', '/biller/login', { session: intruder, body: { billerId: 'riverside', passcode: 'wrong' } })).status, 403)
  await call('POST', '/biller/login', { session: holder, body: { billerId: 'riverside', passcode: 'demo-biller' } })
  const patched = await call('PATCH', `/biller/invoices/${sample.billId}`, { session: holder, body: { disconnectDate: '2026-11-16' } })
  assert.equal(patched.json.data.disconnectDate, '2026-11-16')
})

test('HTTP: one browser session can play both sides when it uses two PayPal accounts (private feed)', async () => {
  const { config } = await import('../server/config.js')
  config.publicFeed = false
  try {
    const me = await newSession()
    const sample = (await call('POST', '/samples', { session: me, body: { biller: 'riverside' } })).json.data
    const started = (await call('POST', `/bills/${sample.billId}/holder/start`, { session: me, body: { share: '1/2' } })).json.data
    await call('POST', '/mock-paypal/approve', { session: me, body: { orderId: started.orderId, persona: 'me' } })
    await call('POST', `/bills/${sample.billId}/holder/complete`, { session: me })
    const order = (await call('POST', `/matches/${sample.billId}/request`, { session: me })).json.data
    await call('POST', '/mock-paypal/approve', { session: me, body: { orderId: order.orderId, persona: 'patron' } })
    assert.equal((await call('POST', `/matches/${sample.billId}/confirm`, { session: me })).status, 200)
    const stranger = await newSession()
    assert.equal((await call('GET', '/patron/feed', { session: stranger })).json.data.cards.length, 0)
  } finally {
    config.publicFeed = true
  }
})

test('HTTP: the rules sentence is drafted by the stand-in and validated by zod', async () => {
  const session = await newSession()
  const draft = await call('POST', '/patron/rules/draft', { session, body: { text: '$200 a month, up to $90 per bill, holder pays at least 1/3' } })
  assert.equal(draft.status, 200)
  assert.equal(draft.json.data.monthlyBudgetCents, 20000)
  assert.equal(draft.json.data.perBillCapCents, 9000)
  assert.equal(draft.json.data.minHolderShare, '1/3')
})
