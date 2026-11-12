const SESSION_KEY = 'settled.session'

let sessionId = localStorage.getItem(SESSION_KEY)

async function ensureSession() {
  if (sessionId) return sessionId
  const res = await fetch('/api/session', { method: 'POST' })
  const json = await res.json()
  sessionId = json.data.sessionId
  localStorage.setItem(SESSION_KEY, sessionId)
  return sessionId
}

// Forget this browser's session; the next request starts a fresh one (budget, bills and holds start over).
export function forgetSession() {
  localStorage.removeItem(SESSION_KEY)
  sessionId = null
}

export async function api(method, path, body) {
  const send = async () => fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': await ensureSession() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let res = await send()
  if (res.status === 401) {
    // The server restarted and forgot this session.
    localStorage.removeItem(SESSION_KEY)
    sessionId = null
    res = await send()
  }
  const json = await res.json()
  if (!json.success) throw new Error(json.message || 'Request failed')
  return json.data
}

export const usd = (cents) => (cents == null ? '-' : `$${(cents / 100).toFixed(2)}`)
export const dayLabel = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-')
export const timeLabel = (ms) => (ms == null ? '-' : new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))

// How long the holder's part must stay paid before a match is charged, in words.
export function windowWords(minutes) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} days`
  if (minutes >= 60) return `${Math.round(minutes / 60)} hours`
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return 'no wait'
}

// What the settle call answered, in words. "waiting" says until when.
export function settleWords(result) {
  if (!result) return ''
  if (result.state === 'waiting') return `Not charged yet: the holder's part must stay paid until ${timeLabel(result.chargeAfter)}. The settle job charges it then on its own.`
  if (result.state === 'captured') return `Charged. Invoice status ${result.invoiceStatus}.`
  if (result.state === 'voided') return `Hold released (${String(result.voidReason || '').replaceAll('_', ' ')}). Nothing was charged.`
  return `State: ${result.state}`
}
