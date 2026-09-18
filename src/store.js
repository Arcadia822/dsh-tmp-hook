import { randomUUID } from 'node:crypto'

/** A token that was already delivered before and therefore can never be replayed. */
export const CLAIM_CONSUMED = 'consumed'
/** A token whose TTL elapsed before it was ever delivered. */
export const CLAIM_EXPIRED = 'expired'
/** A token that was never issued (or was already swept after its TTL). */
export const CLAIM_UNKNOWN = 'unknown'

/**
 * In-memory registry of single-use callback tokens.
 *
 * Every record is addressed by an unguessable random token and carries the
 * session that requested it plus an absolute expiry. `claim` is the only
 * mutation that can admit a callback and it is atomic (synchronous), so two
 * concurrent POSTs of the same token can never both deliver.
 */
export class TokenStore {
  #records = new Map()
  #now

  /**
   * @param options - clock injection point, for tests.
   */
  constructor(options = {}) {
    this.#now = options.now ?? Date.now
  }

  /** Number of live records (including already-claimed ones awaiting expiry). */
  get size() {
    return this.#records.size
  }

  /**
   * Mint a token bound to one session.
   * @param options - owning session, optional purpose, and TTL in seconds.
   * @returns the stored record.
   */
  issue({ sessionId, purpose, ttlSeconds }) {
    const createdAt = this.#now()
    const record = {
      token: randomUUID(),
      sessionId,
      purpose,
      createdAt,
      expiresAt: createdAt + ttlSeconds * 1000,
      claimedAt: undefined,
    }
    this.#records.set(record.token, record)
    return record
  }

  /**
   * Atomically take a token for delivery.
   *
   * A successful claim marks the record consumed, which is what makes the
   * callback single-use: the very next claim of the same token reports
   * {@link CLAIM_CONSUMED} even before the delivery settles. Call
   * {@link release} only when delivery failed, so a transient failure does not
   * burn the one notification the caller was given.
   * @param token - the path token.
   * @returns a successful claim or the reason the token cannot be used.
   */
  claim(token) {
    const record = this.#records.get(token)
    if (record === undefined) return { ok: false, reason: CLAIM_UNKNOWN }
    if (record.expiresAt <= this.#now()) {
      this.#records.delete(token)
      return { ok: false, reason: CLAIM_EXPIRED }
    }
    if (record.claimedAt !== undefined) return { ok: false, reason: CLAIM_CONSUMED }
    record.claimedAt = this.#now()
    return { ok: true, record }
  }

  /**
   * Undo a claim whose delivery failed. The token becomes usable again, which
   * is safe because no message was injected.
   * @param record - the record returned by a successful {@link claim}.
   */
  release(record) {
    if (this.#records.get(record.token) === record) record.claimedAt = undefined
  }

  /**
   * Drop every record whose TTL elapsed. Claimed records are kept until then so
   * a replay is answered with `410` rather than an indistinguishable `404`.
   * @returns how many records were removed.
   */
  sweep() {
    const now = this.#now()
    let removed = 0
    for (const [token, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#records.delete(token)
        removed += 1
      }
    }
    return removed
  }

  /** Drop every record. */
  clear() {
    this.#records.clear()
  }
}
