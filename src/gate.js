/** Marks a drop-in gate so a second composition pass stays idempotent. */
const COMPOSED = Symbol.for('dsh-tmp-hook.auth-gate')

/**
 * Let one path prefix through `dsh-auth-gate` without a browser session.
 *
 * The plugin's `AuthService.gate` field is explicitly writable, and the guard
 * installed by `dsh-auth-gate` resolves it per request, so overlaying a
 * delegating gate adds an allowlisted prefix without touching the login gate
 * itself. An auth service may also be provided *after* this plugin applies
 * (bundle order is deployment-configurable), so the overlay is installed from
 * the `internal/service` hook as well.
 *
 * This is a no-op when no auth plugin is installed: without a gate there is
 * nothing to allow.
 *
 * @param ctx - the plugin context.
 * @param isAllowed - predicate over an absolute request pathname.
 * @param logger - plugin logger for the one-line audit trail.
 * @returns a disposer that restores the original gate.
 */
export function composeUnauthenticatedPrefix(ctx, isAllowed, logger) {
  const installed = []

  const install = (auth) => {
    const gate = auth?.gate
    if (gate === undefined || typeof gate.decide !== 'function' || gate[COMPOSED] === true) return
    const original = gate
    const composed = {
      decide(req, kind, pathname) {
        return isAllowed(pathname) ? 'allow' : original.decide(req, kind, pathname)
      },
    }
    composed[COMPOSED] = true
    auth.gate = composed
    installed.push(() => {
      if (auth.gate === composed) auth.gate = original
    })
    logger?.info?.('dsh-tmp-hook: dsh-auth-gate composed; the callback prefix does not require a login session')
  }

  install(ctx.get('auth'))
  const off = ctx.on(
    'internal/service',
    (serviceName, value) => {
      if (serviceName === 'auth') install(value)
    },
    { global: true },
  )

  return () => {
    off?.()
    for (const restore of installed.reverse()) restore()
  }
}
