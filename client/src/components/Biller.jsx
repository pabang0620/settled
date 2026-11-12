import { useEffect, useState } from 'react'
import { api, dayLabel, usd, dueWords } from '../api.js'

export default function Biller({ state, onChanged }) {
  const [billerId, setBillerId] = useState('riverside')
  const [passcode, setPasscode] = useState('demo-biller')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      setData(await api('GET', '/biller/invoices'))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => { if (state.billerSession) load() }, [state.billerSession])

  async function login() {
    setError('')
    try {
      await api('POST', '/biller/login', { billerId, passcode })
      await onChanged()
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function patch(id, body) {
    setError('')
    try {
      await api('PATCH', `/biller/invoices/${id}`, body)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (!state.billerSession) {
    return (
      <>
      <div className="pagehead"><div><p className="eyebrow">I'm a biller</p><h1>Your invoices, your shutoff dates</h1><p className="lede">Settled pays only to registry billers and reads amounts only from your ledger.</p></div></div>
      <section className="panel">
        <h3>I'm a biller</h3>
        <p className="muted">Demo login for the sandbox biller accounts. Sample invoices you create on the "I need help" tab show up here.</p>
        <div className="row wrap">
          <select value={billerId} onChange={(e) => setBillerId(e.target.value)}>
            {state.billers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} aria-label="Passcode" />
          <button className="primary" onClick={login}>Log in</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
      </>
    )
  }

  return (
    <>
    <div className="pagehead"><div><p className="eyebrow">I'm a biller</p><h1>Your invoices, your shutoff dates</h1><p className="lede">Settled pays only to registry billers and reads amounts only from your ledger.</p></div></div>
    <section className="panel">
      <h3>Biller console: {state.billers.find((b) => b.id === state.billerSession)?.name}</h3>
      {data?.invoices.length === 0 && <p className="muted">No invoices for this session yet. Try a sample bill first.</p>}
      {data?.invoices.map((inv) => (
        <article key={inv.billId} className="card">
          <p><strong>{inv.invoiceNumber}</strong> {inv.accountMask} {usd(inv.totalCents)} {dueWords(inv.dueDate)} - <code>{inv.status}</code> - open balance {usd(inv.dueCents)}</p>
          <div className="row wrap biller-row">
            <label className="switch"><input type="checkbox" checked={inv.sponsorable} onChange={(e) => patch(inv.billId, { sponsorable: e.target.checked })} /> Sponsorable: {inv.sponsorable ? 'ON' : 'OFF'}</label>
            <label>Shutoff date (set by you) <input type="date" value={inv.disconnectDate || ''} onChange={(e) => patch(inv.billId, { disconnectDate: e.target.value || null })} /></label>
          </div>
        </article>
      ))}
      <p className="tiny muted">App access: {data?.appAccess.join(', ')}.</p>
      {error && <p className="error">{error}</p>}
    </section>
    </>
  )
}
