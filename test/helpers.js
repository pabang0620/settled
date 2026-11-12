process.env.FORCE_MOCK = '1'
process.env.SEED_DAILY_LIMIT = process.env.SEED_DAILY_LIMIT || '50'
process.env.PUBLIC_FEED = '1'

const { createSession, resetStore } = await import('../server/store.js')
const { resetMockPaypal, mockOrders } = await import('../server/integrations/mockPaypal.js')
const { loadDemoRegistry } = await import('../server/registry.js')
const { resetClock, advanceClock } = await import('../server/clock.js')
const { seedSession } = await import('../server/seed.js')
const { startHolderPayment, completeHolderPayment } = await import('../server/holder.js')
const { requestMatch, confirmHold } = await import('../server/matching.js')
const { saveRules } = await import('../server/patron.js')

export function reset() {
  resetStore()
  resetMockPaypal()
  resetClock()
  loadDemoRegistry()
}

export { createSession, advanceClock }

export const payer = (id) => ({ payer_id: id, email_address: `${id.toLowerCase()}@example.com`, name: { given_name: 'T', surname: id } })

export async function newBill(session, options = {}) {
  const { bill } = await seedSession(session, options.biller || 'riverside', { totalCents: 8240, ...options })
  return bill
}

// The holder pays their part through the real code path; PayPal's approval page is the only stand-in.
export async function payHolder(session, bill, { share = '1/2', payerId = `HOLDER${Math.random().toString(36).slice(2, 8).toUpperCase()}` } = {}) {
  const started = await startHolderPayment(session, bill.id, share)
  mockOrders.approve(started.orderId, payer(payerId))
  await completeHolderPayment(session, bill.id)
  return { started, payerId }
}

export function patronWith(rules = {}) {
  const patron = createSession()
  saveRules(patron, { monthlyBudgetCents: 30000, minHolderShare: '1/2', perBillCapCents: 12000, category: 'utilities', region: 'OH', type: 'individual', ...rules })
  return patron
}

export async function holdMatch(patron, bill, payerId = `PATRON${Math.random().toString(36).slice(2, 8).toUpperCase()}`) {
  const order = await requestMatch(patron, bill.id)
  mockOrders.approve(order.orderId, payer(payerId))
  return confirmHold(patron, bill.id)
}
