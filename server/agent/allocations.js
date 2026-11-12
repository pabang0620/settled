import { llmLabel, modes } from '../config.js'
import { buildAllocations, validateOption } from '../allocation.js'
import { evaluate, openCandidates, cardView } from '../matching.js'
import { remainingCents, rulesOf } from '../patron.js'
import { urgencyOf } from '../bills.js'
import { loadLedger } from '../ledger.js'
import { getBill } from '../store.js'
import { HttpError } from '../http.js'
import { now } from '../clock.js'
import { toCents, usd } from '../money.js'
import { z } from 'zod'
import { runToolLoop } from './claude.js'
import { recordingLabel, replayable, transcriptOf } from './recordedRuns.js'

// "Use my last $300 this month": the user's own words can lower the budget. They can never raise it above the saved rule.
export function budgetFromText(text, patron) {
  const dollars = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(text || '')
  const requested = dollars ? toCents(dollars[1].replace(/,/g, '')) : Infinity
  return Math.min(requested, remainingCents(patron))
}

const summarize = (c) => ({ billId: c.bill.id, invoiceNumber: c.bill.invoiceNumber, matchCents: c.check.matchCents, urgency: urgencyOf(c.bill, c.ledger, now()) })

function optionLine(o) {
  const list = o.bills.map((b) => `${b.invoiceNumber} ${usd(b.matchCents)}`).join(' + ')
  return `${o.count} bills, ${usd(o.totalCents)}: ${list}`
}

function mockNarrative(plan) {
  if (!plan.options.length) return 'No open bill fits your rules and budget right now.'
  const head = `${plan.considered} bills fit your rules. Urgency is measured from each biller's shutoff date, else days past due.`
  if (!plan.tradeoff) return `${head} One option is best on every measure: ${optionLine(plan.options[0])}.`
  const [a, b] = plan.options
  const tail = a.leavesUrgent.length ? '' : ' Plan A covers every shutoff within 5 days.'
  return `${head} Plan A covers ${a.urgentCovered} bills with a shutoff within 5 days and closes ${a.count} bills in all. Plan B closes ${b.count} bills but leaves ${b.leavesUrgent.join(', ') || 'no shutoff'} open.${tail}`
}

export const LIVE_TOOLS = [
  { name: 'list_open_bills', description: 'List bills the patron could match now, checked against the saved rules by the server. Returns skipped bills whose ledger failed.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_bill_detail', description: 'Read the server record of one bill by invoice number: match amount, holder share paid, ledger status, shutoff date set by the biller, or why it was skipped.', input_schema: { type: 'object', properties: { invoiceNumber: { type: 'string' } }, required: ['invoiceNumber'] } },
  { name: 'draft_allocations', description: 'Ask the server for the allocation options for this budget. The server computes and validates them; you describe them.', input_schema: { type: 'object', properties: {} } },
]

export const PLAN_SYSTEM = 'You help a patron spend a monthly budget on strangers\' utility bills. First call list_open_bills. Then call get_bill_detail for each bill you will single out in your answer (a skipped bill, or a bill whose shutoff is within 5 days), so you describe it from the server record. Then call draft_allocations and describe the options in at most 4 short sentences. Reply in English. Say a shutoff as \"in N days\" from urgency.days, never as a calendar date. Use only numbers the tools returned; amounts are integer cents, write 25600 as $256.00. You can not add, remove or change an option, and you can not move money.'

const detailInput = z.object({ invoiceNumber: z.string().max(40) })

// The server functions the model may call during planning. None of them moves money or changes an option.
export function planTools({ candidates, skipped, summary, plan }) {
  return async (name, input) => {
    if (name === 'list_open_bills') return { ok: true, result: { eligible: summary, skipped } }
    if (name === 'draft_allocations') return { ok: true, result: { options: plan.options, tradeoff: plan.tradeoff } }
    if (name !== 'get_bill_detail') return { ok: false, result: { error: 'unknown tool' } }
    const parsed = detailInput.safeParse(input)
    if (!parsed.success) return { ok: false, result: { error: 'invoiceNumber is required' } }
    const wanted = parsed.data.invoiceNumber.trim().toUpperCase()
    const hit = candidates.find((c) => c.bill.invoiceNumber.toUpperCase() === wanted)
    if (hit) return { ok: true, result: { invoiceNumber: hit.bill.invoiceNumber, matchCents: hit.check.matchCents, holderShare: hit.bill.share, ledgerStatus: hit.ledger.status, urgency: urgencyOf(hit.bill, hit.ledger, now()), shutoffSetBy: 'biller' } }
    const miss = skipped.find((k) => k.invoiceNumber.toUpperCase() === wanted)
    if (miss) return { ok: true, result: { invoiceNumber: miss.invoiceNumber, skipped: true, reason: miss.reason } }
    return { ok: false, result: { error: 'No such bill in this patron\'s list.' } }
  }
}

