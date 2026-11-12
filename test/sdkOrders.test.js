import { reset } from './helpers.js'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { orderSchema } from 'paypal'
import { getBiller } from '../server/registry.js'
import { assertSandboxHost, buildPaypalClient } from '../server/integrations/paypalSdk.js'
import { getClaim } from '../server/integrations/claims.js'
import { approvalLink, authorizationIdOf, captureIdOf } from '../server/integrations/payeeOrders.js'
import { harness, json, reason, token, wire } from './sdkHelpers.js'

beforeEach(reset)

const riverside = () => getBiller('riverside')
const holderArgs = { amountCents: 4120, invoiceId: 'INV-1-H', description: 'Your part', returnUrl: 'http://localhost:3001/?r=1', cancelUrl: 'http://localhost:3001/?c=1' }
const matchArgs = { ...holderArgs, invoiceId: 'INV-1-M' }
const lost = () => { throw new Error('socket hang up') }
const is = (call, method, suffix) => call.method === method && call.path.endsWith(suffix)

// A router: first matching rule wins. Rules are [method, pathSuffix, responder].
const route = (...rules) => (call) => {
  for (const [method, suffix, respond] of rules) if (is(call, method, suffix)) return typeof respond === 'function' ? respond(call) : respond
  return json(500, reason('UNROUTED', `${call.method} ${call.path}`))
}

async function knownOrder(h, intent = 'CAPTURE') {
  const order = await (intent === 'CAPTURE' ? h.adapter.createOrder('CAPTURE', riverside(), holderArgs) : h.adapter.createOrder('AUTHORIZE', riverside(), matchArgs))
  return order
}

test('fixtures: every hand-written response body decodes through the SDK schema', () => {
  for (const body of [wire.created(), wire.approved(), wire.captured(), wire.authorized()]) assert.doesNotThrow(() => orderSchema.decode(body))
})

test('sdk host: only the sandbox host is accepted and both credentials are required', () => {
  assert.doesNotThrow(() => assertSandboxHost('https://api-m.sandbox.paypal.com'))
  assert.throws(() => assertSandboxHost('https://api-m.paypal.com'), /only talks to the PayPal sandbox/)
  assert.throws(() => buildPaypalClient({ clientId: '', clientSecret: 'x' }), /must both be set/)
  assert.throws(() => buildPaypalClient({ clientId: 'x', clientSecret: 'y', baseUrl: 'https://api-m.paypal.com' }), /sandbox/)
})

test('sdk: a holder order is a payee order on the registered biller, in the shape the app reads', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created())]))
  const order = await h.adapter.createOrder('CAPTURE', riverside(), holderArgs)
  const [write] = h.writes()
  assert.equal(write.path, '/v2/checkout/orders')
  assert.equal(write.json.intent, 'CAPTURE')
  assert.deepEqual(write.json.purchase_units[0].payee, { merchant_id: riverside().merchantId })
  assert.deepEqual(write.json.purchase_units[0].amount, { currency_code: 'USD', value: '41.20' })
  assert.equal(write.json.purchase_units[0].invoice_id, 'INV-1-H')
  assert.deepEqual(write.json.payment_source.paypal.experience_context.user_action, 'PAY_NOW')
  assert.equal(write.json.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING')
  assert.equal(write.json.payment_source.paypal.experience_context.payment_method_preference, 'IMMEDIATE_PAYMENT_REQUIRED')
  assert.equal(write.json.payment_source.paypal.experience_context.return_url, holderArgs.returnUrl)
  assert.equal(write.headers.get('prefer'), 'return=representation')
  assert.match(write.headers.get('paypal-request-id'), /^settled-[0-9a-f]{32}$/)
  assert.equal(order.id, 'ORD1')
  assert.match(approvalLink(order), /checkoutnow/)
})

test('sdk: a match order is an AUTHORIZE order', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))]))
  await h.adapter.createOrder('AUTHORIZE', riverside(), matchArgs)
  assert.equal(h.writes()[0].json.intent, 'AUTHORIZE')
})

