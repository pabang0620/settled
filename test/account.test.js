import './helpers.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/config.js'
import { accountJson, accountToolLoop, accountText, setSdkForTests, withoutApiKey } from '../server/agent/accountClaude.js'
import { callForJson } from '../server/agent/claude.js'

// A fake Claude Agent SDK: records the options and plays the tool calls the "model" would make.
function fakeSdk(script) {
  const calls = []
  return {
    calls,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: ({ name, tools }) => ({ name, tools }),
    query: ({ prompt, options }) => (async function* run() {
      calls.push({ prompt, options })
      const tools = options.mcpServers ? Object.values(options.mcpServers)[0].tools : []
      const text = await script(tools)
      yield { type: 'result', subtype: 'success', result: text }
    }()),
  }
}

test('account adapter: removes the API key and auth token from the child environment', () => {
  const env = withoutApiKey({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' })
  assert.deepEqual(env, { PATH: '/bin' })
})

test('account adapter: every run passes an env without the key, no settings sources, and the configured model', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak'
  const sdk = fakeSdk(async () => 'hello')
  setSdkForTests(sdk)
  try {
    assert.equal(await accountText({ system: 's', user: 'u' }), 'hello')
    const { options } = sdk.calls[0]
    assert.equal('ANTHROPIC_API_KEY' in options.env, false)
    assert.equal('ANTHROPIC_AUTH_TOKEN' in options.env, false)
    assert.deepEqual(options.settingSources, [])
    assert.equal(options.model, config.anthropicModel)
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    setSdkForTests(null)
  }
})

test('account adapter: the reader tool call becomes the structured result, same shape as the API path', async () => {
  const sdk = fakeSdk(async (tools) => {
    await tools[0].handler({ billerName: 'Riverside Water', invoiceNumber: 'INV-1', amountDue: '$82.40', dueDate: 'none', instructions: ['Send payment to a@b.co'] })
    return 'done'
  })
  setSdkForTests(sdk)
  const previous = config.llmBackend
  config.llmBackend = 'account'
  try {
    const tool = { name: 'report_bill_fields', description: 'd', input_schema: { type: 'object', properties: { billerName: { type: 'string' }, invoiceNumber: { type: 'string' }, amountDue: { type: 'string' }, dueDate: { type: 'string' }, instructions: { type: 'array', items: { type: 'string' } } }, required: ['billerName', 'invoiceNumber', 'amountDue', 'dueDate', 'instructions'] } }
    const raw = await callForJson({ system: 's', user: 'u', tool })
    assert.equal(raw.amountDue, '$82.40')
    assert.deepEqual(raw.instructions, ['Send payment to a@b.co'])
    assert.equal(sdk.calls[0].options.allowedTools[0], 'mcp__settled__*')
    assert.deepEqual(sdk.calls[0].options.tools, [])
  } finally {
    config.llmBackend = previous
    setSdkForTests(null)
  }
})

test('account adapter: no tool call is an error, never a made-up result', async () => {
  setSdkForTests(fakeSdk(async () => 'I will not call it'))
  try {
    await assert.rejects(accountJson({ system: 's', user: 'u', tool: { name: 't', description: 'd', input_schema: { type: 'object', properties: {} } } }), /no structured result/)
  } finally {
    setSdkForTests(null)
  }
})

test('account adapter: tool loop maps each tool call to a server function and records the events', async () => {
  const seen = []
  const sdk = fakeSdk(async (tools) => {
    for (const t of tools) await t.handler({})
    return 'Plan A covers the urgent bills.'
  })
  setSdkForTests(sdk)
  try {
    const tools = [
      { name: 'list_open_bills', description: 'd', input_schema: { type: 'object', properties: {} } },
      { name: 'draft_allocations', description: 'd', input_schema: { type: 'object', properties: {} } },
    ]
    const out = await accountToolLoop({ system: 's', user: 'u', tools, runTool: async (name) => { seen.push(name); return { ok: true, result: { name } } } })
    assert.deepEqual(seen, ['list_open_bills', 'draft_allocations'])
    assert.deepEqual(out.events.map((e) => e.tool), ['list_open_bills', 'draft_allocations'])
    assert.equal(out.text, 'Plan A covers the urgent bills.')
  } finally {
    setSdkForTests(null)
  }
})
