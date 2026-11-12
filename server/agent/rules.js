import { llmLabel, modes } from '../config.js'
import { DEFAULT_RULES, rulesSchema } from '../patron.js'
import { parse } from '../http.js'
import { toCents } from '../money.js'
import { callForJson } from './claude.js'
import { recordingLabel, replayable } from './recordedRuns.js'

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

// Which reader drafted the rules, for the label next to the draft.
export function draftSource(text) {
  const recording = replayable('rules', (run) => run.input.text === text)
  if (recording) return recordingLabel(recording)
  return modes.llm === 'live' ? llmLabel() : 'stand-in parser'
}

export async function draftPatronRules(text) {
  const recording = replayable('rules', (run) => run.input.text === text)
  if (recording || modes.llm === 'live') {
    const raw = recording ? recording.result.toolInput : await callForJson({ system: RULES_SYSTEM, user: text, tool: TOOL })
    return parse(rulesSchema, {
      ...DEFAULT_RULES,
      ...(raw.monthlyBudgetDollars ? { monthlyBudgetCents: Math.round(raw.monthlyBudgetDollars * 100) } : {}),
      ...(raw.perBillCapDollars ? { perBillCapCents: Math.round(raw.perBillCapDollars * 100) } : {}),
      ...(raw.minHolderShare ? { minHolderShare: raw.minHolderShare } : {}),
      ...(raw.region ? { region: raw.region.toUpperCase() } : {}),
    })
  }
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
