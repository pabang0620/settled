import { useState } from 'react'
import { api, dayLabel, settleWords, timeLabel, usd, windowWords, dueWords } from '../api.js'

const STEPS = ['Your part', 'A patron holds the match', 'Charged to the biller', 'Paid']
const CAPTURE_STEPS = ['Your part', 'The window runs, then a patron matches', 'Charged to the biller', 'Paid']
// Ledger status class (server/bills.js STATUS_CLASS) to the money-state colour.
const LEDGER_TONE = { payable: 'pending', pending: 'pending', partial: 'held', closed: 'captured', refund: 'refunded', blocked: 'failed', unknown: 'refunded' }

// Light a step only when it is true: in hold mode "A patron holds the match" waits for an actual hold.
function progress(bill, matchMode) {
  if (bill.closed) return 3
  if (bill.match.status === 'held') return 1
  if (bill.holder.status === 'captured' && matchMode === 'capture_after_window') return 1
  return 0
}

export function BillSteps({ bill, matchMode }) {
  const step = progress(bill, matchMode)
  const names = matchMode === 'capture_after_window' ? CAPTURE_STEPS : STEPS
  const cls = (i) => (bill.closed || i < step ? 'done' : i === step ? 'on' : '')
  return <ol className="steps" aria-label="Progress">{names.map((s, i) => <li key={s} className={cls(i)}><b>{i + 1}</b><span>{s}</span></li>)}</ol>
}

export default function HolderBill({ bill, hideSteps, mockMode, windowShortened, settleJobSeconds, matchMode, onChanged, onPay }) {
  const [share, setShare] = useState(bill.share || bill.defaultShare)
  const [story, setStory] = useState(bill.story || '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [settleNote, setSettleNote] = useState('')
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
    <section className="panel pay holder-panel">
      <div className="pay-head">
        <span className="label blue">Holder's part</span>
        <span className={`st st-${LEDGER_TONE[bill.statusClass] || 'refunded'}`}>Ledger {bill.ledgerStatus}</span>
      </div>
      {hideSteps ? null : <p className="pay-title">{bill.billerName} {bill.invoiceNumber} {bill.accountMask}</p>}
      <div className="bill-total"><span>Your bill</span><strong>{usd(bill.totalCents)}</strong></div>
      <p className="meta">
        {dueWords(bill.dueDate)}
        {bill.disconnectDate && <> - shutoff {dayLabel(bill.disconnectDate)} <span className="tiny">(set by {bill.billerName})</span></>}
        {' '}- ledger status <code>{bill.ledgerStatus}</code>
      </p>

      {!hideSteps && <BillSteps bill={bill} matchMode={matchMode} />}

      {canPay && (
        <>
          <fieldset className="shares">
            <legend>How much do you pay now?</legend>
            {bill.shareOptions.map((o) => (
              <label key={o.share} className={share === o.share ? 'chosen' : ''}>
                <input type="radio" name={`share-${bill.id}`} checked={share === o.share} onChange={() => setShare(o.share)} disabled={!!bill.share} />
                <span>{o.share}</span> <b>{usd(o.holderCents)}</b>
              </label>
            ))}
          </fieldset>
          <p className="hint">Options set by {bill.billerName}. {bill.demandLine}.</p>
          {selected?.patronsMatching === 0 && <p className="warn">No patron matches {share} bills right now. Your bill waits in the feed.</p>}
          <dl className="summary">
            <dt>You pay now</dt><dd className="strong">{usd(selected?.holderCents)}</dd>
            <dt>A patron can match</dt><dd>{usd(selected?.matchCents)}</dd>
            <dt>Paid to</dt><dd>{bill.billerName} <span className="from">(registry)</span></dd>
            <dt>Approved by</dt><dd>You, on PayPal</dd>
          </dl>
          <div className="what">
            <p className="what-h">What PayPal will do</p>
            <ol>
              <li>Charge <b>{usd(selected?.holderCents)}</b> from your PayPal to {bill.billerName}.</li>
              <li>Record it on invoice {bill.invoiceNumber} (partially paid).</li>
              <li>Show a match card to patrons whose rules fit.</li>
            </ol>
          </div>
          <button className="primary blue big block" disabled={busy} onClick={() => run(async () => {
            const started = await api('POST', `/bills/${bill.id}/holder/start`, { share })
            await onPay({ role: 'holder', billId: bill.id, order: started, info: { billerName: bill.billerName, invoiceNumber: bill.invoiceNumber, totalCents: bill.totalCents } })
          })}>Pay my part with PayPal to {bill.billerName}</button>
          <p className="fine">Your share is fixed on the invoice when you press pay. Money goes to {bill.billerName}, never to a person.</p>
        </>
      )}

      {bill.holder.status === 'ordered' && (
        <div className="row wrap">
          <button className="primary blue" disabled={busy} onClick={() => run(async () => {
            await onPay({ role: 'holder', billId: bill.id, order: { orderId: bill.holder.orderId, approvalUrl: bill.holder.approvalUrl, amountCents: bill.holder.amountCents }, info: { billerName: bill.billerName, invoiceNumber: bill.invoiceNumber, totalCents: bill.totalCents } })
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
          <span className="st st-held">Held</span>
          <p><strong>{bill.match.patron} is holding your match ({usd(bill.match.amountCents)}).</strong></p>
          <p>Charged after <strong>{timeLabel(bill.match.chargeAfter)}</strong> if your part stays paid until then (window {windowWords(bill.holdWindowMinutes)}{windowShortened ? ', shortened for the demo; production is 3 days' : ''}). The settle job checks every {settleJobSeconds} seconds and charges it on its own.</p>
          <button className="ghost" disabled={busy} onClick={() => run(async () => setSettleNote(settleWords(await api('POST', `/matches/${bill.id}/settle`))))}>Run the settle job now</button>
          {settleNote && <p className="tiny">{settleNote}</p>}
        </div>
      )}
      {bill.match.status === 'voided' && <p className="warn">The patron hold was released ({bill.match.voidReason?.replaceAll('_', ' ')}). Nothing was charged.</p>}
      {bill.notices.map((n) => <p key={n} className="notice">{n}</p>)}
      {bill.closed && bill.match.status === 'captured' && (
        <div className="callout green">
          <span className="st st-captured">Paid</span>
          <p><strong>{bill.billerName} {bill.invoiceNumber} PAID</strong> - your part {usd(bill.holder.amountCents)} - a patron's match {usd(bill.match.amountCents)}</p>
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
          <div className="row wrap">
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