test('sdk: no request carries a header or body key this code did not set', async () => {
  const h = harness(route(
    ['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))],
    ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())],
    ['POST', '/authorizations/AUTH1/capture', json(201, wire.capture())],
    ['POST', '/authorizations/AUTH1/void', json(200, wire.authorization('VOIDED'))],
  ))
  await knownOrder(h, 'AUTHORIZE')
  await h.adapter.authorizeOrder('ORD2')
  await h.adapter.captureAuthorization({ authorizationId: 'AUTH1', amountCents: 4120, invoiceId: 'INV-1-M' })
  await h.adapter.voidAuthorization('AUTH1').catch(() => {})
  const allowed = new Set(['authorization', 'content-type', 'idempotency-key', 'paypal-request-id', 'prefer', 'user-agent', 'accept', 'content-length', 'accept-language', 'accept-encoding', 'sec-fetch-mode'])
  for (const call of h.api()) {
    for (const name of call.headers.keys()) assert.ok(allowed.has(name) || name.startsWith('x-apimatic-'), `unexpected header ${name} on ${call.path}`)
  }
  const [create, authorize, capture] = h.writes()
  assert.deepEqual(Object.keys(create.json).sort(), ['intent', 'payment_source', 'purchase_units'])
  assert.deepEqual(Object.keys(create.json.purchase_units[0]).sort(), ['amount', 'description', 'invoice_id', 'payee', 'reference_id'])
  assert.deepEqual(authorize.json, {}) // sandbox answers 415 without a JSON body (measured 2026-11-12)
  assert.deepEqual(Object.keys(capture.json).sort(), ['amount', 'final_capture', 'invoice_id'])
  assert.equal(capture.json.final_capture, true)
})

test('sdk: capture order returns the capture the holder code reads', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created())], ['POST', '/orders/ORD1/capture', json(201, wire.captured())]))
  await knownOrder(h)
  const captured = await h.adapter.captureOrder('ORD1')
  assert.equal(captureIdOf(captured), 'CAP1')
  assert.equal(captured.purchase_units[0].payments.captures[0].status, 'COMPLETED')
})

test('sdk: get order exposes the payer id after approval', async () => {
  const h = harness(route(['GET', '/orders/ORD1', json(200, wire.approved())]))
  const order = await h.adapter.getOrder('ORD1')
  assert.equal(order.status, 'APPROVED')
  assert.equal(order.payer.payer_id, 'PAYER1')
})

test('sdk: get capture returns the status the reversal check reads', async () => {
  const h = harness(route(['GET', '/captures/CAP1', json(200, { id: 'CAP1', status: 'REFUNDED', amount: { currency_code: 'USD', value: '41.20' } })]))
  assert.equal((await h.adapter.getCapture('CAP1')).status, 'REFUNDED')
})

