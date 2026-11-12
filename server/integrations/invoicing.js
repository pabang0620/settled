// Invoicing calls through the PayPal Agent Toolkit, run as the biller. Mock mode uses the stand-in ledger.
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai'
import { config, modes } from '../config.js'
import { money, toCents } from '../money.js'
import { mockInvoicing } from './mockPaypal.js'

const ACTIONS = {
  invoices: { create: true, get: true, send: true, recordPayment: true },
  payments: { createRefund: true },
}

const toolkits = new Map()
let counter = 0

function toolkitFor(billerId) {
  if (toolkits.has(billerId)) return toolkits.get(billerId)
  const creds = config.billerCredentials[billerId]
  if (!creds?.clientId || !creds?.clientSecret) throw new Error(`No sandbox credentials configured for biller ${billerId}.`)
  // The toolkit defaults to the LIVE PayPal API unless context.sandbox is true.
  const toolkit = new PayPalAgentToolkit({ clientId: creds.clientId, clientSecret: creds.clientSecret, configuration: { actions: ACTIONS, context: { sandbox: true } } })
  toolkits.set(billerId, toolkit)
  return toolkit
}

async function liveCall(billerId, name, args) {
  counter += 1
  const result = await toolkitFor(billerId).handleToolCall({ id: `call_${counter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  return checkToolkitResult(name, JSON.parse(result.content))
}

// The toolkit reports a failed call as {ok:false,status,message}, not as {error}. Both are failures.
export function checkToolkitResult(name, parsed) {
  if (parsed?.ok === false) throw new Error(`PayPal ${name}: ${parsed.status || ''} ${parsed.message || parsed.code || 'failed'}`.trim())
  if (parsed?.error) throw new Error(`PayPal ${name}: ${typeof parsed.error === 'string' ? parsed.error : parsed.error.message || JSON.stringify(parsed.error)}`)
  return parsed
}

const live = modes.paypal === 'sandbox'

export const invoicing = {
  async getInvoice(billerId, invoiceId) {
    return live ? liveCall(billerId, 'get_invoice', { invoice_id: invoiceId }) : mockInvoicing.get(invoiceId)
  },
  async recordPayment(billerId, { invoiceId, captureId, amountCents }) {
    const args = { invoice_id: invoiceId, payment_id: captureId, method: 'PAYPAL', amount: money(amountCents) }
    return live ? liveCall(billerId, 'record_payment_for_invoice', args) : mockInvoicing.recordPayment(args)
  },
  async createRefund(billerId, { captureId, amountCents }) {
    if (!live) throw new Error('The stand-in has no biller-side refund; use the reverse-holder demo action.')
    return liveCall(billerId, 'create_refund', { capture_id: captureId, amount: money(amountCents) })
  },
  // Seed only (billerGateway.seedInvoice is the single caller).
  async createInvoice(billerId, seed) {
    if (!live) {
      const created = mockInvoicing.create({
        invoice_number: seed.invoiceNumber,
        totalCents: seed.totalCents,
        due_date: seed.dueDate,
        reference: seed.accountRef,
        recipient: { billing_info: { email_address: seed.recipientEmail, name: { given_name: seed.recipientName } } },
        allow_partial_payment: true,
        minimum_amount_due: seed.minimumCents,
        invoicer: { business_name: seed.billerName },
      })
      return { id: created.id }
    }
    const created = await liveCall(billerId, 'create_invoice', {
      currency_code: 'USD',
      invoice_number: seed.invoiceNumber,
      reference: seed.accountRef,
      invoicer_business_name: seed.billerName,
      primary_recipients: [{ billing_info: { email_address: seed.recipientEmail, name: { given_name: seed.recipientName } } }],
      items: [{ name: seed.itemName, quantity: '1', unit_amount: money(seed.totalCents) }],
      allow_partial_payment: true,
      minimum_partial_payment_amount: (seed.minimumCents / 100).toFixed(2),
    })
    const id = created.id || String(created.href || '').split('/').pop()
    return { id }
  },
  async sendInvoice(billerId, invoiceId) {
    return live ? liveCall(billerId, 'send_invoice', { invoice_id: invoiceId, send_to_recipient: true }) : mockInvoicing.send(invoiceId)
  },
}

// Normalized ledger view used by the rules. Field names follow the Invoicing v2 schema.
export function readLedger(invoice) {
  return {
    invoiceId: invoice.id,
    status: invoice.status,
    number: invoice.detail?.invoice_number,
    reference: invoice.detail?.reference || '',
    dueDate: invoice.detail?.payment_term?.due_date || null,
    billerName: invoice.invoicer?.business_name || '',
    totalCents: toCents(invoice.amount?.value ?? '0'),
    dueCents: toCents(invoice.due_amount?.value ?? '0'),
    payments: (invoice.payments?.transactions || []).map((t) => ({ paymentId: t.payment_id || null, type: t.type, method: t.method, cents: toCents(t.amount.value) })),
    refunds: (invoice.refunds?.transactions || []).map((r) => ({ refundId: r.refund_id, cents: toCents(r.amount.value) })),
    payPageLink: invoice.links?.find((l) => l.rel === 'invoice-pay-page')?.href || null,
  }
}
