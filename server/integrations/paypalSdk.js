// The one place that builds the APIMatic-generated PayPal SDK client and turns its failures into the app's HttpError.
import { PaypalClient, PaypalError } from 'paypal'
import { config } from '../config.js'
import { HttpError } from '../http.js'

// This SDK declares one environment and no selector, so the host is written out here and checked.
export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'
const ATTEMPT_TIMEOUT_MS = 15000

export function assertSandboxHost(baseUrl) {
  if (new URL(baseUrl).hostname !== 'api-m.sandbox.paypal.com') {
    throw new Error(`Settled only talks to the PayPal sandbox. Refusing host ${new URL(baseUrl).hostname}.`)
  }
  return baseUrl
}

// Diagnostics go to stderr only when asked for. Request bodies are never logged.
export const diag = (line) => {
  if (process.env.PAYPAL_SDK_LOG === '1') process.stderr.write(`[paypal] ${line}\n`)
}

const sdkLogger = {
  error: (message) => diag(message),
  warn: (message) => diag(message),
  info: () => {},
  debug: () => {},
}

export function buildPaypalClient({ clientId, clientSecret, fetch, baseUrl = SANDBOX_BASE, retry = {} }) {
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be set to use the sandbox.')
  assertSandboxHost(baseUrl)
  return new PaypalClient({
    serverOptions: { baseUrl },
    oauth2: { clientId, clientSecret },
    // Reads keep the SDK retry defaults. POST is not in httpMethodsToRetry, so every write is sent once.
    retry: { timeout: ATTEMPT_TIMEOUT_MS, ...retry },
    // Level is explicit so PAYPAL_CLIENT_LOG cannot switch logging on. Bodies and headers stay off.
    logging: { level: 'warn', logger: sdkLogger, logRequestBody: false, logRequestHeaders: false, logResponseHeaders: false },
    ...(fetch ? { fetch } : {}),
  })
}

let client = null
export function getPaypalClient() {
  if (!client) client = buildPaypalClient({ clientId: config.paypalClientId, clientSecret: config.paypalClientSecret })
  return client
}

// Releasing an authorization is the payee's call: the sandbox refuses it for the app's own credentials (403), so it runs as the biller.
const billerClients = new Map()
export function getBillerPaypalClient(billerId) {
  const creds = config.billerCredentials[billerId]
  if (!creds?.clientId || !creds?.clientSecret) throw new Error(`No sandbox credentials configured for biller ${billerId}.`)
  if (!billerClients.has(billerId)) billerClients.set(billerId, buildPaypalClient({ clientId: creds.clientId, clientSecret: creds.clientSecret }))
  return billerClients.get(billerId)
}

// The API's reason, read structurally from a declared error body (name, message, details[].issue).
export function reasonOf(payload) {
  const body = payload && typeof payload === 'object' && 'body' in payload ? payload.body : null
  if (!body || typeof body !== 'object') return undefined
  const issue = body.details?.[0]?.issue
  const text = [issue || body.name, body.message].filter(Boolean).join(': ')
  return text ? text.slice(0, 200) : undefined
}

export const isUnknownOutcome = (err) =>
  err instanceof PaypalError &&
  (err.kind === 'connection' || err.kind === 'timeout' || (err.kind === 'decode' && err.status >= 200 && err.status < 300))

function fromStatus(status, reason) {
  if (status === 401 || status === 403) return new HttpError(502, "PayPal rejected Settled's own credentials.", 'paypal_credentials')
  if (status === 429) return new HttpError(503, 'PayPal is busy. Try again shortly.', 'paypal_busy')
  if (status >= 400 && status < 500) return new HttpError(status, reason || 'PayPal rejected the request.', 'paypal_rejected')
  return new HttpError(502, 'PayPal had a problem. Nothing was changed unless noted.', 'paypal_error')
}

/**
 * One translation for every call site. Returns an HttpError for what PayPal or the network did,
 * and rethrows what is outside the SDK family (a caller abort, a configuration fault, a bug).
 */
export function toHttpError(err, label) {
  if (err instanceof HttpError) return err
  if (!(err instanceof PaypalError)) throw err
  switch (err.kind) {
    case 'api': {
      const reason = reasonOf(err.payload)
      diag(`${label} failed ${err.status}: ${reason || 'no reason'} debug=${err.payload?.body?.debugId || 'n/a'}`)
      return fromStatus(err.status, reason)
    }
    case 'decode':
      diag(`${label} answered ${err.status} with a body that did not decode`)
      return err.status >= 200 && err.status < 300
        ? new HttpError(502, 'PayPal answered with something Settled could not read.', 'paypal_unreadable')
        : fromStatus(err.status, undefined)
    case 'connection':
    case 'timeout':
      diag(`${label} had no response (${err.kind})`)
      return new HttpError(502, 'PayPal could not be reached.', 'paypal_unreachable')
    default:
      diag(`${label} never left (${err.kind})`)
      return new HttpError(500, 'PayPal integration is misconfigured.', 'integration_defect')
  }
}