// The key a recorded plan must match before it may be replayed: same request, same options, same skipped bills.
export const planKey = (userText, options, skipped) => JSON.stringify({ userText, options: options.map((o) => [o.id, o.count, o.totalCents, o.bills.map((b) => b.invoiceNumber)]), skipped: skipped.map((k) => k.invoiceNumber) })


/**
 * Plan how to spend a budget. The options come from code (allocation.js); the model, when live, only reads and describes them.
 */
export async function planAllocations(patron, userText) {
  const rules = rulesOf(patron)
  const budgetCents = budgetFromText(userText, patron)
  const events = []
  const { candidates, skipped } = await openCandidates(patron)
  events.push({ tool: 'list_open_bills', source: 'server', detail: `${candidates.length} eligible` })
  events.push({ tool: 'check_rules', source: 'server', detail: `cap ${usd(rules.perBillCapCents)}, floor ${rules.minHolderShare}, budget ${usd(budgetCents)}` })
  if (skipped.length) events.push({ tool: 'refresh_ledger', source: 'server', ok: false, detail: `${skipped.length} skipped: ${skipped[0].reason}` })
  const summary = candidates.map(summarize)
  const plan = buildAllocations(summary, { budgetCents, capCents: rules.perBillCapCents })
  plan.options = plan.options.filter((o) => validateOption(o, { budgetCents, capCents: rules.perBillCapCents }))
  events.push({ tool: 'draft_allocations', source: 'server', detail: `${plan.options.length} option(s)` })
  let narrative
  let source = 'stand-in agent'
  const key = planKey(userText, plan.options, skipped)
  const recording = replayable('plan', (run) => run.input.planKey === key)
  if (recording) {
    source = recordingLabel(recording)
    narrative = recording.result.narrative
    events.push(...recording.steps.filter((st) => st.type === 'tool_call').map((st) => ({ tool: st.name, ok: st.ok !== false, source: 'recorded model', detail: st.input?.invoiceNumber || '' })))
  } else if (modes.llm === 'live' && plan.options.length) {
    source = llmLabel()
    const loop = await runToolLoop({
      system: PLAN_SYSTEM,
      user: userText || 'Use my budget, most urgent first.',
      tools: LIVE_TOOLS,
      runTool: planTools({ candidates, skipped, summary, plan }),
    })
    narrative = loop.text
    events.push(...loop.events)
  } else {
    narrative = mockNarrative(plan)
  }
  patron.patron = { ...patron.patron, lastPlan: { budgetCents, capCents: rules.perBillCapCents, options: plan.options } }
  return { options: plan.options, tradeoff: !!plan.tradeoff, skipped, narrative, budgetCents, capCents: rules.perBillCapCents, enumerated: plan.enumerated, truncated: !!plan.truncated, source, events, recording: recording ? transcriptOf(recording, 'Recorded on the same prepared bills, budget and request.') : null }
}

// The patron chose an option. Re-check every bill against the live ledger, then return the cards in shutoff order.
export async function proposeBatch(patron, optionId) {
  const plan = patron.patron.lastPlan
  const option = plan?.options.find((o) => o.id === optionId)
  if (!option) throw new HttpError(404, 'Run the plan again; that option is not available.', 'option_missing')
  if (!validateOption(option, plan)) throw new HttpError(409, 'That option no longer fits the budget.', 'option_invalid')
  const cards = []
  const dropped = []
  for (const item of option.bills) {
    const bill = getBill(item.billId)
    try {
      const ledger = await loadLedger(bill)
      const check = evaluate(bill, ledger, patron)
      if (check.eligible && check.matchCents === item.matchCents) cards.push(cardView(bill, ledger, check))
      else dropped.push({ invoiceNumber: bill.invoiceNumber, reason: check.reasons[0] || 'amount changed' })
    } catch {
      dropped.push({ invoiceNumber: bill.invoiceNumber, reason: 'ledger error' })
    }
  }
  return { optionId, cards, dropped }
}

