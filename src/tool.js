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
  'Ask an external worker to notify this session when it finishes.',
  '',
  'Use this BEFORE handing work to anything that will complete later than the current turn and cannot be awaited here: a sandboxed or remote worker, a container or AgentOS task, a CI job, a long-running script, another agent that was dispatched elsewhere, or a human who will reply out of band.',
  'The call returns a single-use HTTPS URL. Give that URL to the worker as part of the task, and tell the worker to POST its result to it exactly once. The POST is appended to this session as a user message and wakes you, so put enough detail in `purpose` to recognize which awaited completion fired.',
  '',
  'Do not use this when the work completes inside this turn (call the tool that does the work instead), when you will poll for the result anyway, or when the worker can already reach you through a channel it holds (an existing webhook subscription, a message bus).',
  'Request one hook per awaited completion: the URL is consumed by its first successful POST, a second POST returns 410, and an expired token returns 410, so a stale URL must be replaced rather than retried.',
].join('\n')

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
 * @param options - resolved config, token store, and a resolver for the public origin.
 * @returns a registry-ready tool definition.
 */
export function createRequestTmpHookTool({ config, store, publicOrigin }) {
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
      const origin = publicOrigin()
      if (origin === '') {
        throw new Error(
          'dsh-tmp-hook cannot build a callback URL: set `baseUrl` (the public origin of this dsh host) in the profile patch, '
          + 'or declare the public domain with `--trusted-host <domain>` when starting dsh',
        )
      }
      const ttlSeconds = clampTtl(args.ttl_seconds, config)
      const purpose = args.purpose?.trim()
      const record = store.issue({
        sessionId,
        purpose: purpose === undefined || purpose === '' ? undefined : purpose,
        ttlSeconds,
      })
      return {
        url: `${origin}${config.pathPrefix}/${record.token}`,
        token: record.token,
        session_id: sessionId,
        expires_at: new Date(record.expiresAt).toISOString(),
        expires_in_seconds: ttlSeconds,
      }
    },
  }
}
