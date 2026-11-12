import { config, modes } from './config.js'
import { HttpError } from './http.js'
import { allBills } from './store.js'
import { flagDispute, recheckBill } from './matching.js'
import { SANDBOX_BASE } from './integrations/paypalSdk.js'

// VERIFY V9: PayPal webhooks for a refund, reversal or dispute on a holder's capture. A verified event re-reads the
// bill right away (the settle job would only see it on its next run), so an open hold is released inside the window.
// Only events whose signature PayPal's verify-webhook-signature accepts for PAYPAL_WEBHOOK_ID are acted on.
const WATCHED = new Set(['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'CUSTOMER.DISPUTE.CREATED'])
const recent = []
const seen = new Set()

export const webhookStatus = () => ({ enabled: modes.paypal === 'sandbox' && Boolean(config.paypalWebhookId), count: recent.length, last: recent.at(-1) || null })

// The holder capture an event is about: a refund links "up" to its capture, a reversal carries the capture itself,
// a dispute lists the seller transaction.
export function captureIdOfEvent(event) {
  const r = event?.resource || {}
  if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    const up = (r.links || []).find((l) => l.rel === 'up' && /\/captures\//.test(l.href || ''))
    return up ? up.href.split('/captures/')[1].split(/[/?]/)[0] : null
  }
  if (event.event_type === 'PAYMENT.CAPTURE.REVERSED') return r.id || null
  if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') return r.disputed_transactions?.[0]?.seller_transaction_id || null
  return null
}

async function verifySignature(headers, event) {
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64')
  const tokenRes = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!tokenRes.ok) return 'FAILURE'
  const { access_token: token } = await tokenRes.json()
  const res = await fetch(`${SANDBOX_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypalWebhookId,
      webhook_event: event,
    }),
  })
  if (!res.ok) return 'FAILURE'
  return (await res.json()).verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE'
}

export async function handleWebhook(req, res) {
  if (modes.paypal !== 'sandbox' || !config.paypalWebhookId) {
    throw new HttpError(501, 'Webhooks need the sandbox keys and PAYPAL_WEBHOOK_ID. The settle job checks the ledger and the capture status instead.', 'webhooks_off')
  }
  const event = req.body
  if (!event || typeof event !== 'object' || typeof event.event_type !== 'string') throw new HttpError(400, 'Not a PayPal webhook event.', 'bad_event')
  const verification = await verifySignature(req.headers, event).catch(() => 'FAILURE')
  if (verification !== 'SUCCESS') {
    process.stderr.write(`[settled] webhook ${String(event.id || '').slice(0, 40)} ${event.event_type} rejected: signature not verified\n`)
    throw new HttpError(401, 'Webhook signature could not be verified.', 'webhook_signature')
  }
  if (seen.has(event.id)) return res.json({ success: true, data: { duplicate: true } })
  seen.add(event.id)
  const captureId = WATCHED.has(event.event_type) ? captureIdOfEvent(event) : null
  const bill = captureId ? allBills().find((b) => b.holder.captureId === captureId) : null
  let result = null
  if (bill) result = event.event_type === 'CUSTOMER.DISPUTE.CREATED' ? await flagDispute(bill.id) : await recheckBill(bill.id)
  const entry = { id: event.id, type: event.event_type, verification, captureId, matched: Boolean(bill), holderReversed: result?.holderReversed ?? null, match: result?.match ?? null, at: new Date().toISOString() }
  recent.push(entry)
  if (recent.length > 50) recent.shift()
  process.stdout.write(`[settled] webhook ${event.id} ${event.event_type} verify-webhook-signature ${verification} capture ${captureId || '-'} ${bill ? `bill matched, holderReversed=${entry.holderReversed}, match=${entry.match}` : 'no bill'}\n`)
  res.json({ success: true, data: entry })
}
