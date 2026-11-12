// Orders v2 and Payments v2 through the APIMatic-generated PayPal SDK. Same function surface and the same
// wire-shaped results as the stand-in, so holder.js and matching.js do not know which one runs.
// Every write follows: claim -> SDK call -> record the result (see paypal-plan.md section 3).
import {
  CheckoutPaymentIntent, PayPalExperienceUserAction, PayPalWalletContextShippingPreference, PayeePaymentMethodPreference,
  capturedPaymentSchema, orderAuthorizeResponseSchema, orderSchema, paymentAuthorizationSchema,
} from 'paypal'
import { fromCents } from '../money.js'
import { HttpError } from '../http.js'
import { assertRegistryEntry } from '../registry.js'
import {
  DuplicateClaimError, claim, getClaim, isKnownAuthorization, isKnownOrder, markUnknown,
  releaseClaim, rememberAuthorization, rememberOrder, settleClaim,
} from './claims.js'
import { diag, isUnknownOutcome, toHttpError } from './paypalSdk.js'

// The responses are needed in full (ids, payer, captures), so the SDK default "return=minimal" is replaced.
const PREFER = 'return=representation'

const amountModel = (cents) => ({ currencyCode: 'USD', value: fromCents(cents) })
const omitUndefined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
const firstCapture = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0]
const firstAuthorization = (order) => order?.purchase_units?.[0]?.payments?.authorizations?.[0]

export function orderRequestModel({ intent, biller, amountCents, invoiceId, description, returnUrl, cancelUrl }) {
  return {
    intent: intent === 'AUTHORIZE' ? CheckoutPaymentIntent.Authorize : CheckoutPaymentIntent.Capture,
    purchaseUnits: [omitUndefined({
      referenceId: invoiceId,
      invoiceId,
      description,
      amount: amountModel(amountCents),
      payee: { merchantId: biller.merchantId },
    })],
    paymentSource: {
      paypal: {
        experienceContext: omitUndefined({
          returnUrl,
          cancelUrl,
          userAction: PayPalExperienceUserAction.PayNow,
          shippingPreference: PayPalWalletContextShippingPreference.NoShipping,
          paymentMethodPreference: PayeePaymentMethodPreference.ImmediatePaymentRequired,
        }),
      },
    },
  }
}

const unknownOutcome = (label) =>
  new HttpError(502, `PayPal did not confirm ${label}. Check the account before trying again; it may have gone through.`, 'outcome_unknown')

