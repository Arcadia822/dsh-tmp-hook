import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBaseUrl, resolveConfig } from '../src/config.js'

test('defaults are applied when the entry has no config', () => {
  const config = resolveConfig(undefined)

  assert.equal(config.baseUrl, '')
  assert.equal(config.pathPrefix, '/api/tmp-hooks')
  assert.equal(config.ttlSeconds, 1800)
  assert.equal(config.allowUnauthenticated, true)
  assert.equal(resolveConfig({}).pathPrefix, '/api/tmp-hooks')
})

test('a base URL loses its trailing slash and a prefix gains a leading one', () => {
  const config = resolveConfig({ baseUrl: 'https://dsh.example.com///', pathPrefix: 'hooks/x/' })

  assert.equal(config.baseUrl, 'https://dsh.example.com')
  assert.equal(config.pathPrefix, '/hooks/x')
})

test('unknown keys are rejected instead of being silently ignored', () => {
  assert.throws(() => resolveConfig({ baseUrlX: 'x' }), /unknown config key `baseUrlX`/)
})

test('a non-positive or non-integer count is rejected', () => {
  assert.throws(() => resolveConfig({ ttlSeconds: 0 }), /`ttlSeconds` must be a positive integer/)
  assert.throws(() => resolveConfig({ maxBodyBytes: 1.5 }), /`maxBodyBytes` must be a positive integer/)
  assert.throws(() => resolveConfig({ sweepIntervalMs: -1 }), /`sweepIntervalMs` must be a non-negative integer/)
})

test('an inverted TTL window is rejected', () => {
  assert.throws(
    () => resolveConfig({ minTtlSeconds: 600, maxTtlSeconds: 60 }),
    /`maxTtlSeconds` \(60\) must be >= `minTtlSeconds` \(600\)/,
  )
})

test('a malformed path prefix is rejected', () => {
  assert.throws(() => resolveConfig({ pathPrefix: '   ' }), /`pathPrefix` must not be empty/)
  assert.throws(() => resolveConfig({ pathPrefix: '/x?y' }), /must be a plain path/)
  assert.throws(() => resolveConfig({ pathPrefix: '/' }), /must name a sub-path, not `\/`/)
})

test('a base URL must be an absolute http(s) origin', () => {
  assert.throws(() => resolveConfig({ baseUrl: 'dsh.example.com' }), /must be an absolute URL/)
  assert.throws(() => resolveConfig({ baseUrl: 'ftp://dsh.example.com' }), /must use http or https/)
  assert.equal(resolveConfig({ baseUrl: 'https://dsh.example.com/x' }).baseUrl, 'https://dsh.example.com/x')
})

test('baseUrlScheme is restricted to http and https', () => {
  assert.throws(() => resolveConfig({ baseUrlScheme: 'ftp' }), /`baseUrlScheme` must be "http" or "https"/)
  assert.equal(resolveConfig({}).baseUrlScheme, 'https')
})

test('the trust fence supplies an origin only when baseUrl is unset', () => {
  const trustedHosts = ['127.0.0.1:3080', 'localhost:3080', 'dsh.example.com', 'dsh.example.com:3080']

  assert.deepEqual(resolveBaseUrl({ baseUrl: '', scheme: 'https', trustedHosts }), {
    url: 'https://dsh.example.com',
    source: 'trusted-host dsh.example.com',
  })
  assert.deepEqual(resolveBaseUrl({ baseUrl: 'http://x.example', scheme: 'https', trustedHosts }), {
    url: 'http://x.example',
    source: 'config',
  })
})

test('an unusable trust fence yields no origin instead of a plausible wrong one', () => {
  for (const trustedHosts of [
    [],
    ['10.0.0.4'],
    ['10.0.0.4:3080'],
    ['[::1]:3080'],
    ['localhost'],
    ['box.local'],
    ['dsh.example.com:8443'],
  ]) {
    assert.deepEqual(resolveBaseUrl({ baseUrl: '', scheme: 'https', trustedHosts }), { url: '', source: '' })
  }
})
