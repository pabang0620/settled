import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { accountJson, accountText, accountToolLoop } from './accountClaude.js'

let client = null
const getClient = () => {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey })
  return client
}

export const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()

// One forced tool call that returns structured JSON (used for reading a document).
export async function callForJson({ system, user, tool }) {
  if (config.llmBackend === 'account') return accountJson({ system, user, tool })
  const response = await getClient().messages.create({
    model: config.anthropicModel,
    max_tokens: 2000,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  })
  const use = response.content.find((b) => b.type === 'tool_use')
  if (!use) throw new Error('The model returned no structured result.')
  return use.input
}

export async function callForText({ system, user }) {
  if (config.llmBackend === 'account') return accountText({ system, user })
  const response = await getClient().messages.create({ model: config.anthropicModel, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] })
  return textOf(response.content)
}

// A bounded tool loop. The tools are server functions; none of them moves money.
export async function runToolLoop({ system, user, tools, runTool, maxSteps = 6 }) {
  if (config.llmBackend === 'account') return accountToolLoop({ system, user, tools, runTool, maxSteps })
  const messages = [{ role: 'user', content: user }]
  const events = []
  for (let step = 0; step < maxSteps; step += 1) {
    const response = await getClient().messages.create({ model: config.anthropicModel, max_tokens: 4000, system, tools, messages })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') return { text: textOf(response.content), events }
    const results = []
    for (const use of response.content.filter((b) => b.type === 'tool_use')) {
      const outcome = await runTool(use.name, use.input)
      events.push({ tool: use.name, ok: outcome.ok, source: 'model' })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(outcome.result).slice(0, 12000), is_error: !outcome.ok })
    }
    messages.push({ role: 'user', content: results })
  }
  return { text: 'I stopped after several steps.', events }
}
