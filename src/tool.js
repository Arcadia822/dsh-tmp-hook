/** Model-facing tool name (kept stable: external runbooks reference it). */
export const TOOL_NAME = 'request_tmp_hook'

/** Raw JSON Schema for the tool parameters, published to the model verbatim. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    purpose: {
      type: 'string',
      description: 'Short description of the work this callback waits for, e.g. "requirement agent finished publishing the spec". Repeated back when the callback fires.',
    },
    ttl_seconds: {
      type: 'integer',
      description: 'How long the URL stays valid, in seconds. Defaults to the deployment default and is clamped to the configured window.',
    },
  },
}

/** Raw JSON Schema for the canonical tool result. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: 'The single-use callback URL to hand to the external worker.' },
    token: { type: 'string', description: 'The capability token embedded in the URL.' },
    session_id: { type: 'string', description: 'Session that receives the delivered payload.' },
    expires_at: { type: 'string', description: 'ISO-8601 instant the token stops being usable.' },
    expires_in_seconds: { type: 'integer', description: 'Remaining lifetime in seconds.' },
  },
  required: ['url', 'token', 'session_id', 'expires_at', 'expires_in_seconds'],
}

const DESCRIPTION = [
  'Create a one-time, self-destructing callback URL bound to this session.',
  'Hand the URL to an external, sandboxed, or asynchronous worker; when that worker POSTs to the URL, the body — JSON or any other text — is appended to this session as a user message and wakes you.',
  'The URL works exactly once: a second POST returns 410, and an expired token returns 410. Request a fresh hook whenever a new external completion must be awaited.',
].join(' ')

/** Validate the model-supplied arguments. */
function validateArgs(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`${TOOL_NAME}: arguments must be an object`)
  }
  for (const key of Object.keys(args)) {
    if (key !== 'purpose' && key !== 'ttl_seconds') throw new Error(`${TOOL_NAME}: unknown argument \`${key}\``)
  }
  if (args.purpose !== undefined && typeof args.purpose !== 'string') {
    throw new Error(`${TOOL_NAME}: \`purpose\` must be a string`)
  }
  if (args.ttl_seconds !== undefined && (!Number.isInteger(args.ttl_seconds) || args.ttl_seconds <= 0)) {
    throw new Error(`${TOOL_NAME}: \`ttl_seconds\` must be a positive integer`)
  }
}

/** Clamp a requested TTL into the configured window. */
function clampTtl(requested, config) {
  const wanted = requested ?? config.ttlSeconds
  return Math.min(Math.max(wanted, config.minTtlSeconds), config.maxTtlSeconds)
}

/** Resolve the owning session id of the calling execution. */
function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? exec?.agent?.id
}

/**
 * Build the `request_tmp_hook` tool.
 *
 * The definition is written as a raw `ToolDefinition` rather than through
 * `defineTool` so the plugin ships with no runtime dependencies; the parameter
 * and output schemas are the registry's own published contract.
 * @param options - resolved config, token store, and the configured public origin.
 * @returns a registry-ready tool definition.
 */
export function createRequestTmpHookTool({ config, store, baseUrl }) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [
          `One-time callback URL (single use, expires ${value.expires_at}):`,
          value.url,
          '',
          'The external worker must POST to this URL exactly once; the body is appended to this session and wakes the agent.',
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => ({ url: value.url, expiresAt: value.expires_at }),
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args?.purpose ? `Request one-time webhook: ${args.purpose}` : 'Request one-time webhook',
        kind: 'other',
      }
    },
    presentResult(_args, result) {
      return {
        card: 'generic',
        title: result?.isError === true ? 'One-time webhook request failed' : 'One-time webhook ready',
      }
    },
    async execute(args, exec) {
      validateArgs(args)
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) throw new Error(`${TOOL_NAME}: requires a session-backed agent`)
      if (baseUrl === '') {
        throw new Error('dsh-tmp-hook is not configured: set `baseUrl` (the public origin of this dsh host) in the profile patch')
      }
      const ttlSeconds = clampTtl(args.ttl_seconds, config)
      const purpose = args.purpose?.trim()
      const record = store.issue({
        sessionId,
        purpose: purpose === undefined || purpose === '' ? undefined : purpose,
        ttlSeconds,
      })
      return {
        url: `${baseUrl}${config.pathPrefix}/${record.token}`,
        token: record.token,
        session_id: sessionId,
        expires_at: new Date(record.expiresAt).toISOString(),
        expires_in_seconds: ttlSeconds,
      }
    },
  }
}
