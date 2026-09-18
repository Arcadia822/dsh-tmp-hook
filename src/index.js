/**
 * dsh-tmp-hook — one-time ephemeral webhooks for DeepSeek Harness sessions.
 *
 * A dsh bundle plugin: `package.json` declares `dsh.bundle.patch` →
 * `./cordis.patch.yml`, which inserts the `tmp-hook` row into the profile's
 * Cordis loader tree. When enabled, the plugin registers the
 * `request_tmp_hook` agent tool, serves the generated callback route on the
 * host web server, and appends every delivered payload to the session that
 * asked for the token, waking its agent.
 *
 * The plugin imports nothing outside Node's standard library: `apply` composes
 * only harness services (`ctx.webServer`, `ctx.tools`, `ctx.sessionController`)
 * and the auth plugin's documented writable gate, so it installs into any
 * profile without pulling a second copy of the harness packages.
 *
 * @module dsh-tmp-hook
 */
import { randomUUID } from 'node:crypto'

import { resolveBaseUrl, resolveConfig } from './config.js'
import { composeUnauthenticatedPrefix } from './gate.js'
import { createCallbackHandler } from './http.js'
import { TokenStore } from './store.js'
import { createRequestTmpHookTool } from './tool.js'

/** Stable Cordis plugin name (row id in the bundle patch). */
export const name = 'tmp-hook'

/** Services required before the plugin can mount. */
export const inject = ['webServer', 'tools', 'sessionController']

/**
 * Register the `request_tmp_hook` tool, the callback route, and the token
 * sweeper.
 * @param ctx - plugin context carrying the web server, tool registry, and host session API.
 * @param rawConfig - the loader entry's `config` mapping.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger?.('dsh-tmp-hook')
  const store = new TokenStore()

  /**
   * The public origin, resolved on first use.
   *
   * `webRuntime` is read lazily rather than injected so this plugin mounts
   * whatever the row order is; only a successful resolution is cached, so a
   * late-provided service still self-heals.
   */
  let origin
  const publicOrigin = () => {
    if (origin !== undefined) return origin
    const resolved = resolveBaseUrl({
      baseUrl: config.baseUrl,
      scheme: config.baseUrlScheme,
      trustedHosts: ctx.get('webRuntime')?.trustedHosts ?? [],
    })
    if (resolved.url === '') return ''
    origin = resolved.url
    logger?.info?.(`dsh-tmp-hook: callback origin ${origin} (from ${resolved.source})`)
    return origin
  }

  if (config.baseUrl === '') {
    logger?.info?.('dsh-tmp-hook: `baseUrl` is unset; deriving the callback origin from the deployment trust fence')
  }

  /**
   * Admit one prompt into a session, resuming its agent when it is not live.
   *
   * `prompt` acknowledges as soon as the message is in the agent's inbox, so a
   * slow turn never delays the callback response. It requires a caller signal
   * (it dereferences one before admitting), and a bounded one keeps a stalled
   * host API from pinning the callback request open forever.
   */
  const inject = async (sessionId, text) => {
    await ctx.sessionController.prompt({
      requestId: `tmp-hook-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(config.deliverTimeoutMs))
  }

  ctx.tools.register(createRequestTmpHookTool({ config, store, publicOrigin }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.pathPrefix,
    handler: createCallbackHandler({
      prefix: config.pathPrefix,
      store,
      inject,
      maxBodyBytes: config.maxBodyBytes,
      logger,
    }),
  }), 'dsh-tmp-hook: callback route')

  if (config.allowUnauthenticated) {
    ctx.effect(
      () => composeUnauthenticatedPrefix(
        ctx,
        (pathname) => pathname === config.pathPrefix || pathname.startsWith(`${config.pathPrefix}/`),
        logger,
      ),
      'dsh-tmp-hook: unauthenticated callback prefix',
    )
  }

  ctx.effect(() => {
    if (config.sweepIntervalMs <= 0) return () => {}
    const timer = setInterval(() => store.sweep(), config.sweepIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-tmp-hook: expired-token sweeper')
}
