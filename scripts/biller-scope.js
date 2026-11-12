// Prints whether each sandbox app token carries the Invoicing scope. Never prints ids or secrets.
import 'dotenv/config'

const SANDBOX = 'https://api-m.sandbox.paypal.com'
const INVOICING = 'https://uri.paypal.com/services/invoicing'

async function scopesOf(clientId, clientSecret) {
  const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) return { ok: false, status: res.status }
  const body = await res.json()
  return { ok: true, scopes: String(body.scope || '').split(' ') }
}

const apps = [
  ['shared app', process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET],
  ['riverside app', process.env.RIVERSIDE_CLIENT_ID, process.env.RIVERSIDE_CLIENT_SECRET],
]
for (const [name, id, secret] of apps) {
  if (!id || !secret) {
    process.stdout.write(`${name}: no credentials\n`)
    continue
  }
  const result = await scopesOf(id, secret)
  if (!result.ok) process.stdout.write(`${name}: token HTTP ${result.status}\n`)
  else process.stdout.write(`${name}: ${result.scopes.length} scopes, invoicing=${result.scopes.includes(INVOICING)}\n`)
}
