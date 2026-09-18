import { CLAIM_CONSUMED, CLAIM_EXPIRED, CLAIM_UNKNOWN } from './store.js'

/** Cap on the model-visible size of one delivered payload, in characters. */
const MAX_RENDERED_PAYLOAD_CHARS = 65536

/** Rejection carrying the HTTP status the caller should observe. */
class HttpRejection extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Write a JSON response and finish it. */
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/**
 * Read a request body under a byte cap.
 *
 * An over-cap body stops the read without destroying the socket: the handler
 * still has to answer `413`, and destroying the request would tear down the
 * shared socket before that response could be written.
 * @param req - the incoming request.
 * @param maxBytes - maximum accepted body size.
 * @returns the decoded UTF-8 body.
 * @throws {HttpRejection} 413 when the cap is exceeded, 400 when the body is unreadable.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        req.pause()
        fail(new HttpRejection(413, 'payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => fail(new HttpRejection(400, 'request body could not be read')))
    req.on('aborted', () => fail(new HttpRejection(400, 'request aborted')))
  })
}

/**
 * Classify the callback body for delivery.
 *
 * Any body is acceptable: an absent one is reported as empty, valid JSON is
 * delivered pretty-printed (it is usually a status object handed to a model),
 * and everything else is delivered verbatim as text. The declared media type
 * is carried through only as context for the reader.
 * @param text - raw request body.
 * @param mediaType - the request's `content-type`, if it declared one.
 * @returns the payload descriptor rendered into the session.
 */
function readPayload(text, mediaType) {
  if (text.trim() === '') return { mediaType, kind: 'empty' }
  try {
    return { mediaType, kind: 'json', value: JSON.parse(text) }
  } catch {
    return { mediaType, kind: 'text', text }
  }
}

/** Render the delivered body for the session log, bounded in size. */
function renderPayload(payload) {
  if (payload.kind === 'empty') return '(empty)'
  const text = payload.kind === 'text'
    ? payload.text
    : typeof payload.value === 'string' ? payload.value : JSON.stringify(payload.value, null, 2) ?? String(payload.value)
  return text.length <= MAX_RENDERED_PAYLOAD_CHARS
    ? text
    : `${text.slice(0, MAX_RENDERED_PAYLOAD_CHARS)}\n… [truncated by dsh-tmp-hook]`
}

/**
 * Build the message injected into the owning session when its token is used.
 * @param options - token record, payload descriptor, and delivery instant.
 * @returns the plain-text prompt body.
 */
export function renderCallbackMessage({ record, payload, receivedAt }) {
  const lines = [
    `[dsh-tmp-hook] One-time callback received at ${new Date(receivedAt).toISOString()}.`,
    `Token: ${record.token}`,
  ]
  if (record.purpose) lines.push(`Purpose: ${record.purpose}`)
  if (payload.mediaType) lines.push(`Content-Type: ${payload.mediaType}`)
  lines.push('', 'Payload:', renderPayload(payload))
  return lines.join('\n')
}

/**
 * Create the callback route handler.
 *
 * The token is claimed (and therefore burned) before the body is read, so two
 * concurrent POSTs can never both deliver. Every path that fails to deliver
 * releases the claim again: an unreadable body or a delivery error leaves the
 * caller's one notification intact.
 * @param options - token store, session injector, body cap, and logger.
 * @returns an http handler for the callback route.
 */
export function createCallbackHandler({ prefix, store, inject, maxBodyBytes, logger, now = Date.now }) {
  const tokenBase = `${prefix}/`

  return async function handleCallback(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { received: false, error: 'method not allowed' }, { allow: 'POST' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const token = pathname.startsWith(tokenBase) ? pathname.slice(tokenBase.length) : ''
      if (token === '' || token.includes('/')) {
        sendJson(res, 404, { received: false, error: 'unknown token' })
        return
      }

      const claimed = store.claim(token)
      if (!claimed.ok) {
        const status = claimed.reason === CLAIM_UNKNOWN ? 404 : 410
        const error = claimed.reason === CLAIM_EXPIRED
          ? 'token expired'
          : claimed.reason === CLAIM_CONSUMED ? 'token already used' : 'unknown token'
        sendJson(res, status, { received: false, error })
        return
      }

      let payload
      try {
        payload = readPayload(await readBody(req, maxBodyBytes), req.headers['content-type'])
      } catch (error) {
        store.release(claimed.record)
        if (error instanceof HttpRejection) {
          // The unread remainder of an over-cap body leaves the stream out of
          // sync with the next request, so this response ends the connection.
          sendJson(res, error.status, { received: false, error: error.message },
            error.status === 413 ? { connection: 'close' } : {})
          return
        }
        throw error
      }

      const text = renderCallbackMessage({ record: claimed.record, payload, receivedAt: now() })
      try {
        await inject(claimed.record.sessionId, text)
      } catch (error) {
        store.release(claimed.record)
        logger?.warn?.(`dsh-tmp-hook: delivery to session ${claimed.record.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, 502, { received: false, error: 'delivery failed' })
        return
      }

      logger?.info?.(`dsh-tmp-hook: delivered callback to session ${claimed.record.sessionId}`)
      sendJson(res, 200, { received: true })
    } catch (error) {
      logger?.warn?.(`dsh-tmp-hook: callback failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { received: false, error: 'internal error' })
      else res.end()
    }
  }
}
