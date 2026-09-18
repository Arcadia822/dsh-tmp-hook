import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'
import { TokenStore } from '../src/store.js'
import { createRequestTmpHookTool, TOOL_NAME } from '../src/tool.js'

/** Build the tool over a fresh store. */
function setup(rawConfig = {}) {
  const config = resolveConfig({ baseUrl: 'https://dsh.example.com', ...rawConfig })
  const store = new TokenStore()
  const tool = createRequestTmpHookTool({ config, store, baseUrl: config.baseUrl })
  return { config, store, tool }
}

const EXEC = { agent: { session: { id: 'session-7' } } }

test('the tool exposes a model-facing schema and a canonical output contract', () => {
  const { tool } = setup()

  assert.equal(tool.name, TOOL_NAME)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['purpose', 'ttl_seconds'])
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.deepEqual(
    [...tool.output.schema.required].sort(),
    ['expires_at', 'expires_in_seconds', 'session_id', 'token', 'url'],
  )
})

test('a request mints a callback URL bound to the calling session', async () => {
  const { tool, store } = setup()

  const value = await tool.execute({ purpose: '  spec published  ' }, EXEC)

  assert.equal(value.url, `https://dsh.example.com/api/tmp-hooks/${value.token}`)
  assert.equal(value.session_id, 'session-7')
  assert.equal(value.expires_in_seconds, 1800)
  assert.equal(new Date(value.expires_at).getTime() - Date.now() > 1_799_000, true)
  assert.equal(store.claim(value.token).record.purpose, 'spec published')
})

test('a requested TTL is clamped into the configured window', async () => {
  const { tool, store } = setup({ ttlSeconds: 1800, minTtlSeconds: 30, maxTtlSeconds: 3600 })

  assert.equal((await tool.execute({ ttl_seconds: 5 }, EXEC)).expires_in_seconds, 30)
  assert.equal((await tool.execute({ ttl_seconds: 100_000 }, EXEC)).expires_in_seconds, 3600)

  const clamped = await tool.execute({ ttl_seconds: 100_000 }, EXEC)
  const claimed = store.claim(clamped.token)
  assert.equal(claimed.record.expiresAt - claimed.record.createdAt, 3_600_000)
})

test('the rendered result carries the URL the external worker needs', async () => {
  const { tool } = setup()

  const value = await tool.execute({ purpose: 'done' }, EXEC)
  const blocks = tool.output.render({}, value)

  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, new RegExp(value.url.replace(/[.]/g, '\\.')))
})

test('malformed arguments are rejected', async () => {
  const { tool } = setup()

  await assert.rejects(() => tool.execute({ ttl_seconds: 60.5 }, EXEC), /`ttl_seconds` must be a positive integer/)
  await assert.rejects(() => tool.execute({ ttl_seconds: 0 }, EXEC), /`ttl_seconds` must be a positive integer/)
  await assert.rejects(() => tool.execute({ purpose: 7 }, EXEC), /`purpose` must be a string/)
  await assert.rejects(() => tool.execute({ nope: true }, EXEC), /unknown argument `nope`/)
  await assert.rejects(() => tool.execute([], EXEC), /arguments must be an object/)
})

test('an execution without a session is refused', async () => {
  const { tool } = setup()

  await assert.rejects(() => tool.execute({}, {}), /requires a session-backed agent/)
})

test('an unconfigured base URL is refused loudly', async () => {
  const config = resolveConfig({})
  const tool = createRequestTmpHookTool({ config, store: new TokenStore(), baseUrl: config.baseUrl })

  await assert.rejects(() => tool.execute({}, EXEC), /set `baseUrl`/)
})

test('presenters never throw on replayed args', () => {
  const { tool } = setup()

  assert.deepEqual(tool.presentCall(undefined), {
    card: 'generic',
    title: 'Request one-time webhook',
    kind: 'other',
  })
  assert.equal(tool.presentCall({ purpose: 'x' }).title, 'Request one-time webhook: x')
  assert.equal(tool.presentResult({}, { isError: true }).title, 'One-time webhook request failed')
  assert.equal(tool.presentResult({}, { isError: false }).title, 'One-time webhook ready')
})
