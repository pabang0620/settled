import { useState } from 'react'
import { api, settleWords, timeLabel, usd } from '../api.js'

const TONE = { ordered: ['pending', 'Pending'], held: ['held', 'Held'], captured: ['captured', 'Captured'], voided: ['refunded', 'Released'] }

const STATUS_TEXT = {
  ordered: 'Waiting for your PayPal approval',
  held: 'Held, not charged',
  captured: 'Charged and recorded on the invoice',
  voided: 'Hold released, nothing charged',
}

export default function PatronHolds({ state, onChanged, onPay }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const holds = state.patron.holds.filter((h) => h.status !== 'none')
  const [message, setMessage] = useState('')
  const [settleNote, setSettleNote] = useState({})

  async function run(fn) {
    setBusy(true)
    setError('')
    try {
      await fn()
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!holds.length) return null
  return (
    <section className="panel">
      <h3><span className="label orange">Your matches</span></h3>
      {holds.map((h) => (
        <article key={h.billId} className="card">
          <div className="hold-row">
            <h4>{h.billerName} {h.invoiceNumber}</h4>
            <span className="amt">{usd(h.matchCents)}</span>
            {TONE[h.status] && <span className={`st st-${TONE[h.status][0]}`}>{TONE[h.status][1]}</span>}
          </div>
          <p>{STATUS_TEXT[h.status]}{h.status === 'voided' && h.voidReason ? ` (${h.voidReason.replaceAll('_', ' ')})` : ''}. {h.holderAlias} paid {usd(h.holderPaidCents)}.</p>
          {h.status === 'held' && <p className="tiny">Charged after <strong>{timeLabel(h.chargeAfter)}</strong> if their part stays paid until then. The settle job checks every {state.settleJobSeconds} seconds and charges it on its own.</p>}
          {h.status === 'held' && settleNote[h.billId] && <p className="tiny">{settleNote[h.billId]}</p>}
          {h.story && <p className="tiny">Story (unverified): {h.story.text}</p>}
          {h.notices.map((n) => <p key={n} className="notice">{n}</p>)}
          <div className="row wrap">
            {h.status === 'ordered' && <button className="primary orange" disabled={busy} onClick={() => run(() => onPay({ role: 'patron', billId: h.billId, order: { orderId: h.orderId, approvalUrl: h.approvalUrl, amountCents: h.matchCents } }))}>Continue to PayPal</button>}
            {h.status === 'held' && <button className="ghost" disabled={busy} onClick={() => run(async () => {
              const result = await api('POST', `/matches/${h.billId}/settle`)
              setSettleNote((notes) => ({ ...notes, [h.billId]: settleWords(result) }))
            })}>Run the settle job now</button>}
            {['ordered', 'held'].includes(h.status) && <button className="ghost" disabled={busy} onClick={() => run(() => api('POST', `/matches/${h.billId}/release`))}>Release</button>}
          </div>
          {h.status === 'captured' && h.closed && (
            <div className="messages">
              {h.messages.map((m) => <p key={`${m.at}-${m.text}`}><strong>{m.from}:</strong> {m.text}</p>)}
              <div className="row">
                <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Glad to help." maxLength={400} />
                <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('POST', `/messages/${h.billId}`, { text: message }); setMessage('') })}>Send</button>
              </div>
            </div>
          )}
        </article>
      ))}
      <ul className="legend" aria-label="Money states">
        <li><span className="st st-pending">Pending</span>waiting for your PayPal approval</li>
        <li><span className="st st-held">Held</span>authorized on PayPal, not charged</li>
        <li><span className="st st-captured">Captured</span>charged and recorded on the invoice</li>
        <li><span className="st st-refunded">Released</span>hold voided, nothing charged</li>
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
