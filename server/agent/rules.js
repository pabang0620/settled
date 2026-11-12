import { llmLabel } from '../config.js'
import { DEFAULT_RULES, rulesSchema } from '../patron.js'
import { parse } from '../http.js'
import { toCents } from '../money.js'
import { callForJson } from './claude.js'
import { recordingLabel, recordedFor } from './recordedRuns.js'
import { beginRun, withReason } from './liveGuard.js'

const TOOL = {
  name: 'draft_rules',
  description: 'Turn the patron\'s sentence into giving rules. Fields you do not know must be left out.',
  input_schema: {
    type: 'object',
    properties: {
      monthlyBudgetDollars: { type: 'number' }, minHolderShare: { type: 'string', description: 'Fraction like 1/2' },
      perBillCapDollars: { type: 'number' }, region: { type: 'string', description: 'Two-letter US state' },
    },
  },
}

// Draft only. The patron reads the draft and saves it; the server validates it with the same zod schema.
export const RULES_SYSTEM = 'Draft giving rules from the sentence. Do not invent numbers that are not in it.'

const fromRaw = (raw) => parse(rulesSchema, {
  ...DEFAULT_RULES,
  ...(raw.monthlyBudgetDollars ? { monthlyBudgetCents: Math.round(raw.monthlyBudgetDollars * 100) } : {}),
  ...(raw.perBillCapDollars ? { perBillCapCents: Math.round(raw.perBillCapDollars * 100) } : {}),
  ...(raw.minHolderShare ? { minHolderShare: raw.minHolderShare } : {}),
  ...(raw.region ? { region: raw.region.toUpperCase() } : {}),
})

// Which reader drafts this sentence when the app is not live, for the label next to the draft.
export function draftSource(text) {
  const recording = recordedFor('rules', (r) => r.input.text === text)
  return recording ? recordingLabel(recording) : 'stand-in parser'
}

/**
 * Draft rules from a sentence. Live model first; when it is not live, capped, or errors: the recorded run for this exact
 * sentence, else the rule-based parser. Returns the draft with the label of whoever drafted it.
 */
export async function draftWithSource(text, ip) {
  const run = beginRun(ip)
  const live = await run.call(async () => fromRaw(await callForJson({ system: RULES_SYSTEM, user: text, tool: TOOL })))
  if (live.ok) return { rules: live.value, source: llmLabel() }
  const recording = recordedFor('rules', (r) => r.input.text === text)
  if (recording) return { rules: fromRaw(recording.result.toolInput), source: withReason(recordingLabel(recording), live.reason) }
  return { rules: standInRules(text), source: live.reason ? withReason('Rule-based stand-in', live.reason) : 'stand-in parser' }
}

export const draftPatronRules = async (text, ip) => (await draftWithSource(text, ip)).rules

function standInRules(text) {
  const budget = /\$\s?(\d[\d,]*)\s*(?:\/|per|a|each)?\s*month|\$\s?(\d[\d,]*)/i.exec(text)
  const cap = /(?:under|up to|at most|max(?:imum)?|no more than)\s*\$\s?(\d[\d,]*)\s*(?:per|a|each)?\s*bill/i.exec(text)
  const share = /pays? at least (\d+\/\d+)/i.exec(text)
  const region = /\b([A-Z]{2})\b/.exec(text)
  const dollars = (m) => toCents((m[1] || m[2]).replace(/,/g, ''))
  return parse(rulesSchema, {
    ...DEFAULT_RULES,
    ...(budget ? { monthlyBudgetCents: dollars(budget) } : {}),
    ...(cap ? { perBillCapCents: toCents(cap[1].replace(/,/g, '')) } : {}),
    ...(share ? { minHolderShare: share[1] } : {}),
    ...(region && !['US', 'OK'].includes(region[1]) ? { region: region[1] } : {}),
  })
}
