import { useState } from 'react'
import { api, dayLabel, settleWords, timeLabel, usd, windowWords } from '../api.js'

const STEPS = ['Your part', 'A patron holds the match', 'Charged to the biller', 'Paid']
const CAPTURE_STEPS = ['Your part', 'The window runs, then a patron matches', 'Charged to the biller', 'Paid']

function progress(bill) {
  if (bill.closed) return 3
  if (bill.match.status === 'held') return 1
  if (bill.holder.status === 'captured') return 1
  return 0
}

export default function HolderBill({ bill, mockMode, windowShortened, settleJobSeconds, matchMode, onChanged, onPay }) {
  const [share, setShare] = useState(bill.share || bill.defaultShare)
  const [story, setStory] = useState(bill.story || '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [settleNote, setSettleNote] = useState('')
  const step = progress(bill)
  const selected = bill.shareOptions.find((o) => o.share === share)
  const canPay = bill.statusClass === 'payable' && bill.holder.status !== 'captured' && bill.paymentModes.includes('payee_order')

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

  return (
    <section className="panel holder-panel">
      <h3><span className="label blue">Holder's part</span> {bill.billerName} {bill.invoiceNumber} {bill.accountMask}</h3>
      <p>
        Your bill: <strong>{usd(bill.totalCents)}</strong> - due {dayLabel(bill.dueDate)}
        {bill.disconnectDate && <> - shutoff {dayLabel(bill.disconnectDate)} <span className="tiny muted">(set by {bill.billerName})</span></>}
        {' '}- ledger status <code>{bill.ledgerStatus}</code>
      </p>

      <ol className="steps">{(matchMode === 'capture_after_window' ? CAPTURE_STEPS : STEPS).map((s, i) => <li key={s} className={i <= step ? 'on' : ''}>{s}</li>)}</ol>

      {canPay && (
        <div className="share-box">
          <div className="radio-row">
            {bill.shareOptions.map((o) => (
              <label key={o.share} className={share === o.share ? 'chosen' : ''}>
                <input type="radio" name={`share-${bill.id}`} checked={share === o.share} onChange={() => setShare(o.share)} disabled={!!bill.share} />
                {o.share} <strong>{usd(o.holderCents)}</strong>
              </label>
            ))}
          </div>
          <p className="tiny muted">Options set by {bill.billerName}. {bill.demandLine}.</p>
          {selected?.patronsMatching === 0 && <p className="warn">No patron matches {share} bills right now. Your bill waits in the feed.</p>}
          <button className="primary blue" disabled={busy} onClick={() => run(async () => {
            const started = await api('POST', `/bills/${bill.id}/holder/start`, { share })
            await onPay({ role: 'holder', billId: bill.id, order: started })
          })}>Pay my part with PayPal to {bill.billerName}</button>
        </div>
      )}

      {bill.holder.status === 'ordered' && (
        <div className="row">
          <button className="primary blue" disabled={busy} onClick={() => run(async () => {
            await onPay({ role: 'holder', billId: bill.id, order: { orderId: bill.holder.orderId, approvalUrl: bill.holder.approvalUrl, amountCents: bill.holder.amountCents } })
          })}>Continue to PayPal</button>
          <button className="ghost" disabled={busy} onClick={() => run(() => api('POST', `/bills/${bill.id}/holder/cancel`))}>Cancel this payment</button>
        </div>
      )}

      {bill.holder.status === 'captured' && (
        <p className="status-line">
          Paid through Settled - your part {usd(bill.holder.amountCents)} - {bill.holder.recorded ? 'recorded on the invoice' : 'recording on the invoice...'}.
          {' '}{bill.share && <>Share fixed at {bill.share}.</>}
        </p>
      )}
      {bill.holder.status === 'captured' && !bill.holder.recorded && (
        <button className="ghost" disabled={busy} onClick={() => run(() => api('POST', `/bills/${bill.id}/holder/complete`))}>Retry recording</button>
      )}

      {bill.match.status === 'none' && bill.holder.status === 'captured' && !bill.holderReversed && (
        <p className="muted">Your part is paid and visible to patrons whose rules fit. {selected?.patronsMatching === 0 ? 'No patron matches your share right now.' : ''}</p>
      )}
      {bill.match.status === 'ordered' && <p className="muted">{bill.match.patron} is approving a hold on PayPal.</p>}
      {bill.match.status === 'held' && (
        <div className="callout orange">
          <strong>{bill.match.patron} is holding your match ({usd(bill.match.amountCents)}).</strong>
          <p>Charged after <strong>{timeLabel(bill.match.chargeAfter)}</strong> if your part stays paid until then (window {windowWords(bill.holdWindowMinutes)}{windowShortened ? ', shortened for the demo; production is 3 days' : ''}). The settle job checks every {settleJobSeconds} seconds and charges it on its own.</p>
          <button className="ghost" disabled={busy} onClick={() => run(async () => setSettleNote(settleWords(await api('POST', `/matches/${bill.id}/settle`))))}>Run the settle job now</button>
          {settleNote && <p className="tiny">{settleNote}</p>}
        </div>
      )}
      {bill.match.status === 'voided' && <p className="warn">The patron hold was released ({bill.match.voidReason?.replaceAll('_', ' ')}). Nothing was charged.</p>}
      {bill.notices.map((n) => <p key={n} className="notice">{n}</p>)}
      {bill.closed && bill.match.status === 'captured' && (
        <div className="callout green">
          <strong>{bill.billerName} {bill.invoiceNumber} PAID</strong> - your part {usd(bill.holder.amountCents)} - a patron's match {usd(bill.match.amountCents)}
        </div>
      )}

      {mockMode && bill.holder.status === 'captured' && !bill.holderReversed && !bill.closed && (
        <p className="tiny"><button className="link" disabled={busy} onClick={() => run(() => api('POST', `/mock/reverse-holder/${bill.id}`))}>Stand-in only: simulate my bank pulling my payment back</button></p>
      )}

      {bill.holder.status === 'captured' && !bill.closed && (
        <div className="story">
          <label>Short story for patrons (shown as unverified)
            <textarea value={story} onChange={(e) => setStory(e.target.value)} maxLength={400} rows={2} />
          </label>
          <button className="ghost" disabled={busy || !story} onClick={() => run(() => api('PUT', `/bills/${bill.id}/story`, { text: story }))}>Save story</button>
        </div>
      )}

      {bill.closed && bill.match.status === 'captured' && (
        <div className="messages">
          <h4>Say thanks</h4>
          {bill.messages.map((m) => <p key={`${m.at}-${m.text}`} className={m.mine ? 'mine' : ''}><strong>{m.from}:</strong> {m.text}</p>)}
          <div className="row">
            <input className="wide" value={message} placeholder="We each paid half. Thank you." onChange={(e) => setMessage(e.target.value)} maxLength={400} />
            <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('POST', `/messages/${bill.id}`, { text: message }); setMessage('') })}>Send</button>
          </div>
          <p className="tiny muted">Contact details, payment handles and requests are blocked.</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
