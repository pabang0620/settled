import { useState } from 'react'
import { api, usd } from '../api.js'

// Stand-in for PayPal's own approval page. With real sandbox credentials the app redirects to PayPal instead.
// `info` only repeats what the screen already showed (biller, invoice, amounts); the order amount comes from the server.
export default function MockCheckout({ order, info, role, matchMode, windowText, payee, persona, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const holding = role !== 'holder' && matchMode !== 'capture_after_window'
  const amount = usd(order.amountCents)
  const billerName = info?.billerName

  async function approve() {
    setBusy(true)
    setError('')
    try {
      await api('POST', '/mock-paypal/approve', { orderId: order.orderId, persona })
      await onDone()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="PayPal checkout">
      <div className="modal paypal">
        <div className="pp"><span className="paypal-logo">PayPal</span><span className="pp-sub">stand-in checkout</span></div>
        <p className="ap-kicker">{holding ? 'Approve a hold' : 'Approve a payment'}</p>
        <p className="amount">{amount}</p>
        <p className="ap-to">to <strong>{billerName || payee}</strong> {billerName && <span className="from">(registry payee)</span>}</p>
        {info && (
          <dl className="summary">
            <dt>Payee</dt><dd>{billerName}, from the biller registry. Not from the document.</dd>
            <dt>Amount</dt><dd>{amount}, from {billerName}'s ledger, set by server code.</dd>
            <dt>Invoice</dt><dd>{info.invoiceNumber}{info.totalCents != null && <> - {usd(info.totalCents)}</>}{info.holderPaidCents != null && <> - holder paid {usd(info.holderPaidCents)}</>}</dd>
            <dt>Approved by</dt><dd>{role === 'holder' ? 'You, with your PayPal login.' : 'You, with your PayPal login. The holder never sees your account.'}</dd>
          </dl>
        )}
        {info && (
          <ul className="timeline">
            {holding ? (
              <>
                <li><span className="st st-held">Held</span><span><b>Now.</b> PayPal holds {amount} for {billerName}. Nothing is charged.</span></li>
                <li><span className="st st-captured">Captured</span><span><b>After the window</b> ({windowText}), if the holder's part stays paid. Recorded on the invoice.</span></li>
                <li><span className="st st-refunded">Released</span><span><b>If the holder reverses</b>, the hold is voided. Nothing charged.</span></li>
              </>
            ) : (
              <li><span className="st st-captured">Captured</span><span><b>Now.</b> PayPal charges {amount} to {billerName} and the payment is recorded on {info.invoiceNumber}.</span></li>
            )}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
        <div className="ap-actions">
          <button className="primary big" onClick={approve} disabled={busy}>{busy ? 'Working...' : holding ? 'Approve hold on PayPal' : 'Approve and pay'}</button>
          <button className="ghost big" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
        <p className="fine">This page stands in for PayPal's approval page because no sandbox credentials are set.</p>
      </div>
    </div>
  )
}
