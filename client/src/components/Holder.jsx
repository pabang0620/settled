import { useState } from 'react'
import { api } from '../api.js'
import RouteView from './RouteView.jsx'
import HolderBill, { BillSteps } from './HolderBill.jsx'

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
  const [readId, setReadId] = useState(null)
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
    setReadId(null)
    await onChanged()
  })

  const read = (doc) => act(async () => {
    setAnalysis(await api('POST', `/documents/${doc.id}/analyze`))
    setReadId(doc.id)
  })

  // After a reading, only the bill that reading belongs to (and only on R1) gets the payment panel.
  const shownBills = analysis ? (analysis.decision.route === 'R1' ? state.bills.filter((b) => b.id === analysis.billId) : []) : state.bills
  // The page is about one bill once a document is read, or when the session has only one bill.
  const focus = (analysis && state.bills.find((b) => b.id === analysis.billId)) || (state.bills.length === 1 ? state.bills[0] : null)
  const headSteps = focus && shownBills.length === 1 && shownBills[0].id === focus.id
  const readDoc = documents.find((d) => d.id === readId)
  const matchMode = state.modes.matchMode

  return (
    <>
      <div className="pagehead">
        <div>
          <p className="eyebrow">I need help with a bill</p>
          {focus
            ? <h1>{focus.billerName} {focus.invoiceNumber} <span className="acct">{focus.accountMask}</span></h1>
            : <h1>Pay your part, a patron matches the rest</h1>}
          <p className="lede">
            {readDoc
              ? `You uploaded the ${DOC_LABEL[readDoc.kind]?.toLowerCase() || 'document'}. The server checked it against ${focus?.billerName || "the biller"}'s own invoice, not against the paper.`
              : "Every document is checked against the biller's own invoice, not against the paper."}
          </p>
        </div>
        {headSteps && <BillSteps bill={focus} matchMode={matchMode} />}
      </div>

      <div className={shownBills.length ? 'body' : 'body one'}>
        <div className="stack">
          <section className="panel">
            <h3>Try a sample bill</h3>
            <p className="muted">The biller issues a fresh invoice for this session, and you get three documents for it.</p>
            <div className="row wrap">
              <select value={biller} onChange={(e) => setBiller(e.target.value)} aria-label="Biller">
                {BILLER_CHOICES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
              <button className="primary" onClick={trySample} disabled={busy}>Try a sample bill</button>
            </div>
            {documents.length > 0 && (
              <div className="docs">
                {documents.map((doc) => (
                  <article key={doc.id} className={doc.id === readId ? 'paper on' : 'paper'}>
                    <h5>{documents.length === 1 ? 'Document' : DOC_LABEL[doc.kind]}</h5>
                    <pre>{doc.text}</pre>
                    <button className={doc.id === readId ? 'primary' : 'ghost'} onClick={() => read(doc)} disabled={busy}>Upload this document</button>
                  </article>
                ))}
              </div>
            )}
            {error && <p className="error">{error}</p>}
          </section>

          {analysis && <RouteView analysis={analysis} />}
        </div>

        {shownBills.length > 0 && (
          <aside className="aside">
            {shownBills.map((bill) => (
              <HolderBill key={bill.id} bill={bill} hideSteps={headSteps && bill.id === focus.id} mockMode={state.modes.paypal === 'mock'} windowShortened={state.demoShortenedWindow} settleJobSeconds={state.settleJobSeconds} matchMode={matchMode} onChanged={onChanged} onPay={onPay} />
            ))}
          </aside>
        )}
      </div>
    </>
  )
}
