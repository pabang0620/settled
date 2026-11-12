// Read-only smoke of the three SDK read operations against the real sandbox credential.
// Nothing is created or changed: each call asks for an id that does not exist, and a 404 is the pass.
// Run by hand from VERIFY.md ("SDK smoke"). Not part of npm test.
import { config } from '../server/config.js'
import { buildPaypalClient } from '../server/integrations/paypalSdk.js'
import { PaypalError } from 'paypal'

const client = buildPaypalClient({ clientId: config.paypalClientId, clientSecret: config.paypalClientSecret, retry: { maxRetries: 0 } })
const BOGUS = 'SMOKE0000000000000'

const checks = [
  ['orders.getOrder', () => client.orders.getOrder({ id: BOGUS })],
  ['payments.getCapturedPayment', () => client.payments.getCapturedPayment({ captureId: BOGUS })],
  ['payments.getAuthorizedPayment', () => client.payments.getAuthorizedPayment({ authorizationId: BOGUS })],
]

let failed = false
for (const [name, call] of checks) {
  let line
  try {
    await call()
    line = `${name}: unexpected 200 for a made-up id`
    failed = true
  } catch (err) {
    if (err instanceof PaypalError && err.kind === 'api' && err.status === 404) line = `${name}: ok (404, token and operation reachable)`
    else if (err instanceof PaypalError && err.kind === 'api') { line = `${name}: HTTP ${err.status} (401/403 means the credential or its entitlement is wrong)`; failed = true }
    else if (err instanceof PaypalError) { line = `${name}: ${err.kind} ${err.cause?.message || ''}`.trim(); failed = true }
    else throw err
  }
  process.stdout.write(`${line}\n`)
}
process.exitCode = failed ? 1 : 0
