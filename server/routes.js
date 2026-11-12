import express from 'express'
import { z } from 'zod'
import { HttpError, parse, uuidSchema } from './http.js'
import { config, llmLabel, modes, DEMO_SHORTENED_WINDOW } from './config.js'
import { createSession, getBill, getSession, logActivity, allBills } from './store.js'
import { listBillers, getBiller } from './registry.js'
import { getDocument, documentView, seedPlanBills, seedSession, takeFromPool } from './seed.js'
import { analyzeDocument } from './agent/bills.js'
import { planAllocations, proposeBatch } from './agent/allocations.js'
import { draftWithSource } from './agent/rules.js'
import { cancelHolderOrder, completeHolderPayment, ownBill, startHolderPayment } from './holder.js'
import { cardView, confirmHold, evaluate, flagDispute, openCandidates, recheckBill, releaseMatch, requestMatch, settleDue, settleMatch } from './matching.js'
import { remainingCents, rulesOf, saveRules, spentCents } from './patron.js'
import { patronHoldView, holderBillView } from './views.js'
import { postMessage, setStory } from './messages.js'
import { screenText } from './screen.js'
import { mockOrders, mockReverseCapture } from './integrations/mockPaypal.js'
import { createHash } from 'node:crypto'
import { loadLedger } from './ledger.js'
import { handleWebhook, webhookStatus } from './webhooks.js'

export const api = express.Router()

const ok = (res, data) => res.json({ success: true, data })

// Express 5 forwards rejected promises to the central error handler, so handlers stay short.
function sessionOf(req) {
  const id = uuidSchema.safeParse(req.get('x-session-id'))
  const session = id.success ? getSession(id.data) : null
  if (!session) throw new HttpError(401, 'Start a session first.', 'no_session')
  return session
}

const shareSchema = z.string().regex(/^\d+\/\d+$/)
const idParam = (req) => parse(uuidSchema, req.params.id)

api.post('/session', (req, res) => {
  const session = createSession()
  res.status(201).json({ success: true, data: { sessionId: session.id } })
})

api.get('/state', async (req, res) => {
  const session = sessionOf(req)
  const mine = allBills().filter((b) => b.sessionId === session.id && !b.demo)
  const bills = []
  for (const bill of mine) bills.push(await holderBillView(session, bill))
  const holds = allBills().filter((b) => b.match.patronSessionId === session.id).map((b) => patronHoldView(session, b))
  ok(res, {
    modes: { paypal: modes.paypal, biller: modes.biller, llm: modes.llm, llmLabel: llmLabel(), matchMode: config.matchMode },
    holdWindowMinutes: config.holderSettleMinutes,
    settleJobSeconds: config.settleJobSeconds,
    demoShortenedWindow: DEMO_SHORTENED_WINDOW,
    billers: listBillers().map((b) => ({ id: b.id, name: b.name, entityType: b.entityType, paymentModes: b.paymentModes, holderShare: b.holderShare, allowedShares: b.allowedShares, region: b.region, category: b.category })),
    billerSession: session.billerId,
    bills,
    patron: { rules: rulesOf(session), saved: !!session.patron.rules, spentCents: spentCents(session), remainingCents: remainingCents(session), holds },
    activity: session.activity.slice(-40),
    webhooks: webhookStatus(),
  })
})

// ---- Sample bills, documents, route ----
api.post('/samples', async (req, res) => {
  const session = sessionOf(req)
  const { biller } = parse(z.object({ biller: z.enum(['riverside', 'cedar', 'unknown']) }), req.body)
  const result = await seedSession(session, biller)
  logActivity(session, { source: 'server', tool: 'seed_session', ok: true, detail: `sample ${biller}` })
  ok(res, { billId: result.bill?.id ?? null, documents: result.documents, reused: !!result.reused })
})

