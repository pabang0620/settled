import { randomBytes } from 'node:crypto'
import { now } from '../clock.js'
import { fromCents, toCents } from '../money.js'

// Stand-in PayPal. Response shapes follow the public Orders v2, Payments v2 and Invoicing v2 schemas.
// Only used when no sandbox credentials are set.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const state = { orders: new Map(), authorizations: new Map(), captures: new Map(), invoices: new Map(), counter: 1000 }

const mockId = (length = 17) => Array.from(randomBytes(length), (b) => ALNUM[b % ALNUM.length]).join('')
const amountOf = (cents) => ({ currency_code: 'USD', value: fromCents(cents) })
const iso = () => new Date(now()).toISOString()

export function resetMockPaypal() {
  for (const map of [state.orders, state.authorizations, state.captures, state.invoices]) map.clear()
}

function mustOrder(id) {
  const order = state.orders.get(id)
  if (!order) throw new Error(`PayPal: RESOURCE_NOT_FOUND order ${id}`)
  return order
}

export const mockOrders = {
  create({ intent, purchaseUnit }) {
    const id = mockId()
    const order = {
      id,
      intent,
      status: 'PAYER_ACTION_REQUIRED',
      create_time: iso(),
      purchase_units: [{
        reference_id: purchaseUnit.reference_id || 'default',
        invoice_id: purchaseUnit.invoice_id,
        description: purchaseUnit.description,
        amount: { ...purchaseUnit.amount },
        payee: { merchant_id: purchaseUnit.payee.merchant_id },
      }],
      links: [
        { rel: 'self', href: `mock://v2/checkout/orders/${id}`, method: 'GET' },
        { rel: 'payer-action', href: `mock://paypal/checkoutnow?token=${id}`, method: 'GET' },
      ],
    }
    state.orders.set(id, order)
    return structuredClone(order)
  },
  get: (id) => structuredClone(mustOrder(id)),
  // Stands in for the payer clicking "Pay" on PayPal's own page.
  approve(id, payer) {
    const order = mustOrder(id)
    if (order.status !== 'PAYER_ACTION_REQUIRED') throw new Error('PayPal: ORDER_ALREADY_APPROVED')
    order.status = 'APPROVED'
    order.payer = { payer_id: payer.payer_id, email_address: payer.email_address, name: payer.name }
    return structuredClone(order)
  },
  capture(id) {
    const order = mustOrder(id)
    if (order.intent !== 'CAPTURE') throw new Error('PayPal: ORDER_NOT_CAPTURABLE intent is AUTHORIZE')
    if (order.status !== 'APPROVED') throw new Error('PayPal: ORDER_NOT_APPROVED')
    const unit = order.purchase_units[0]
    const capture = { id: mockId(), status: 'COMPLETED', amount: { ...unit.amount }, final_capture: true, invoice_id: unit.invoice_id, create_time: iso() }
    state.captures.set(capture.id, { ...capture, merchant_id: unit.payee.merchant_id, refunded: 0 })
    unit.payments = { captures: [capture] }
    order.status = 'COMPLETED'
    return structuredClone(order)
  },
  authorize(id) {
    const order = mustOrder(id)
    if (order.intent !== 'AUTHORIZE') throw new Error('PayPal: ORDER_NOT_AUTHORIZABLE intent is CAPTURE')
    if (order.status !== 'APPROVED') throw new Error('PayPal: ORDER_NOT_APPROVED')
    const unit = order.purchase_units[0]
    const authorization = { id: mockId(), status: 'CREATED', amount: { ...unit.amount }, invoice_id: unit.invoice_id, create_time: iso(), expiration_time: new Date(now() + 29 * 86400000).toISOString() }
    state.authorizations.set(authorization.id, { ...authorization, merchant_id: unit.payee.merchant_id, captured: 0 })
    unit.payments = { authorizations: [authorization] }
    order.status = 'COMPLETED'
    return structuredClone(order)
  },
}

