import { useState } from 'react'
import { api, usd } from '../api.js'

// The same sentence the recorded model run used, so the stand-in can replay that run.
const RULES_EXAMPLE = 'I can give about $200 a month, up to $120 per bill, and the holder should pay at least 1/2. I live in OH.'

export default function PatronRules({ state, onChanged }) {
  const rules = state.patron.rules
  const [form, setForm] = useState({ budget: rules.monthlyBudgetCents / 100, cap: rules.perBillCapCents / 100, floor: rules.minHolderShare, region: rules.region })
  const [sentence, setSentence] = useState(RULES_EXAMPLE)
  const [draftedBy, setDraftedBy] = useState('')
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
      setDraftedBy(d.source)
      setSaved(false)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section className="panel">
      <h3>Rules (filters)</h3>
      <div className="rules">
        <div className="rule-grid">
          <label>Monthly budget $<input type="number" min="1" value={form.budget} onChange={set('budget')} /></label>
          <label>Per bill up to $<input type="number" min="1" value={form.cap} onChange={set('cap')} /></label>
          <label>Holder pays at least
            <select value={form.floor} onChange={set('floor')}><option>1/3</option><option>1/2</option><option>2/3</option></select>
          </label>
          <label>State<input value={form.region} onChange={set('region')} maxLength={2} /></label>
        </div>
        <button className="primary block" onClick={save}>Save rules</button>
        <label>Or describe them
          <textarea rows={3} placeholder='"$200 a month, up to $90 per bill, holder pays at least 1/2"' value={sentence} onChange={(e) => setSentence(e.target.value)} />
        </label>
        <button className="ghost block" onClick={draft} disabled={sentence.length < 3}>Draft rules</button>
      </div>
      {draftedBy && <p className="tiny muted">Draft filled in above by [{draftedBy}]. Check it, then press Save rules.</p>}
      <p className="tiny muted">Spent {usd(state.patron.spentCents)} this month, {usd(state.patron.remainingCents)} left. {saved || state.patron.saved ? 'Rules saved.' : 'Showing defaults; save to keep them.'}</p>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
