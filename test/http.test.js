import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createCallbackHandler, renderCallbackMessage } from '../src/http.js'
import { TokenStore } from '../src/store.js'

const PREFIX = '/api/tmp-hooks'

/** Minimal `IncomingMessage` stand-in: an event emitter with request fields. */
class FakeRequest extends EventEmitter {
  constructor({ method = 'POST', url, body = '', chunkSize, contentType } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = contentType === undefined ? {} : { 'content-type': contentType }
    this.#body = body
    this.#chunkSize = chunkSize
  }

  #body
  #chunkSize

  /** Emit the body asynchronously, like a real socket would. */
  pump() {
    setImmediate(() => {
      if (this.destroyed) return
      const size = this.#chunkSize ?? Math.max(this.#body.length, 1)
      for (let offset = 0; offset < this.#body.length; offset += size) {
        this.emit('data', Buffer.from(this.#body.slice(offset, offset + size)))
      }
      this.emit('end')
    })
  }

  pause() {
    this.paused = true
  }

  destroy() {
    this.destroyed = true
    this.emit('close')
  }
}

/** Minimal `ServerResponse` stand-in capturing status, headers, and body. */
class FakeResponse {
  statusCode = undefined
  headers = undefined
  body = undefined
  headersSent = false

  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
    return this
  }

  end(body) {
    this.body = body
    this.headersSent = true
  }

  json() {
    return JSON.parse(this.body)
  }
}

/**
 * Drive one request through the handler.
 * @returns the response plus every injected `(sessionId, text)` pair.
 */
async function call(handler, { method = 'POST', token, body = '{"ok":true}', chunkSize, contentType } = {}) {
  const req = new FakeRequest({ method, url: `${PREFIX}/${token}`, body, chunkSize, contentType })
  const res = new FakeResponse()
  req.pump()
  await handler(req, res)
  return res
}

/** Build a handler over a store with one issued token and a recording injector. */
function setup({ ttlSeconds = 60, inject } = {}) {
  let now = 1_000_000
  const clock = {
    now: () => now,
    advance: (ms) => { now += ms },
  }
  const store = new TokenStore({ now: clock.now })
  const record = store.issue({ sessionId: 'session-1', purpose: 'spec published', ttlSeconds })
  const injected = []
  const handler = createCallbackHandler({
    prefix: PREFIX,
    store,
    maxBodyBytes: 1024,
    now: clock.now,
    inject: inject ?? (async (sessionId, text) => { injected.push({ sessionId, text }) }),
  })
  return { store, record, injected, handler, clock }
}

test('a valid callback is delivered once and answered 200', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { token: record.token, body: '{"status":"done","url":"https://taco/x"}' })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { received: true })
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(injected.length, 1)
  assert.equal(injected[0].sessionId, 'session-1')
  assert.match(injected[0].text, /One-time callback received at 1970-01-01T00:16:40\.000Z/)
  assert.match(injected[0].text, /Purpose: spec published/)
  assert.match(injected[0].text, /"status": "done"/)
})

test('a replayed callback is refused with 410', async () => {
  const { handler, record, injected } = setup()

  assert.equal((await call(handler, { token: record.token })).statusCode, 200)
  const replay = await call(handler, { token: record.token })

  assert.equal(replay.statusCode, 410)
  assert.deepEqual(replay.json(), { received: false, error: 'token already used' })
  assert.equal(injected.length, 1)
})

test('an unknown token is refused with 404', async () => {
  const { handler } = setup()

  const res = await call(handler, { token: '00000000-0000-4000-8000-000000000000' })

  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { received: false, error: 'unknown token' })
})

test('an expired token is refused with 410', async () => {
  const { handler, record, injected, clock } = setup({ ttlSeconds: 60 })

  clock.advance(60_001)
  const res = await call(handler, { token: record.token })

  assert.equal(res.statusCode, 410)
  assert.deepEqual(res.json(), { received: false, error: 'token expired' })
  assert.equal(injected.length, 0)
})