export const mockPayments = {
  captureAuthorization({ authorizationId, amountCents, invoiceId, finalCapture }) {
    const auth = state.authorizations.get(authorizationId)
    if (!auth) throw new Error(`PayPal: RESOURCE_NOT_FOUND authorization ${authorizationId}`)
    if (auth.status === 'VOIDED' || auth.status === 'CAPTURED') throw new Error('PayPal: AUTHORIZATION_ALREADY_COMPLETED')
    if (amountCents + auth.captured > toCents(auth.amount.value)) throw new Error('PayPal: MAX_CAPTURE_AMOUNT_EXCEEDED')
    const capture = { id: mockId(), status: 'COMPLETED', amount: amountOf(amountCents), final_capture: !!finalCapture, invoice_id: invoiceId, create_time: iso() }
    state.captures.set(capture.id, { ...capture, merchant_id: auth.merchant_id, refunded: 0 })
    auth.captured += amountCents
    auth.status = finalCapture ? 'CAPTURED' : 'PARTIALLY_CAPTURED'
    return structuredClone(capture)
  },
  voidAuthorization(authorizationId) {
    const auth = state.authorizations.get(authorizationId)
    if (!auth) throw new Error(`PayPal: RESOURCE_NOT_FOUND authorization ${authorizationId}`)
    if (auth.status === 'VOIDED' || auth.status === 'CAPTURED') throw new Error('PayPal: AUTHORIZATION_ALREADY_COMPLETED')
    auth.status = 'VOIDED'
  },
  getCapture(captureId) {
    const capture = state.captures.get(captureId)
    if (!capture) throw new Error(`PayPal: RESOURCE_NOT_FOUND capture ${captureId}`)
    const status = capture.refunded === 0 ? 'COMPLETED' : capture.refunded >= toCents(capture.amount.value) ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    return { id: capture.id, status, amount: capture.amount, invoice_id: capture.invoice_id }
  },
  getAuthorization(authorizationId) {
    const auth = state.authorizations.get(authorizationId)
    if (!auth) throw new Error(`PayPal: RESOURCE_NOT_FOUND authorization ${authorizationId}`)
    return { id: auth.id, status: auth.status, amount: auth.amount }
  },
}

// Mock-only: the requester's bank or card pulls the money back (refund, dispute, stolen card).
export function mockReverseCapture(captureId) {
  const capture = state.captures.get(captureId)
  if (!capture) throw new Error(`PayPal: RESOURCE_NOT_FOUND capture ${captureId}`)
  capture.refunded = toCents(capture.amount.value)
  for (const invoice of state.invoices.values()) {
    const tx = invoice.payments.transactions.find((t) => t.note === `Settled capture ${captureId}`)
    if (!tx) continue
    invoice.refunds.transactions.push({ refund_id: mockId(10), type: 'PAYPAL', method: 'PAYPAL', amount: tx.amount, refund_date: iso().slice(0, 10) })
    invoice.refundedCents += toCents(tx.amount.value)
    refreshInvoice(invoice)
  }
}

// ---- Invoicing v2 ----
function refreshInvoice(invoice) {
  const paid = invoice.payments.transactions.reduce((s, t) => s + toCents(t.amount.value), 0)
  const net = paid - invoice.refundedCents
  invoice.paidCents = net
  invoice.due_amount = amountOf(Math.max(0, invoice.totalCents - net))
  if (invoice.forcedStatus) invoice.status = invoice.forcedStatus
  else if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED' || invoice.status === 'SCHEDULED') return
  else if (invoice.refundedCents > 0 && net <= 0) invoice.status = 'REFUNDED'
  else if (invoice.refundedCents > 0) invoice.status = 'PARTIALLY_REFUNDED'
  else if (net >= invoice.totalCents) invoice.status = 'PAID'
  else if (net > 0) invoice.status = 'PARTIALLY_PAID'
  else invoice.status = 'SENT'
}

