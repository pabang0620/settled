// Fake fetch for the SDK adapter tests. The SDK calls fetch with one Request and no init.
import './helpers.js'
import { buildPaypalClient } from '../server/integrations/paypalSdk.js'
import { createSdkOrders } from '../server/integrations/sdkOrders.js'

const parseJson = (text) => { try { return text ? JSON.parse(text) : undefined } catch { return undefined } }
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
export const token = () => json(200, { access_token: 'T', token_type: 'Bearer', expires_in: 3600 })
export const reason = (name, issue, message = 'Request is not well-formed.') => ({ name, message, debug_id: 'dbg123', details: [{ issue }] })

const amount = { currency_code: 'USD', value: '41.20' }
export const wire = {
  created: (id = 'ORD1', intent = 'CAPTURE') => ({
    id, status: 'PAYER_ACTION_REQUIRED', intent,
    purchase_units: [{ reference_id: 'INV-1-H', invoice_id: 'INV-1-H', amount, payee: { merchant_id: 'RIVERSIDE0WATER' } }],
    links: [{ href: `https://sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'payer-action', method: 'GET' }],
  }),
  approved: (id = 'ORD1') => ({ ...wire.created(id), status: 'APPROVED', payer: { payer_id: 'PAYER1', email_address: 'p@example.com' } }),
  captured: (id = 'ORD1') => ({ id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount, final_capture: true }] } }] }),
  authorized: (id = 'ORD2') => ({ id, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED', amount }] } }] }),
  capture: () => ({ id: 'CAP2', status: 'COMPLETED', amount, final_capture: true, invoice_id: 'INV-1-M' }),
  authorization: (status) => ({ id: 'AUTH1', status, amount }),
}

/**
 * responder(call) returns a Response (or throws to simulate a lost connection). Every request is recorded.
 * onRequest runs while the request is "on the wire", so a test can read the application's own store from inside fetch.
 */
export function harness(responder, { onRequest, tokenResponse } = {}) {
  const calls = []
  const fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = request.body === null ? undefined : await request.clone().text()
    const call = { method: request.method, path: url.pathname, headers: request.headers, body, json: parseJson(body), isToken: url.pathname.endsWith('/oauth2/token') }
    calls.push(call)
    if (call.isToken) return tokenResponse ? tokenResponse() : token()
    onRequest?.(call)
    return responder(call)
  }
  const client = buildPaypalClient({ clientId: 'id', clientSecret: 'secret', fetch, retry: { maxRetries: 0 } })
  const adapter = createSdkOrders(() => client)
  const api = () => calls.filter((c) => !c.isToken)
  return { adapter, calls, api, writes: () => api().filter((c) => c.method === 'POST') }
}