// ---- DUPLICATE CLAIMS: each durable write ----
const writes = {
  'create order': {
    router: () => route(['POST', '/v2/checkout/orders', json(201, wire.created())]),
    prepare: async () => {},
    run: (h) => h.adapter.createOrder('CAPTURE', riverside(), holderArgs),
    key: `create:riverside:INV-1-H:CAPTURE:4120`,
  },
  'capture order': {
    router: () => route(['POST', '/v2/checkout/orders', json(201, wire.created())], ['POST', '/orders/ORD1/capture', json(201, wire.captured())]),
    prepare: (h) => knownOrder(h),
    run: (h) => h.adapter.captureOrder('ORD1'),
    key: 'capture-order:ORD1',
  },
  'authorize order': {
    router: () => route(['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))], ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())]),
    prepare: (h) => knownOrder(h, 'AUTHORIZE'),
    run: (h) => h.adapter.authorizeOrder('ORD2'),
    key: 'authorize-order:ORD2',
  },
  'capture authorization': {
    router: () => route(['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))], ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())], ['POST', '/authorizations/AUTH1/capture', json(201, wire.capture())]),
    prepare: async (h) => { await knownOrder(h, 'AUTHORIZE'); await h.adapter.authorizeOrder('ORD2') },
    run: (h) => h.adapter.captureAuthorization({ authorizationId: 'AUTH1', amountCents: 4120, invoiceId: 'INV-1-M' }),
    key: 'capture-auth:AUTH1',
  },
  'void authorization': {
    router: () => route(['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))], ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())], ['POST', '/authorizations/AUTH1/void', json(200, wire.authorization('VOIDED'))]),
    prepare: async (h) => { await knownOrder(h, 'AUTHORIZE'); await h.adapter.authorizeOrder('ORD2') },
    run: (h) => h.adapter.voidAuthorization('AUTH1'),
    key: 'void-auth:AUTH1',
  },
}

for (const [name, spec] of Object.entries(writes)) {
  test(`duplicate claim, ${name}: the claim exists when the request leaves, and a repeat never reaches PayPal`, async () => {
    let seenFromInside = null
    const h = harness(spec.router(), { onRequest: (call) => { if (call.method === 'POST' && call.path.endsWith(specSuffix(name))) seenFromInside = getClaim(spec.key)?.state } })
    await spec.prepare(h)
    const before = h.writes().length
    const first = await spec.run(h)
    assert.equal(seenFromInside, 'claimed', 'the claim was in the store while the request was on the wire')
    assert.equal(getClaim(spec.key).state, 'done')
    const second = await spec.run(h)
    assert.deepEqual(second, first, "the loser gets the winner's record")
    assert.equal(h.writes().length - before, 1, 'exactly one write reached PayPal')
  })

  test(`duplicate claim, ${name}: two callers at once send one write and the other is told it is in progress`, async () => {
    const h = harness(spec.router())
    await spec.prepare(h)
    const before = h.writes().length
    const results = await Promise.allSettled([spec.run(h), spec.run(h)])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const loser = results.find((r) => r.status === 'rejected')
    assert.equal(loser.reason.status, 409)
    assert.equal(loser.reason.code, 'claim_in_progress')
    assert.equal(h.writes().length - before, 1)
  })
}

function specSuffix(name) {
  return { 'create order': '/v2/checkout/orders', 'capture order': '/capture', 'authorize order': '/authorize', 'capture authorization': '/capture', 'void authorization': '/void' }[name]
}

// ---- UNKNOWN OUTCOMES ----
test('create order: lost response is settled by replay with the same request id', async () => {
  let attempt = 0
  const h = harness(route(['POST', '/v2/checkout/orders', () => (++attempt === 1 ? lost() : json(201, wire.created()))]))
  const order = await h.adapter.createOrder('CAPTURE', riverside(), holderArgs)
  assert.equal(order.id, 'ORD1')
  const posts = h.writes()
  assert.equal(posts.length, 2)
  assert.equal(posts[0].headers.get('paypal-request-id'), posts[1].headers.get('paypal-request-id'))
  assert.equal(getClaim('create:riverside:INV-1-H:CAPTURE:4120').state, 'done')
})

test('capture order: lost response is settled by get order', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created())], ['POST', '/orders/ORD1/capture', lost], ['GET', '/orders/ORD1', json(200, wire.captured())]))
  await knownOrder(h)
  const order = await h.adapter.captureOrder('ORD1')
  assert.equal(captureIdOf(order), 'CAP1')
  assert.ok(h.api().some((c) => is(c, 'GET', '/orders/ORD1')), 'the re-read request was made')
})

test('authorize order: lost response is settled by get order', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))], ['POST', '/orders/ORD2/authorize', lost], ['GET', '/orders/ORD2', json(200, wire.authorized())]))
  await knownOrder(h, 'AUTHORIZE')
  const order = await h.adapter.authorizeOrder('ORD2')
  assert.equal(authorizationIdOf(order), 'AUTH1')
  assert.ok(h.api().some((c) => is(c, 'GET', '/orders/ORD2')))
})

test('capture authorization: lost response is settled by get authorization, then the same request id returns the capture', async () => {
  let attempt = 0
  const h = harness(route(
    ['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))],
    ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())],
    ['POST', '/authorizations/AUTH1/capture', () => (++attempt === 1 ? lost() : json(200, wire.capture()))],
    ['GET', '/authorizations/AUTH1', json(200, wire.authorization('CAPTURED'))],
  ))
  await knownOrder(h, 'AUTHORIZE')
  await h.adapter.authorizeOrder('ORD2')
  const capture = await h.adapter.captureAuthorization({ authorizationId: 'AUTH1', amountCents: 4120, invoiceId: 'INV-1-M' })
  assert.equal(capture.id, 'CAP2')
  const captures = h.writes().filter((c) => c.path.endsWith('/capture'))
  assert.equal(captures.length, 2)
  assert.equal(captures[0].headers.get('paypal-request-id'), captures[1].headers.get('paypal-request-id'))
  assert.ok(h.api().some((c) => is(c, 'GET', '/authorizations/AUTH1')))
})

test('void authorization: lost response is settled by get authorization', async () => {
  const h = harness(route(
    ['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))],
    ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())],
    ['POST', '/authorizations/AUTH1/void', lost],
    ['GET', '/authorizations/AUTH1', json(200, wire.authorization('VOIDED'))],
  ))
  await knownOrder(h, 'AUTHORIZE')
  await h.adapter.authorizeOrder('ORD2')
  const voided = await h.adapter.voidAuthorization('AUTH1')
  assert.equal(voided.status, 'VOIDED')
  assert.ok(h.api().some((c) => is(c, 'GET', '/authorizations/AUTH1')))
})

