import { useState } from 'react'
import { api, usd } from '../api.js'

// Stand-in for PayPal's own approval page. With real sandbox credentials the app redirects to PayPal instead.
export default function MockCheckout({ order, payee, persona, onDone, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
        <div className="paypal-logo">PayPal <span>stand-in checkout</span></div>
        <p className="muted">You are paying <strong>{payee}</strong></p>
        <p className="amount">{usd(order.amountCents)}</p>
        <p className="tiny">This page stands in for PayPal's approval page because no sandbox credentials are set.</p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" onClick={approve} disabled={busy}>{busy ? 'Working...' : 'Approve and pay'}</button>
          <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
