// Durable-write claims for the live PayPal path. A claim is its own record, inserted before the SDK call,
// so a second caller doing the same operation is stopped before it reaches PayPal and a lost answer
// leaves something to settle. In-memory like the rest of the app state (a restart resets every session).
import { createHash } from 'node:crypto'

export class DuplicateClaimError extends Error {
  constructor(record) {
    super(`Claim ${record.key} already exists.`)
    this.code = 'DUPLICATE_CLAIM'
    this.record = record
  }
}

const claims = new Map()
const knownOrders = new Set()
const knownAuthorizations = new Set()

// Deterministic: every caller doing the same operation derives the same id, and PayPal keeps it for 45 days.
export const requestIdFor = (key) => `settled-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`

export function claim(key) {
  if (claims.has(key)) throw new DuplicateClaimError(claims.get(key))
  const record = { key, requestId: requestIdFor(key), state: 'claimed', result: null }
  claims.set(key, record)
  return record
}

const replace = (key, patch) => {
  const next = { ...claims.get(key), ...patch }
  claims.set(key, next)
  return next
}

export const settleClaim = (key, result) => replace(key, { state: 'done', result })
export const markUnknown = (key) => replace(key, { state: 'unknown' })
export const releaseClaim = (key) => { claims.delete(key) }
export const getClaim = (key) => claims.get(key) || null

export const rememberOrder = (id) => { if (id) knownOrders.add(id) }
export const rememberAuthorization = (id) => { if (id) knownAuthorizations.add(id) }
export const isKnownOrder = (id) => knownOrders.has(id)
export const isKnownAuthorization = (id) => knownAuthorizations.has(id)

export function resetClaims() {
  claims.clear()
  knownOrders.clear()
  knownAuthorizations.clear()
}
