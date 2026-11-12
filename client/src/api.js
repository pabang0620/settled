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