test('void authorization: a 204 with no body is settled by get authorization', async () => {
  const h = harness(route(
    ['POST', '/v2/checkout/orders', json(201, wire.created('ORD2', 'AUTHORIZE'))],
    ['POST', '/orders/ORD2/authorize', json(201, wire.authorized())],
    ['POST', '/authorizations/AUTH1/void', () => new Response(null, { status: 204 })],
    ['GET', '/authorizations/AUTH1', json(200, wire.authorization('VOIDED'))],
  ))
  await knownOrder(h, 'AUTHORIZE')
  await h.adapter.authorizeOrder('ORD2')
  assert.equal((await h.adapter.voidAuthorization('AUTH1')).status, 'VOIDED')
})

test('capture order: a 2xx body missing the capture is unknown, settled by get order', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created())], ['POST', '/orders/ORD1/capture', json(201, { id: 'ORD1' })], ['GET', '/orders/ORD1', json(200, wire.captured())]))
  await knownOrder(h)
  assert.equal(captureIdOf(await h.adapter.captureOrder('ORD1')), 'CAP1')
})

test('unknown outcome stays unknown (never "failed") when the re-read finds nothing, and the next call re-reads first', async () => {
  let reads = 0
  const h = harness(route(
    ['POST', '/v2/checkout/orders', json(201, wire.created())],
    ['POST', '/orders/ORD1/capture', lost],
    ['GET', '/orders/ORD1', () => (++reads === 1 ? json(200, wire.approved()) : json(200, wire.captured()))],
  ))
  await knownOrder(h)
  await assert.rejects(h.adapter.captureOrder('ORD1'), (err) => err.status === 502 && err.code === 'outcome_unknown' && /may have gone through/.test(err.message))
  assert.equal(getClaim('capture-order:ORD1').state, 'unknown')
  const posts = h.writes().length
  assert.equal(captureIdOf(await h.adapter.captureOrder('ORD1')), 'CAP1')
  assert.equal(h.writes().length, posts, 'the second call re-read and did not send another capture')
})

test('unknown outcome: a re-read that itself fails is still unknown', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(201, wire.created())], ['POST', '/orders/ORD1/capture', lost], ['GET', '/orders/ORD1', lost]))
  await knownOrder(h)
  await assert.rejects(h.adapter.captureOrder('ORD1'), (err) => err.code === 'outcome_unknown')
})

test('capture order: a never-sent failure (token refused) makes no re-read and frees the claim', async () => {
  const { rememberOrder } = await import('../server/integrations/claims.js')
  rememberOrder('ORD9')
  const h = harness(route(), { tokenResponse: () => json(401, { error: 'invalid_client' }) })
  await assert.rejects(h.adapter.captureOrder('ORD9'), (err) => err.status === 500 && err.code === 'integration_defect')
  assert.equal(h.api().length, 0, 'no operation request and no re-read left the process')
  assert.equal(h.calls.length, 1, 'only the token request was made')
  assert.equal(getClaim('capture-order:ORD9'), null, 'the claim was released')
})

test('encode failure is a never-sent failure: no request, no re-read, claim released', async () => {
  const h = harness(route())
  const { rememberAuthorization } = await import('../server/integrations/claims.js')
  rememberAuthorization('AUTH7')
  await assert.rejects(h.adapter.captureAuthorization({ authorizationId: 'AUTH7', amountCents: 4120, invoiceId: 42 }), (err) => err.status === 500)
  assert.equal(h.api().length, 0)
  assert.equal(getClaim('capture-auth:AUTH7'), null)
})

// ---- WHEN THE API SAYS NO ----
test('a 422 reason from PayPal reaches the caller with the same status, and the claim is freed for a later try', async () => {
  let approve = false
  const h = harness(route(
    ['POST', '/v2/checkout/orders', json(201, wire.created())],
    ['POST', '/orders/ORD1/capture', () => (approve ? json(201, wire.captured()) : json(422, reason('UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not approved.')))],
  ))
  await knownOrder(h)
  await assert.rejects(h.adapter.captureOrder('ORD1'), (err) => err.status === 422 && /ORDER_NOT_APPROVED/.test(err.message))
  assert.equal(getClaim('capture-order:ORD1'), null)
  assert.equal(h.api().filter((c) => c.path.endsWith('/capture')).length, 1, 'a refusal is not retried')
  approve = true
  assert.equal(captureIdOf(await h.adapter.captureOrder('ORD1')), 'CAP1')
})

