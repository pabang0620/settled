import { useState } from 'react'
import { api } from '../api.js'
import RouteView from './RouteView.jsx'
import HolderBill from './HolderBill.jsx'

const DOC_LABEL = { real: 'Real bill', edited_amount: 'Edited amount', hidden_instruction: 'Hidden instruction' }
const BILLER_CHOICES = [
  { id: 'riverside', label: 'Riverside Water' },
  { id: 'cedar', label: 'Cedar Electric (invoice page only)' },
  { id: 'unknown', label: 'Unknown Power Co.' },
]

export default function Holder({ state, onChanged, onPay }) {
  const [biller, setBiller] = useState('riverside')
  const [documents, setDocuments] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function act(fn) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const trySample = () => act(async () => {
    const sample = await api('POST', '/samples', { biller })
    setDocuments(sample.documents)
    setAnalysis(null)
    await onChanged()
  })

  const read = (doc) => act(async () => setAnalysis(await api('POST', `/documents/${doc.id}/analyze`)))

  // After a reading, only the bill that reading belongs to (and only on R1) gets the payment panel.
  const shownBills = analysis ? (analysis.decision.route === 'R1' ? state.bills.filter((b) => b.id === analysis.billId) : []) : state.bills

  return (
    <div className="stack">
      <section className="panel">
        <h3>I need help with a bill</h3>
        <p className="muted">Try a sample bill. The biller issues a fresh invoice for this session, and you get three documents for it.</p>
        <div className="row wrap">
          <select value={biller} onChange={(e) => setBiller(e.target.value)} aria-label="Biller">
            {BILLER_CHOICES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
          <button className="primary" onClick={trySample} disabled={busy}>Try a sample bill</button>
        </div>
        {documents.length > 0 && (
          <div className="docs">
            {documents.map((doc) => (
              <article key={doc.id} className="paper">
                <h5>{documents.length === 1 ? 'Document' : DOC_LABEL[doc.kind]}</h5>
                <pre>{doc.text}</pre>
                <button className="ghost" onClick={() => read(doc)} disabled={busy}>Upload this document</button>
              </article>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {analysis && <RouteView analysis={analysis} />}

      {shownBills.map((bill) => (
        <HolderBill key={bill.id} bill={bill} mockMode={state.modes.paypal === 'mock'} windowShortened={state.demoShortenedWindow} settleJobSeconds={state.settleJobSeconds} matchMode={state.modes.matchMode} onChanged={onChanged} onPay={onPay} />
      ))}
    </div>
  )
}
