import { config, modes } from '../config.js'
import { now } from '../clock.js'

// Protection for the hosted live model: a per-IP hourly cap, a per-host daily cap, and a fallback when the model errors.
// One "run" is one user-triggered action (read a bill, draft rules, plan a budget), however many model calls it makes.
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// Local recording and check scripts pass this instead of an IP: no caps, and a model error is thrown, never replaced by a fallback.
export const LOCAL_SCRIPT = 'local-script'
export const LIMIT_REASON = 'live limit reached'
export const ERROR_REASON = 'live model unavailable'

let perIp = new Map()
let day = []

export const resetLiveGuard = () => { perIp = new Map(); day = [] }

const recent = (stamps, windowMs, at) => stamps.filter((t) => at - t < windowMs)

// Takes one run from both windows, or says which limit is hit. Nothing is taken when either limit is hit.
export function takeLiveRun(ip, at = now()) {
  const key = ip || 'unknown'
  const hour = recent(perIp.get(key) || [], HOUR_MS, at)
  const today = recent(day, DAY_MS, at)
  if (hour.length >= config.llmLivePerIpHour || today.length >= config.llmLivePerDay) {
    if (hour.length) perIp.set(key, hour); else perIp.delete(key)
    day = today
    return { ok: false, reason: LIMIT_REASON }
  }
  perIp.set(key, [...hour, at])
  day = [...today, at]
  return { ok: true }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('model timeout')), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * One user action. `call(fn)` runs a model call and never throws: it returns { ok: true, value }, or { ok: false, reason }
 * when the model is not live (reason null), a cap is reached, or the call failed. After the first failure the rest of the
 * action does not call the model again, so one action costs at most one run.
 */
export function beginRun(ip) {
  const local = ip === LOCAL_SCRIPT
  let state = { ok: true, reason: null }
  if (modes.llm !== 'live') state = { ok: false, reason: null }
  else if (!local) {
    const taken = takeLiveRun(ip)
    if (!taken.ok) state = { ok: false, reason: taken.reason }
  }
  return {
    live: state.ok,
    async call(fn) {
      if (!state.ok) return { ok: false, reason: state.reason }
      if (local) return { ok: true, value: await fn() }
      try {
        return { ok: true, value: await withTimeout(fn(), config.llmLiveTimeoutMs) }
      } catch {
        state = { ok: false, reason: ERROR_REASON }
        return { ok: false, reason: ERROR_REASON }
      }
    },
  }
}

// A run that never calls the model (nothing to describe), and takes nothing from the caps.
export const NO_RUN = { live: false, call: async () => ({ ok: false, reason: null }) }

// "Recorded run: ... (live limit reached)". With no reason (the app is simply not live) the label is unchanged.
export const withReason = (label, reason) => (reason ? `${label} (${reason})` : label)