export const mockInvoicing = {
  create({ invoice_number, totalCents, due_date, reference, recipient, allow_partial_payment, minimum_amount_due, invoicer }) {
    const id = `INV2-${mockId(4)}-${mockId(4)}-${mockId(4)}-${mockId(4)}`
    state.counter += 1
    const invoice = {
      id,
      status: 'DRAFT',
      detail: {
        invoice_number: invoice_number || `INV-${state.counter}`,
        invoice_date: iso().slice(0, 10),
        currency_code: 'USD',
        reference,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date },
      },
      invoicer,
      primary_recipients: [recipient],
      amount: amountOf(totalCents),
      due_amount: amountOf(totalCents),
      configuration: { partial_payment: { allow_partial_payment: !!allow_partial_payment, minimum_amount_due: minimum_amount_due ? amountOf(minimum_amount_due) : undefined } },
      payments: { paid_amount: amountOf(0), transactions: [] },
      refunds: { refund_amount: amountOf(0), transactions: [] },
      totalCents,
      paidCents: 0,
      refundedCents: 0,
    }
    state.invoices.set(id, invoice)
    return { rel: 'self', href: `mock://v2/invoicing/invoices/${id}`, method: 'GET', id }
  },
  send(id) {
    const invoice = mustInvoice(id)
    if (invoice.status === 'DRAFT') invoice.status = 'SENT'
    return { href: `mock://invoicing/invoices/${id}/pay`, rel: 'invoice-pay' }
  },
  get(id) {
    const invoice = mustInvoice(id)
    refreshInvoice(invoice)
    const { totalCents, paidCents, refundedCents, forcedStatus, ...publicShape } = invoice
    const out = structuredClone(publicShape)
    out.payments.paid_amount = amountOf(Math.max(0, paidCents))
    out.refunds.refund_amount = amountOf(refundedCents)
    out.links = [{ rel: 'invoice-pay-page', href: `mock://paypal.com/invoice/p/#${id}`, method: 'GET' }]
    return out
  },
  recordPayment({ invoice_id, payment_id, method, amount, note }) {
    const invoice = mustInvoice(invoice_id)
    // Same as the sandbox (2026-11-12): a payment_id is looked up and not found; entries are EXTERNAL with an EXTR- id.
    if (payment_id) throw new Error('PayPal: RESOURCE_NOT_FOUND The specified resource does not exist.')
    if (['PAID', 'MARKED_AS_PAID', 'CANCELLED', 'DRAFT'].includes(invoice.status)) throw new Error(`PayPal: INVALID_INVOICE_STATUS ${invoice.status}`)
    const cents = toCents(amount.value)
    if (cents <= 0 || cents > toCents(invoice.due_amount.value)) throw new Error('PayPal: INVALID_PAYMENT_AMOUNT')
    const id = `EXTR-${mockId(17)}`
    invoice.payments.transactions.push({ payment_id: id, type: 'EXTERNAL', method, ...(note ? { note } : {}), amount: { ...amount }, payment_date: iso().slice(0, 10) })
    refreshInvoice(invoice)
    return { payment_id: id }
  },
}

function mustInvoice(id) {
  const invoice = state.invoices.get(id)
  if (!invoice) throw new Error(`PayPal: RESOURCE_NOT_FOUND invoice ${id}`)
  return invoice
}

// Test and demo helpers that stand in for the biller's own back office.
export const mockBiller = {
  forceStatus(id, status) {
    const invoice = mustInvoice(id)
    invoice.forcedStatus = status
    if (status === 'MARKED_AS_PAID') invoice.due_amount = amountOf(0)
    refreshInvoice(invoice)
  },
  clearForcedStatus(id) {
    const invoice = mustInvoice(id)
    invoice.forcedStatus = null
    refreshInvoice(invoice)
  },
  recordExternal(id, cents) {
    return mockInvoicing.recordPayment({ invoice_id: id, method: 'CASH', amount: amountOf(cents), note: 'counter payment' })
  },
}
