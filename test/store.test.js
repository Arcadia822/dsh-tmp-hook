import assert from 'node:assert/strict'
import test from 'node:test'

import { CLAIM_CONSUMED, CLAIM_EXPIRED, CLAIM_UNKNOWN, TokenStore } from '../src/store.js'

/** A store wired to a hand-cranked clock. */
function makeStore(start = 1_000_000) {
  let now = start
  const store = new TokenStore({ now: () => now })
  return { store, advance: (ms) => { now += ms }, set: (value) => { now = value } }
}

test('a token can be claimed exactly once', () => {
  const { store } = makeStore()
  const record = store.issue({ sessionId: 's1', ttlSeconds: 60 })

  assert.equal(record.token.length, 36)
  const first = store.claim(record.token)
  assert.equal(first.ok, true)
  assert.equal(first.record.sessionId, 's1')

  assert.deepEqual(store.claim(record.token), { ok: false, reason: CLAIM_CONSUMED })
})

test('an expired token is refused and dropped', () => {
  const { store, advance } = makeStore()
  const record = store.issue({ sessionId: 's1', ttlSeconds: 60 })

  advance(60_000)
  assert.deepEqual(store.claim(record.token), { ok: false, reason: CLAIM_EXPIRED })
  assert.equal(store.size, 0)
  assert.deepEqual(store.claim(record.token), { ok: false, reason: CLAIM_UNKNOWN })
})

test('a token stays usable until its TTL elapses', () => {
  const { store, advance } = makeStore()
  const record = store.issue({ sessionId: 's1', ttlSeconds: 60 })

  advance(59_999)
  assert.equal(store.claim(record.token).ok, true)
})

test('releasing a claim restores the token so a failed delivery can be retried', () => {
  const { store } = makeStore()
  const record = store.issue({ sessionId: 's1', ttlSeconds: 60 })

  const claimed = store.claim(record.token)
  assert.equal(claimed.ok, true)
  assert.deepEqual(store.claim(record.token), { ok: false, reason: CLAIM_CONSUMED })

  store.release(claimed.record)
  assert.equal(store.claim(record.token).ok, true)
})

test('sweep drops expired records and keeps live ones', () => {
  const { store, advance } = makeStore()
  const short = store.issue({ sessionId: 's1', ttlSeconds: 30 })
  const long = store.issue({ sessionId: 's2', ttlSeconds: 600 })

  advance(31_000)
  assert.equal(store.sweep(), 1)
  assert.equal(store.size, 1)
  assert.deepEqual(store.claim(short.token), { ok: false, reason: CLAIM_UNKNOWN })
  assert.equal(store.claim(long.token).ok, true)
})

test('a claimed record survives sweep until its TTL so replays stay distinguishable', () => {
  const { store, advance } = makeStore()
  const record = store.issue({ sessionId: 's1', ttlSeconds: 60 })

  assert.equal(store.claim(record.token).ok, true)
  advance(59_000)
  assert.equal(store.sweep(), 0)
  assert.deepEqual(store.claim(record.token), { ok: false, reason: CLAIM_CONSUMED })

  advance(2_000)
  assert.equal(store.sweep(), 1)
  assert.deepEqual(store.claim(record.token), { ok: false, reason: CLAIM_UNKNOWN })
})

test('tokens are unguessable and distinct', () => {
  const { store } = makeStore()
  const tokens = new Set()
  for (let index = 0; index < 200; index += 1) {
    const record = store.issue({ sessionId: 's1', ttlSeconds: 60 })
    assert.match(record.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    tokens.add(record.token)
  }
  assert.equal(tokens.size, 200)
})
