import { z } from 'zod'
import { config } from '../config.js'
import { traceStep } from './trace.js'

// Local development only: the same prompts and tools as claude.js, run through the Claude Agent SDK so the
// developer's Claude Code login is used. The Anthropic API key is removed from the child environment.
const SERVER_NAME = 'settled'
let sdk = null

export const loadSdk = async () => {
  if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk
}
// Tests inject a fake SDK; production never calls this.
export const setSdkForTests = (fake) => { sdk = fake }

export function withoutApiKey(env = process.env) {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = env
  return rest
}

const shapeOf = (schema) => z.fromJSONSchema(schema).shape

function baseOptions(system, tools, maxTurns) {
  return {
    model: config.anthropicModel,
    systemPrompt: system,
    tools: [],
    allowedTools: tools.length ? [`mcp__${SERVER_NAME}__*`] : [],
    maxTurns,
    effort: 'medium',
    settingSources: [],
    env: withoutApiKey(),
  }
}

async function drain(agentSdk, prompt, options) {
  let text = ''
  for await (const message of agentSdk.query({ prompt, options })) {
    if (message.type !== 'result') continue
    if (message.subtype === 'success') text = message.result
    else if (message.subtype === 'error_max_turns') text = ''
    else throw new Error(`Account model run failed: ${message.subtype}`)
  }
  return text.trim()
}

// One structured result, taken from the single tool call the model makes (the account path has no forced tool_choice).
export async function accountJson({ system, user, tool }) {
  const agentSdk = await loadSdk()
  let captured = null
  const reporter = agentSdk.tool(tool.name, tool.description, shapeOf(tool.input_schema), async (input) => {
    captured = input
    traceStep({ type: 'tool_call', name: tool.name, input })
    return { content: [{ type: 'text', text: 'Recorded.' }] }
  })
  const server = agentSdk.createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: [reporter] })
  const options = { ...baseOptions(`${system}\nCall the ${tool.name} tool exactly once, then stop.`, [tool], 3), mcpServers: { [SERVER_NAME]: server } }
  const text = await drain(agentSdk, user, options)
  if (text) traceStep({ type: 'text', text })
  if (!captured) throw new Error('The model returned no structured result.')
  return captured
}

export async function accountText({ system, user }) {
  const text = await drain(await loadSdk(), user, baseOptions(system, [], 1))
  traceStep({ type: 'text', text })
  return text
}

// Bounded tool loop. The tools are server functions; none of them moves money.
export async function accountToolLoop({ system, user, tools, runTool, maxSteps = 6 }) {
  const agentSdk = await loadSdk()
  const events = []
  const defs = tools.map((def) => agentSdk.tool(def.name, def.description, shapeOf(def.input_schema), async (input) => {
    const outcome = await runTool(def.name, input)
    events.push({ tool: def.name, ok: outcome.ok, source: 'model' })
    traceStep({ type: 'tool_call', name: def.name, input, ok: outcome.ok, result: JSON.stringify(outcome.result).slice(0, 600) })
    return { content: [{ type: 'text', text: JSON.stringify(outcome.result).slice(0, 12000) }], isError: !outcome.ok }
  }))
  const server = agentSdk.createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: defs })
  const options = { ...baseOptions(system, tools, maxSteps + 1), mcpServers: { [SERVER_NAME]: server } }
  const text = await drain(agentSdk, user, options)
  traceStep({ type: 'text', text })
  return { text: text || 'I stopped after several steps.', events }
}