api.post('/documents/:id/analyze', async (req, res) => {
  const session = sessionOf(req)
  const result = await analyzeDocument(session, idParam(req), req.ip)
  logActivity(session, { source: 'model', tool: 'read_bill', ok: true, detail: `${result.sources.reader}; route ${result.decision.route} decided by server` })
  ok(res, result)
})

api.get('/documents/:id', (req, res) => {
  const session = sessionOf(req)
  const doc = getDocument(idParam(req))
  if (!doc || doc.sessionId !== session.id) throw new HttpError(404, 'Document not found.', 'document_not_found')
  ok(res, documentView(doc))
})

// ---- Holder: pay my part ----
api.post('/bills/:id/holder/start', async (req, res) => {
  const session = sessionOf(req)
  const { share } = parse(z.object({ share: shareSchema }), req.body)
  ok(res, await startHolderPayment(session, idParam(req), share))
})
api.post('/bills/:id/holder/complete', async (req, res) => ok(res, await completeHolderPayment(sessionOf(req), idParam(req))))
api.post('/bills/:id/holder/cancel', async (req, res) => ok(res, await cancelHolderOrder(sessionOf(req), idParam(req))))
api.put('/bills/:id/story', (req, res) => ok(res, setStory(sessionOf(req), idParam(req), parse(z.object({ text: z.string().max(400) }), req.body).text)))
api.post('/screen', (req, res) => ok(res, screenText(parse(z.object({ text: z.string().max(1000) }), req.body).text)))

// ---- Mock PayPal checkout (stand-in for PayPal's own approval page) ----
api.post('/mock-paypal/approve', (req, res) => {
  if (modes.paypal !== 'mock') throw new HttpError(404, 'Not available with real sandbox credentials.', 'mock_only')
  const session = sessionOf(req)
  const { orderId, persona } = parse(z.object({ orderId: z.string().min(5).max(40), persona: z.string().max(30).default('me') }), req.body)
  const hash = createHash('sha256').update(`${session.id}:${persona}`).digest('hex').slice(0, 10).toUpperCase()
  const order = mockOrders.approve(orderId, { payer_id: `SBX${hash}`, email_address: `buyer-${hash.toLowerCase()}@example.com`, name: { given_name: 'Sandbox', surname: 'Buyer' } })
  ok(res, { orderId: order.id, status: order.status })
})

api.post('/mock/reverse-holder/:id', async (req, res) => {
  if (modes.paypal !== 'mock') throw new HttpError(404, 'Not available with real sandbox credentials.', 'mock_only')
  const bill = ownBill(sessionOf(req), idParam(req))
  if (!bill.holder.captureId) throw new HttpError(409, 'Nothing to reverse.', 'nothing_to_reverse')
  mockReverseCapture(bill.holder.captureId)
  ok(res, await recheckBill(bill.id))
})

// ---- Patron ----
api.get('/patron/feed', async (req, res) => {
  const patron = sessionOf(req)
  const { candidates, skipped } = await openCandidates(patron)
  ok(res, { cards: candidates.map((c) => cardView(c.bill, c.ledger, c.check)), skipped, remainingCents: remainingCents(patron) })
})
api.put('/patron/rules', (req, res) => ok(res, saveRules(sessionOf(req), req.body)))
api.post('/patron/rules/draft', async (req, res) => {
  const { text } = parse(z.object({ text: z.string().min(3).max(400) }), req.body)
  const { rules, source } = await draftWithSource(text, req.ip)
  ok(res, { ...rules, source })
})
api.post('/patron/plan', async (req, res) => ok(res, await planAllocations(sessionOf(req), parse(z.object({ text: z.string().max(400).default('') }), req.body).text, req.ip)))
api.post('/patron/plan/:option/choose', async (req, res) => ok(res, await proposeBatch(sessionOf(req), parse(z.enum(['A', 'B']), req.params.option))))

