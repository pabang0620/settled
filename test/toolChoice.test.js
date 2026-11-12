import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { callForJson, setClientForTests } from '../server/agent/claude.js'

const TOOL = { name: 'report', description: 'r', input_schema: { type: 'object', properties: {} } }
const fake = (replies, seen) => ({
  messages: {
    create: async (req) => {
      seen.push(req)
      if (req.tool_choice && ['tool', 'any'].includes(req.tool_choice.type)) throw new Error('400 tool_choice not supported')
      return replies.shift()
    },
  },
})
const toolReply = { content: [{ type: 'tool_use', id: 't', name: 'report', input: { ok: 1 } }] }
const textReply = { content: [{ type: 'text', text: 'hello' }] }

beforeEach(() => setClientForTests(null))

test('callForJson never sends forced tool_choice and names the tool in the system prompt', async () => {
  const seen = []
  setClientForTests(fake([toolReply], seen))
  const out = await callForJson({ system: 'S', user: 'U', tool: TOOL })
  assert.deepEqual(out, { ok: 1 })
  assert.equal(seen[0].tool_choice.type, 'auto')
  assert.match(seen[0].system, /calling the tool report/)
})

test('callForJson retries once when the model answers in text', async () => {
  const seen = []
  setClientForTests(fake([textReply, toolReply], seen))
  assert.deepEqual(await callForJson({ system: 'S', user: 'U', tool: TOOL }), { ok: 1 })
  assert.equal(seen.length, 2)
})

test('callForJson throws after two text answers so the caller falls back', async () => {
  const seen = []
  setClientForTests(fake([textReply, textReply], seen))
  await assert.rejects(callForJson({ system: 'S', user: 'U', tool: TOOL }), /no structured result/)
  assert.equal(seen.length, 2)
})
