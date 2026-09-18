/**
 * Documented defaults for every configuration key, in one place.
 *
 * The plugin exports no schemastery `Config`, so this table is the schema:
 * `resolveConfig` rejects unknown keys and any value that is not in the shape
 * documented here, at load time rather than at request time.
 */
const DEFAULTS = {
  /** Public origin prepended to every callback URL, e.g. `https://dsh.example.com`. Empty = derive it from the deployment's `--trusted-host` domains, and fail loudly if that is not possible either. */
  baseUrl: '',
  /** Scheme assumed for an origin derived from a `--trusted-host` domain; ignored when `baseUrl` is set. */
  baseUrlScheme: 'https',
  /** Absolute path prefix the callback route is registered under. */
  pathPrefix: '/api/tmp-hooks',
  /** Default token lifetime in seconds. */
  ttlSeconds: 1800,
  /** Lower clamp for a per-call `ttl_seconds`. */
  minTtlSeconds: 30,
  /** Upper clamp for a per-call `ttl_seconds`. */
  maxTtlSeconds: 86400,
  /** Maximum accepted callback body size in bytes. */
  maxBodyBytes: 262144,
  /** Period between expired-token sweeps in milliseconds; `0` disables the sweeper (records are then only dropped on access). */
  sweepIntervalMs: 60000,
  /** Budget for admitting a delivered message into its session, in milliseconds. */
  deliverTimeoutMs: 15000,
  /** Compose with `dsh-auth-gate` so the callback prefix is reachable without a dsh login session. */
  allowUnauthenticated: true,
}

/** Reject a configuration value that is not a safe integer within its documented bound. */
function readCount(config, key, { positive = false } = {}) {
  const value = config[key]
  if (value === undefined) return DEFAULTS[key]
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`dsh-tmp-hook: \`${key}\` must be ${positive ? 'a positive' : 'a non-negative'} integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Normalize a configured path prefix to `/<segments>` with no trailing slash. */
function normalizePathPrefix(raw) {
  let prefix = String(raw ?? '').trim()
  if (prefix === '') throw new Error('dsh-tmp-hook: `pathPrefix` must not be empty')
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  while (prefix.length > 1 && prefix.endsWith('/')) prefix = prefix.slice(0, -1)
  // A bare `/` would claim every unmatched request, and (with the auth-gate
  // composition on) would exempt the whole console from authentication.
  if (prefix === '/') throw new Error('dsh-tmp-hook: `pathPrefix` must name a sub-path, not `/`')
  if (prefix.includes('?') || prefix.includes('#')) {
    throw new Error(`dsh-tmp-hook: \`pathPrefix\` must be a plain path, got ${JSON.stringify(raw)}`)
  }
  return prefix
}

/** Normalize the configured public origin, or return `''` when it is unset. */
function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (value === '') return ''
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`dsh-tmp-hook: \`baseUrl\` must be an absolute URL, got ${JSON.stringify(raw)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-tmp-hook: \`baseUrl\` must use http or https, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Whether one trust-fence authority is a usable public DNS name. */
function isPublicDnsAuthority(authority) {
  // A bare hostname only: IPv6 literals are bracketed, anything else carrying
  // a colon is host:port, and both are unusable as a public origin here (the
  // proxy terminates the port).
  if (authority === '' || authority.includes(':') || authority.includes('[')) return false
  if (authority === 'localhost' || authority.endsWith('.local')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(authority)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(authority)
}

/**
 * Resolve the public origin used to build callback URLs.
 *
 * `baseUrl` is authoritative. When it is unset, fall back to the deployment's
 * own trust fence: a console served behind a reverse proxy must already
 * declare its public authority with `--trusted-host <domain>` or the browser
 * would be rejected, so that domain is the origin — no second copy of the same
 * fact in this plugin's config. Only a port-less DNS name qualifies; an IP
 * literal or an explicit `host:port` cannot be turned into a public origin
 * without guessing, and a wrong guess would hand a worker an unreachable URL.
 * @param options - the configured base URL, the scheme for derived origins, and declared authorities.
 * @returns the origin and where it came from; `url` is `''` when nothing usable was declared.
 */
export function resolveBaseUrl({ baseUrl, scheme, trustedHosts = [] }) {
  if (baseUrl !== '') return { url: baseUrl, source: 'config' }
  for (const candidate of trustedHosts) {
    const authority = String(candidate ?? '').trim()
    if (!isPublicDnsAuthority(authority)) continue
    const url = `${scheme}://${authority}`
    try {
      new URL(url)
    } catch {
      continue
    }
    return { url, source: `trusted-host ${authority}` }
  }
  return { url: '', source: '' }
}

/**
 * Validate and normalize the raw Cordis entry config.
 * @param raw - the loader entry's `config` mapping.
 * @returns the resolved configuration.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('dsh-tmp-hook: config must be a mapping')
  }
  for (const key of Object.keys(config)) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-tmp-hook: unknown config key \`${key}\``)
  }
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') {
    throw new Error('dsh-tmp-hook: `baseUrl` must be a string')
  }
  if (config.allowUnauthenticated !== undefined && typeof config.allowUnauthenticated !== 'boolean') {
    throw new Error('dsh-tmp-hook: `allowUnauthenticated` must be a boolean')
  }
  if (config.baseUrlScheme !== undefined && config.baseUrlScheme !== 'http' && config.baseUrlScheme !== 'https') {
    throw new Error(`dsh-tmp-hook: \`baseUrlScheme\` must be "http" or "https", got ${JSON.stringify(config.baseUrlScheme)}`)
  }

  const minTtlSeconds = readCount(config, 'minTtlSeconds', { positive: true })
  const maxTtlSeconds = readCount(config, 'maxTtlSeconds')
  if (maxTtlSeconds < minTtlSeconds) {
    throw new Error(`dsh-tmp-hook: \`maxTtlSeconds\` (${maxTtlSeconds}) must be >= \`minTtlSeconds\` (${minTtlSeconds})`)
  }

  return {
    baseUrl: normalizeBaseUrl(config.baseUrl ?? DEFAULTS.baseUrl),
    baseUrlScheme: config.baseUrlScheme ?? DEFAULTS.baseUrlScheme,
    pathPrefix: normalizePathPrefix(config.pathPrefix ?? DEFAULTS.pathPrefix),
    ttlSeconds: readCount(config, 'ttlSeconds', { positive: true }),
    minTtlSeconds,
    maxTtlSeconds,
    maxBodyBytes: readCount(config, 'maxBodyBytes', { positive: true }),
    sweepIntervalMs: readCount(config, 'sweepIntervalMs'),
    deliverTimeoutMs: readCount(config, 'deliverTimeoutMs', { positive: true }),
    allowUnauthenticated: config.allowUnauthenticated ?? DEFAULTS.allowUnauthenticated,
  }
}