test('a 422 reason on create order reaches the caller', async () => {
  const h = harness(route(['POST', '/v2/checkout/orders', json(422, reason('UNPROCESSABLE_ENTITY', 'PAYEE_ACCOUNT_RESTRICTED'))]))
  await assert.rejects(h.adapter.createOrder('CAPTURE', riverside(), holderArgs), (err) => err.status === 422 && /PAYEE_ACCOUNT_RESTRICTED/.test(err.message))
  assert.equal(getClaim('create:riverside:INV-1-H:CAPTURE:4120'), null)
})

test('a 401 or 403 from PayPal is our credential problem: 502 with a fixed message that hides the reason', async () => {
  for (const status of [401, 403]) {
    reset()
    const h = harness(route(['POST', '/v2/checkout/orders', json(status, reason('NOT_AUTHORIZED', 'PERMISSION_DENIED', 'secret detail'))]))
    await assert.rejects(h.adapter.createOrder('CAPTURE', riverside(), holderArgs), (err) => err.status === 502 && !/PERMISSION_DENIED|secret/.test(err.message) && /credentials/.test(err.message))
  }
})

test('a 429 is 503, a 5xx is 502, and neither leaks PayPal text', async () => {
  for (const [status, expected] of [[429, 503], [500, 502], [503, 502]]) {
    reset()
    const h = harness(route(['GET', '/captures/CAP1', json(status, reason('X', 'SOMETHING_INTERNAL'))]))
    await assert.rejects(h.adapter.getCapture('CAP1'), (err) => err.status === expected && !/SOMETHING_INTERNAL/.test(err.message))
  }
})

test('a read that gets no response is 502, not a failure of the write family', async () => {
  const h = harness(route(['GET', '/orders/ORD1', lost]))
  await assert.rejects(h.adapter.getOrder('ORD1'), (err) => err.status === 502 && err.code === 'paypal_unreachable')
})

test('an unreadable 2xx on a read is 502', async () => {
  const h = harness(route(['GET', '/orders/ORD1', () => new Response('<html>gateway</html>', { status: 200 })]))
  await assert.rejects(h.adapter.getOrder('ORD1'), (err) => err.status === 502 && err.code === 'paypal_unreadable')
})

test('an error status whose body does not fit keeps its status and gets generic text', async () => {
  const h = harness(route(['GET', '/orders/ORD1', () => json(404, { unexpected: true })]))
  await assert.rejects(h.adapter.getOrder('ORD1'), (err) => err.status === 404)
})

// ---- CROSS-OPERATION INVARIANTS ----
test('sdk: a payee that is not in the registry never reaches fetch and leaves no claim', async () => {
  const h = harness(route())
  const stranger = { id: 'riverside', name: 'Fake', merchantId: 'SOMEPERSON', paymentModes: ['payee_order'] }
  await assert.rejects(h.adapter.createOrder('CAPTURE', stranger, holderArgs), /registered biller/)
  await assert.rejects(h.adapter.createOrder('CAPTURE', 'helpme@example.com', holderArgs), /registered biller/)
  assert.equal(h.calls.length, 0)
  assert.equal(getClaim('create:riverside:INV-1-H:CAPTURE:4120'), null)
})

test('sdk: capture or authorize of an order this app did not create is refused and never calls fetch', async () => {
  const h = harness(route())
  await assert.rejects(h.adapter.captureOrder('SOMEONEELSE'), (err) => err.status === 403 && err.code === 'order_not_known')
  await assert.rejects(h.adapter.authorizeOrder('SOMEONEELSE'), (err) => err.status === 403)
  assert.equal(h.calls.length, 0)
  assert.equal(getClaim('capture-order:SOMEONEELSE'), null)
})

test('sdk: void or capture of an unknown authorization is refused and never calls fetch', async () => {
  const h = harness(route())
  await assert.rejects(h.adapter.voidAuthorization('AUTHX'), (err) => err.status === 403 && err.code === 'authorization_not_known')
  await assert.rejects(h.adapter.captureAuthorization({ authorizationId: 'AUTHX', amountCents: 100, invoiceId: 'I' }), (err) => err.status === 403)
  assert.equal(h.calls.length, 0)
})

test('sdk: a non-positive or fractional amount never reaches fetch', async () => {
  const h = harness(route())
  for (const amountCents of [0, -5, 10.5, '100']) {
    await assert.rejects(h.adapter.createOrder('CAPTURE', riverside(), { ...holderArgs, amountCents }), /positive cents/)
  }
  assert.equal(h.calls.length, 0)
})
