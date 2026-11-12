import { useState } from 'react'
import { api, usd } from '../api.js'

export default function PatronRules({ state, onChanged }) {
  const rules = state.patron.rules
  const [form, setForm] = useState({ budget: rules.monthlyBudgetCents / 100, cap: rules.perBillCapCents / 100, floor: rules.minHolderShare, region: rules.region })
  const [sentence, setSentence] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const set = (key) => (e) => { setSaved(false); setForm({ ...form, [key]: e.target.value }) }

  async function save() {
    setError('')
    try {
      await api('PUT', '/patron/rules', { monthlyBudgetCents: Math.round(Number(form.budget) * 100), perBillCapCents: Math.round(Number(form.cap) * 100), minHolderShare: form.floor, category: 'utilities', region: form.region.toUpperCase(), type: 'individual' })
      setSaved(true)
      await onChanged()
    } catch (err) {
      setError(err.message)
    }
  }

  async function draft() {
    setError('')
    try {
      const d = await api('POST', '/patron/rules/draft', { text: sentence })
      setForm({ budget: d.monthlyBudgetCents / 100, cap: d.perBillCapCents / 100, floor: d.minHolderShare, region: d.region })
      setSaved(false)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section className="panel">
      <h3>Rules (filters)</h3>
      <div className="row wrap rules">
        <label>Monthly budget $<input type="number" min="1" value={form.budget} onChange={set('budget')} /></label>
        <label>Per bill up to $<input type="number" min="1" value={form.cap} onChange={set('cap')} /></label>
        <label>Holder pays at least
          <select value={form.floor} onChange={set('floor')}><option>1/3</option><option>1/2</option><option>2/3</option></select>
        </label>
        <label>State<input value={form.region} onChange={set('region')} maxLength={2} className="short" /></label>
        <button className="primary" onClick={save}>Save rules</button>
      </div>
      <div className="row wrap">
        <input className="wide" placeholder='Or describe them: "$200 a month, up to $90 per bill, holder pays at least 1/2"' value={sentence} onChange={(e) => setSentence(e.target.value)} />
        <button className="ghost" onClick={draft} disabled={sentence.length < 3}>Draft rules</button>
      </div>
      <p className="tiny muted">Spent {usd(state.patron.spentCents)} this month, {usd(state.patron.remainingCents)} left. {saved || state.patron.saved ? 'Rules saved.' : 'Showing defaults; save to keep them.'}</p>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