test('a non-POST method is refused with 405 and the token survives', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { method: 'GET', token: record.token })

  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
  assert.equal(injected.length, 0)
  assert.equal((await call(handler, { token: record.token })).statusCode, 200)
})

test('a non-JSON body is delivered verbatim', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { token: record.token, body: 'build 42 finished\nall green', contentType: 'text/plain; charset=utf-8' })

  assert.equal(res.statusCode, 200)
  assert.equal(injected.length, 1)
  assert.match(injected[0].text, /Content-Type: text\/plain; charset=utf-8/)
  assert.match(injected[0].text, /build 42 finished\nall green/)
})

test('a JSON scalar is delivered without JSON quoting', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { token: record.token, body: '"done"', contentType: 'application/json' })

  assert.equal(res.statusCode, 200)
  assert.match(injected[0].text, /Payload:\n"?"?done/)
  assert.doesNotMatch(injected[0].text, /\\"done\\"/)
})

test('a malformed JSON body falls back to text instead of being rejected', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { token: record.token, body: '{"status": "done"', contentType: 'application/json' })

  assert.equal(res.statusCode, 200)
  assert.match(injected[0].text, /\{"status": "done"/)
})

test('a text payload is bounded in the same way as a JSON one', () => {
  const text = renderCallbackMessage({
    record: { token: 'abc', purpose: undefined },
    payload: { mediaType: 'text/plain', kind: 'text', text: 'y'.repeat(200_000) },
    receivedAt: 0,
  })

  assert.ok(text.length < 70_000)
  assert.match(text, /truncated by dsh-tmp-hook/)
})

test('an oversized body is refused with 413 and the token survives', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { token: record.token, body: `"${'x'.repeat(4096)}"` })

  assert.equal(res.statusCode, 413)
  assert.equal(res.headers.connection, 'close')
  assert.deepEqual(res.json(), { received: false, error: 'payload too large' })
  assert.equal(injected.length, 0)
  assert.equal((await call(handler, { token: record.token })).statusCode, 200)
})

test('a delivery failure is answered 502 and leaves the token usable', async () => {
  let fail = true
  const injected = []
  const { handler, record } = setup({
    inject: async (sessionId, text) => {
      if (fail) throw new Error('session not found')
      injected.push({ sessionId, text })
    },
  })

  const res = await call(handler, { token: record.token })

  assert.equal(res.statusCode, 502)
  assert.deepEqual(res.json(), { received: false, error: 'delivery failed' })
  assert.equal(injected.length, 0)

  fail = false
  assert.equal((await call(handler, { token: record.token })).statusCode, 200)
  assert.equal(injected.length, 1)
})

test('concurrent callbacks of one token deliver at most once', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const injected = []
  const { handler, record } = setup({
    inject: async (sessionId, text) => {
      await gate
      injected.push({ sessionId, text })
    },
  })

  const first = call(handler, { token: record.token, body: '{"n":1}' })
  await new Promise((resolve) => setImmediate(resolve))
  const second = await call(handler, { token: record.token, body: '{"n":2}' })
  release()
  const firstResponse = await first

  assert.equal(firstResponse.statusCode, 200)
  assert.equal(second.statusCode, 410)
  assert.equal(injected.length, 1)
})

test('an empty body is delivered as an empty payload', async () => {
  const { handler, record, injected } = setup()

  const res = await call(handler, { token: record.token, body: '' })

  assert.equal(res.statusCode, 200)
  assert.match(injected[0].text, /\(empty\)/)
})

test('a path with extra segments is not a callback', async () => {
  const { handler, record } = setup()

  const res = await call(handler, { token: `${record.token}/extra` })

  assert.equal(res.statusCode, 404)
})

test('renderCallbackMessage bounds a huge payload', () => {
  const text = renderCallbackMessage({
    record: { token: 'abc', purpose: undefined },
    payload: { mediaType: undefined, kind: 'json', value: { blob: 'x'.repeat(200_000) } },
    receivedAt: 0,
  })

  assert.ok(text.length < 70_000)
  assert.match(text, /truncated by dsh-tmp-hook/)
  assert.doesNotMatch(text, /Purpose:/)
})
