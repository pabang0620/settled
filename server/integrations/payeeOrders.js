// Payee-addressed Orders v2 and Payments v2 calls. Every dollar Settled moves goes through this file:
// the holder's part (CAPTURE order) and the patron's match (AUTHORIZE order, captured later).
// Structure follows PayPal's "Pay another account" guide (purchase_units[].payee.merchant_id).
// Live mode goes through the APIMatic-generated PayPal SDK (server/integrations/sdkOrders.js, plan in paypal-plan.md);
// without sandbox credentials the stand-in in mockPaypal.js answers with the same shapes.
import { config, modes } from '../config.js'
import { assertRegistryEntry } from '../registry.js'
import { money } from '../money.js'
import { mockOrders, mockPayments } from './mockPaypal.js'
import { getBillerPaypalClient, getPaypalClient } from './paypalSdk.js'
import { createSdkOrders } from './sdkOrders.js'

const live = modes.paypal === 'sandbox'
const sdk = live ? createSdkOrders(getPaypalClient, (billerId) => getBillerPaypalClient(billerId)) : null

function orderBody({ intent, biller, amountCents, invoiceId, description, returnUrl, cancelUrl }) {
  return {
    intent,
    purchase_units: [{
      reference_id: invoiceId,
      invoice_id: invoiceId,
      description,
      amount: money(amountCents),
      payee: { merchant_id: biller.merchantId },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
        },
      },
    },
  }
}

// S12: the biller argument must be a registry entry object. Emails and free merchant ids are not accepted.
async function createOrder(intent, biller, { amountCents, invoiceId, description, returnUrl, cancelUrl }) {
  assertRegistryEntry(biller)
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Order amount must be positive cents.')
  const args = { intent, biller, amountCents, invoiceId, description, returnUrl, cancelUrl }
  if (live) return sdk.createOrder(intent, biller, { amountCents, invoiceId, description, returnUrl, cancelUrl })
  return mockOrders.create({ intent, purchaseUnit: orderBody(args).purchase_units[0] })
}

export const createHolderOrder = (biller, args) => createOrder('CAPTURE', biller, args)
// MATCH_MODE=hold authorizes now and captures after the window; capture_after_window creates a plain CAPTURE order once the window is over.
export const createMatchOrder = (biller, args) => createOrder(config.matchMode === 'capture_after_window' ? 'CAPTURE' : 'AUTHORIZE', biller, args)

export const getOrder = async (id) => (live ? sdk.getOrder(id) : mockOrders.get(id))
export const captureOrder = async (id) => (live ? sdk.captureOrder(id) : mockOrders.capture(id))
export const authorizeOrder = async (id) => (live ? sdk.authorizeOrder(id) : mockOrders.authorize(id))

export async function captureAuthorization({ authorizationId, amountCents, invoiceId }) {
  if (!live) return mockPayments.captureAuthorization({ authorizationId, amountCents, invoiceId, finalCapture: true })
  return sdk.captureAuthorization({ authorizationId, amountCents, invoiceId })
}

export async function voidAuthorization(authorizationId, biller) {
  if (!live) return mockPayments.voidAuthorization(authorizationId)
  return sdk.voidAuthorization(authorizationId, biller.id)
}

export const getCapture = async (id) => (live ? sdk.getCapture(id) : mockPayments.getCapture(id))

export const approvalLink = (order) => order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href || null
export const captureIdOf = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null
export const captureOf = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0] || null
export const authorizationIdOf = (order) => order?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id || null
