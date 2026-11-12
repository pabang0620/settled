import { HttpError } from './http.js'
import { invoicing } from './integrations/invoicing.js'
import { assertRegistryEntry } from './registry.js'
import { config, modes } from './config.js'
import { global, getSession } from './store.js'
import { now } from './clock.js'

// S6: the app's access to a biller's PayPal account is a short allow-list.
//   get_invoice, record_payment_for_invoice (only for a capture the app itself made), create_refund.
// create_invoice and send_invoice exist only inside seedInvoice(), for sample bills.
export const ALLOWED_BILLER_CALLS = Object.freeze(['get_invoice', 'record_payment_for_invoice', 'create_refund'])

const todayKey = () => new Date(now()).toISOString().slice(0, 10)

export async function callBiller(biller, name, args) {
  assertRegistryEntry(biller)
  if (!ALLOWED_BILLER_CALLS.includes(name)) throw new HttpError(403, `Biller call ${name} is not on the allow-list.`, 'gateway_denied')
  if (name === 'get_invoice') return invoicing.getInvoice(biller.id, args.invoiceId)
  if (name === 'record_payment_for_invoice') {
    if (!args.captureId || !global.appCaptureIds.has(args.captureId)) throw new HttpError(403, 'Only a capture made by Settled can be recorded.', 'gateway_unknown_capture')
    return invoicing.recordPayment(biller.id, args)
  }
  return invoicing.createRefund(biller.id, args)
}

// The single exception: sample-bill seeding, one invoice per session and a daily cap.
export async function seedInvoice(biller, session, seed, { demoPool = false } = {}) {
  assertRegistryEntry(biller)
  if (demoPool && modes.paypal !== 'mock') throw new HttpError(409, 'Prepared bills are stand-in only.', 'prepared_mock_only')
  const owner = getSession(session.id)
  if (!owner) throw new HttpError(404, 'Session not found.', 'session_missing')
  if (global.seedDay.day !== todayKey()) global.seedDay = { day: todayKey(), count: 0 }
  if (!demoPool && global.seedDay.count >= config.seedDailyLimit) throw new HttpError(429, 'The daily sample-bill limit was reached. Try again tomorrow.', 'seed_daily_limit')
  const created = await invoicing.createInvoice(biller.id, seed)
  await invoicing.sendInvoice(biller.id, created.id)
  if (!demoPool) global.seedDay = { ...global.seedDay, count: global.seedDay.count + 1 }
  return created
}

export const registerAppCapture = (captureId) => global.appCaptureIds.add(captureId)
