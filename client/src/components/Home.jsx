import { useState } from 'react'
import { api } from '../api.js'

export default function Home({ state, go, onChanged, onPay }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mock = state.modes.paypal === 'mock'

  async function fastPath() {
    setBusy(true)
    setError('')
    try {
      const { card } = await api('POST', '/demo/fast-path')
      const order = await api('POST', `/matches/${card.billId}/request`)
      await onPay({ role: 'patron', billId: card.billId, order, goto: 'patron', autoSettle: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
    await onChanged()
  }

  return (
    <section className="hero">
      <h1>Settled</h1>
      <p className="tagline">The bill is untrusted. The payee isn't.</p>
      <p className="lead">You pay your part of a real bill to the biller. A stranger matches the rest. Both payments land on the biller's PayPal invoice, and a document can never move the money.</p>
      <div className="row wrap center">
        {mock && <button className="primary big" onClick={fastPath} disabled={busy}>Watch one bill get settled</button>}
        <button className="ghost big" onClick={() => go('patron')}>I'm a patron</button>
        <button className="ghost big" onClick={() => go('holder')}>I need help with a bill</button>
        <button className="ghost big" onClick={() => go('biller')}>I'm a biller</button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="tiny muted">Try a sample bill under "I need help with a bill": Real, Edited amount, Hidden instruction. Each session gets a new invoice.</p>
      <ul className="facts">
        <li><strong>Payee</strong> comes from the biller registry, never from the document.</li>
        <li><strong>Amounts</strong> come from the biller's ledger and server code, never from the model.</li>
        <li><strong>Money moves</strong> only after a person approves on PayPal.</li>
      </ul>
    </section>
  )
}