api.post('/demo/prepare', async (req, res) => {
  const session = sessionOf(req)
  // Each patron session gets its own prepared set, built once.
  if (!session.patron.prepared) session.patron = { ...session.patron, prepared: (await seedPlanBills(session)).length }
  ok(res, { prepared: session.patron.prepared })
})
api.post('/demo/fast-path', async (req, res) => {
  const patron = sessionOf(req)
  const bill = await takeFromPool(patron)
  const ledger = await loadLedger(bill)
  ok(res, { card: cardView(bill, ledger, evaluate(bill, ledger, patron)) })
})

api.post('/matches/:id/request', async (req, res) => ok(res, await requestMatch(sessionOf(req), idParam(req))))
api.post('/matches/:id/confirm', async (req, res) => ok(res, await confirmHold(sessionOf(req), idParam(req))))
api.post('/matches/:id/release', async (req, res) => ok(res, await releaseMatch(sessionOf(req), idParam(req))))
api.post('/matches/:id/settle', async (req, res) => {
  const session = sessionOf(req)
  const bill = getBill(idParam(req))
  if (!bill || (bill.match.patronSessionId !== session.id && bill.sessionId !== session.id)) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  ok(res, await settleMatch(bill.id))
})
api.post('/messages/:id', (req, res) => ok(res, postMessage(sessionOf(req), idParam(req), parse(z.object({ text: z.string().max(400).default('') }), req.body).text)))

// ---- Operator and biller ----
api.post('/ops/settle', async (req, res) => {
  if (!config.opsKey || req.get('x-ops-key') !== config.opsKey) throw new HttpError(403, 'Operator key required.', 'ops_forbidden')
  ok(res, await settleDue())
})
// PayPal webhook (VERIFY V9): verified refund, reversal and dispute events re-read the holder's bill at once.
api.post('/webhooks/paypal', handleWebhook)

api.post('/ops/dispute/:id', async (req, res) => {
  if (!config.opsKey || req.get('x-ops-key') !== config.opsKey) throw new HttpError(403, 'Operator key required.', 'ops_forbidden')
  ok(res, await flagDispute(idParam(req)))
})

api.post('/biller/login', (req, res) => {
  const session = sessionOf(req)
  const { billerId, passcode } = parse(z.object({ billerId: z.string().max(30), passcode: z.string().max(60) }), req.body)
  if (!getBiller(billerId) || passcode !== config.billerPasscode) throw new HttpError(403, 'Wrong biller or passcode.', 'biller_login')
  session.billerId = billerId
  ok(res, { billerId })
})

api.get('/biller/invoices', async (req, res) => {
  const session = sessionOf(req)
  if (!session.billerId) throw new HttpError(403, 'Log in as a biller first.', 'biller_only')
  const list = []
  for (const bill of allBills().filter((b) => b.billerId === session.billerId && b.sessionId === session.id && !b.demo)) {
    const ledger = await loadLedger(bill)
    list.push({ billId: bill.id, invoiceNumber: ledger.number, accountMask: `••${String(bill.accountRef).slice(-4)}`, totalCents: ledger.totalCents, dueCents: ledger.dueCents, status: ledger.status, dueDate: ledger.dueDate, sponsorable: bill.sponsorable, disconnectDate: bill.disconnectDate })
  }
  ok(res, { billerId: session.billerId, invoices: list, appAccess: ['get_invoice', 'record_payment_for_invoice', 'create_refund', 'create_invoice and send_invoice for sample bills only'] })
})

api.patch('/biller/invoices/:id', (req, res) => {
  const session = sessionOf(req)
  const bill = getBill(idParam(req))
  if (!session.billerId || !bill || bill.billerId !== session.billerId || bill.sessionId !== session.id) throw new HttpError(403, 'Not your invoice.', 'biller_only')
  const body = parse(z.object({ sponsorable: z.boolean().optional(), disconnectDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }), req.body)
  if (body.sponsorable !== undefined) bill.sponsorable = body.sponsorable
  if (body.disconnectDate !== undefined) bill.disconnectDate = body.disconnectDate
  ok(res, { billId: bill.id, sponsorable: bill.sponsorable, disconnectDate: bill.disconnectDate })
})

