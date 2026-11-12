process.env.FORCE_MOCK = '1'

const { default: test, before, after } = await import('node:test')
const { default: assert } = await import('node:assert/strict')
const { createApp } = await import('../server/app.js')
const { captureIdOfEvent } = await import('../server/webhooks.js')

let server
let base

before(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(() => server.close())

test('a webhook is refused without the sandbox keys and a webhook id (nothing is trusted unsigned)', async () => {
  const res = await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {} }) })
  assert.equal(res.status, 501)
})

test('the holder capture is read from each watched event shape', () => {
  const refund = { event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R1', links: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v2/payments/refunds/R1' }, { rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAP123' }] } }
  assert.equal(captureIdOfEvent(refund), 'CAP123')
  assert.equal(captureIdOfEvent({ event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: 'CAP9' } }), 'CAP9')
  assert.equal(captureIdOfEvent({ event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { disputed_transactions: [{ seller_transaction_id: 'CAP7' }] } }), 'CAP7')
  assert.equal(captureIdOfEvent({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'X' } }), null)
})