export function createSdkOrders(getClient, getBillerClient = () => getClient()) {
  // Reads: no claim, one translator.
  async function read(label, call) {
    try {
      return await call(getClient())
    } catch (err) {
      throw toHttpError(err, label)
    }
  }

  function finish(key, result, remember) {
    settleClaim(key, result)
    remember?.(result)
    return structuredClone(result)
  }

  /**
   * claim -> send -> record. A lost answer (connection, timeout, a 2xx that did not decode, a body missing what we
   * depend on) is unknown, not failed: settle() re-reads by the reference we sent. Refused or never-sent calls
   * release the claim and make no re-read.
   */
  async function durableWrite({ key, label, send, settle, complete, remember }) {
    let record
    try {
      record = claim(key)
    } catch (err) {
      if (!(err instanceof DuplicateClaimError)) throw err
      if (err.record.state === 'done') return structuredClone(err.record.result)
      if (err.record.state === 'claimed') throw new HttpError(409, `${label} is already in progress.`, 'claim_in_progress')
      const found = await settleSafely(settle, err.record.requestId, label)
      if (found) return finish(key, found, remember)
      throw unknownOutcome(label)
    }
    let result
    try {
      result = await send(record.requestId)
    } catch (err) {
      if (isUnknownOutcome(err)) return settleUnknown(key, record, { settle, remember, label })
      releaseClaim(key)
      throw toHttpError(err, label)
    }
    if (!complete(result)) return settleUnknown(key, record, { settle, remember, label })
    return finish(key, result, remember)
  }

  async function settleUnknown(key, record, { settle, remember, label }) {
    const found = await settleSafely(settle, record.requestId, label)
    if (found) return finish(key, found, remember)
    markUnknown(key)
    throw unknownOutcome(label)
  }

  // A failed re-read leaves the outcome unknown; it never turns into "failed".
  async function settleSafely(settle, requestId, label) {
    try {
      return await settle(requestId)
    } catch (err) {
      try { toHttpError(err, `${label} (re-read)`) } catch { /* outside the SDK family: still unknown */ }
      diag(`${label}: re-read did not settle`)
      return null
    }
  }

  function requireKnownOrder(id) {
    if (!isKnownOrder(id)) throw new HttpError(403, 'This order was not created by Settled.', 'order_not_known')
  }

  function requireKnownAuthorization(id) {
    if (!isKnownAuthorization(id)) throw new HttpError(403, 'This authorization did not come from Settled.', 'authorization_not_known')
  }

  const fetchOrder = async (id) => orderSchema.encode(await getClient().orders.getOrder({ id }))

  async function createOrder(intent, biller, args) {
    assertRegistryEntry(biller)
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) throw new HttpError(400, 'Order amount must be positive cents.', 'invalid_amount')
    const key = `create:${biller.id}:${args.invoiceId}:${intent}:${args.amountCents}`
    const body = orderRequestModel({ intent, biller, ...args })
    const submit = async (requestId) =>
      orderSchema.encode(await getClient().orders.createOrder({ body, payPalRequestId: requestId, prefer: PREFER }))
    return durableWrite({
      key,
      label: `The ${intent === 'AUTHORIZE' ? 'match' : 'holder'} order`,
      send: submit,
      // PayPal has no order search by invoice, so the lost create is settled by replaying with the same request id.
      settle: submit,
      complete: (order) => Boolean(order?.id),
      remember: (order) => rememberOrder(order.id),
    })
  }

  async function captureOrder(id) {
    requireKnownOrder(id)
    return durableWrite({
      key: `capture-order:${id}`,
      label: 'The capture',
      send: async (requestId) => orderSchema.encode(await getClient().orders.captureOrder({ id, payPalRequestId: requestId, prefer: PREFER, body: {} })),
      settle: async () => {
        const order = await fetchOrder(id)
        return order.status === 'COMPLETED' && firstCapture(order)?.id ? order : null
      },
      complete: (order) => Boolean(firstCapture(order)?.id),
    })
  }

  async function authorizeOrder(id) {
    requireKnownOrder(id)
    return durableWrite({
      key: `authorize-order:${id}`,
      label: 'The hold',
      send: async (requestId) => orderAuthorizeResponseSchema.encode(await getClient().orders.authorizeOrder({ id, payPalRequestId: requestId, prefer: PREFER, body: {} })),
      settle: async () => {
        const order = await fetchOrder(id)
        return firstAuthorization(order)?.id ? order : null
      },
      complete: (order) => Boolean(firstAuthorization(order)?.id),
      remember: (order) => rememberAuthorization(firstAuthorization(order).id),
    })
  }

  async function captureAuthorization({ authorizationId, amountCents, invoiceId }) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new HttpError(400, 'Capture amount must be positive cents.', 'invalid_amount')
    requireKnownAuthorization(authorizationId)
    const send = async (requestId) =>
      capturedPaymentSchema.encode(await getClient().payments.captureAuthorizedPayment({
        authorizationId,
        payPalRequestId: requestId,
        prefer: PREFER,
        body: { amount: amountModel(amountCents), invoiceId, finalCapture: true },
      }))
    return durableWrite({
      key: `capture-auth:${authorizationId}`,
      label: 'The match capture',
      send,
      // The authorization shows whether a capture happened; the replay with the same request id returns its id.
      settle: async (requestId) => {
        const auth = await getClient().payments.getAuthorizedPayment({ authorizationId })
        return auth.status === 'CAPTURED' || auth.status === 'PARTIALLY_CAPTURED' ? send(requestId) : null
      },
      complete: (capture) => Boolean(capture?.id),
    })
  }

  async function voidAuthorization(authorizationId, billerId) {
    requireKnownAuthorization(authorizationId)
    const asPayee = () => getBillerClient(billerId)
    return durableWrite({
      key: `void-auth:${authorizationId}`,
      label: 'The release',
      // The service may answer 204 with no body; the SDK then raises a decode error on a 2xx, which settle() resolves.
      send: async (requestId) =>
        paymentAuthorizationSchema.encode(await asPayee().payments.voidPayment({ authorizationId, payPalRequestId: requestId, prefer: PREFER })),
      settle: async () => {
        const auth = await asPayee().payments.getAuthorizedPayment({ authorizationId })
        return auth.status === 'VOIDED' ? paymentAuthorizationSchema.encode(auth) : null
      },
      complete: (auth) => auth?.status === 'VOIDED',
    })
  }

  return {
    createOrder,
    captureOrder,
    authorizeOrder,
    captureAuthorization,
    voidAuthorization,
    getOrder: (id) => read('Reading the order', async (client) => orderSchema.encode(await client.orders.getOrder({ id }))),
    getCapture: (captureId) => read('Reading the capture', async (client) => capturedPaymentSchema.encode(await client.payments.getCapturedPayment({ captureId }))),
    getClaim,
  }
}
