import { useState } from 'react'
import { api, usd } from '../api.js'
import MatchCard from './MatchCard.jsx'
import PatronRules from './PatronRules.jsx'
import PatronHolds from './PatronHolds.jsx'
import RecordedRun from './RecordedRun.jsx'

const OPTION_TITLE = { A: 'Plan A (most urgent first)', B: 'Plan B (close the most bills)' }

function OptionBox({ option, onChoose, busy }) {
  return (
    <article className="card option">
      <h4>{option.id === 'A' && option.objective === 'best_fit' ? 'Best fit' : OPTION_TITLE[option.id]}</h4>
      <p><strong>{option.count} bills, {usd(option.totalCents)}</strong> of {usd(option.budgetCents)}</p>
      <p className="tiny">{option.bills.map((b) => `${b.invoiceNumber} ${usd(b.matchCents)}`).join(' + ')}</p>
      <p className="tiny muted">{option.urgentCovered} with a shutoff inside 5 days{option.leavesUrgent.length ? `, leaves ${option.leavesUrgent.join(', ')} open` : ''}</p>
      <button className="primary orange" disabled={busy} onClick={() => onChoose(option.id)}>Choose {option.id}</button>
    </article>
  )
}

// Spent counts a match from the moment its order is placed (server/patron.js); split it into charged and still held.
function BudgetMeter({ state }) {
  const budget = state.patron.rules.monthlyBudgetCents
  const charged = state.patron.holds.filter((h) => h.status === 'captured').reduce((sum, h) => sum + h.matchCents, 0)
  const held = Math.max(0, state.patron.spentCents - charged)
  const pct = (cents) => `${budget > 0 ? Math.min(100, (cents / budget) * 100) : 0}%`
  return (
    <section className="panel budget" aria-label="Monthly budget">
      <div className="b-row"><span>Monthly budget</span><span><b>{usd(state.patron.remainingCents)}</b> <span className="muted">left of {usd(budget)}</span></span></div>
      <div className="meter" aria-hidden="true"><i className="spent" style={{ width: pct(charged) }} /><i className="this" style={{ width: pct(held) }} /></div>
      <div className="b-key">
        <span><i className="k spent" />Charged {usd(charged)}</span>
        <span><i className="k this" />Held or waiting for approval {usd(held)}</span>
        <span><i className="k left" />Left {usd(state.patron.remainingCents)}</span>
      </div>
    </section>
  )
}

export default function Patron({ state, onChanged, onPay }) {
  const [text, setText] = useState('Use my last $300 this month, most urgent first')
  const [plan, setPlan] = useState(null)
  const [cards, setCards] = useState(null)
  const [feed, setFeed] = useState(null)
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

  const runPlan = () => act(async () => {
    setCards(null)
    setPlan(await api('POST', '/patron/plan', { text }))
  })
  const choose = (id) => act(async () => setCards(await api('POST', `/patron/plan/${id}/choose`)))
  const loadFeed = () => act(async () => setFeed(await api('GET', '/patron/feed')))
  const prepare = () => act(async () => { await api('POST', '/demo/prepare'); await loadFeed() })
  const hold = (card) => act(async () => {
    const order = await api('POST', `/matches/${card.billId}/request`)
    await onPay({ role: 'patron', billId: card.billId, order, info: { billerName: card.billerName, invoiceNumber: card.invoiceNumber, holderPaidCents: card.holderPaidCents } })
  })
  const windowMinutes = state.holdWindowMinutes
  // A bill this patron already holds or paid leaves the feed and the batch (its button would only answer 409).
  const taken = new Set(state.patron.holds.filter((h) => ['ordered', 'held', 'captured'].includes(h.status)).map((h) => h.billId))
  const open = (list) => list.filter((card) => !taken.has(card.billId))

  const rules = state.patron.rules
  return (
    <>
      <div className="pagehead">
        <div>
          <p className="eyebrow">I'm a patron</p>
          <h1>Give by rule, approve card by card</h1>
          <p className="lede">Your rules: {usd(rules.monthlyBudgetCents)} a month, up to {usd(rules.perBillCapCents)} per bill, holder pays at least {rules.minHolderShare}, {rules.region}.</p>
        </div>
      </div>
      <div className="body">
      <div className="stack">
      <BudgetMeter state={state} />

      <section className="panel">
        <h3><span className="label orange">Patron's match</span> Bills that fit your rules</h3>
        <div className="row wrap">
          <input className="wide" value={text} onChange={(e) => setText(e.target.value)} aria-label="What do you want to do" maxLength={400} />
          <button className="primary orange" onClick={runPlan} disabled={busy}>Plan my budget</button>
          <button className="ghost" onClick={loadFeed} disabled={busy}>Show open bills</button>
          {state.modes.paypal === 'mock' && <button className="ghost" onClick={prepare} disabled={busy}>Prepare demo bills</button>}
        </div>
        {error && <p className="error">{error}</p>}

        {plan && (
          <div className="plan">
            <p><span className="tag model">Agent</span> {plan.narrative} <span className="tiny muted">[{plan.source}]</span></p>
            <RecordedRun run={plan.recording} />
            <p className="tiny muted">Every bill is at most {usd(plan.capCents)}; totals stay within {usd(plan.budgetCents)} (server-checked). Options are computed by the server; no option is beaten by another set of {plan.truncated ? `the ${plan.enumerated} most urgent bills (more bills fit; only these were compared)` : 'these bills'}.</p>
            {plan.skipped.length > 0 && <p className="tiny warn">{plan.skipped.length} skipped: {plan.skipped.map((s) => `${s.invoiceNumber} (${s.reason})`).join(', ')}</p>}
            <div className="options">{plan.options.map((o) => <OptionBox key={o.id} option={o} onChoose={choose} busy={busy} />)}</div>
            {plan.options.length === 0 && <p className="muted">No bill fits right now. Open bills appear here as holders pay their part.</p>}
          </div>
        )}
        {cards && (
          <div className="cards">
            {cards.dropped.length > 0 && <p className="tiny warn">Dropped on recheck: {cards.dropped.map((d) => `${d.invoiceNumber} (${d.reason})`).join(', ')}</p>}
            {open(cards.cards).map((card, i, list) => <MatchCard key={card.billId} card={card} index={i} total={list.length} windowMinutes={windowMinutes} shortened={state.demoShortenedWindow} matchMode={state.modes.matchMode} busy={busy} onHold={hold} />)}
          </div>
        )}
        {feed && !cards && (
          <div className="cards">
            {open(feed.cards).length === 0 && <p className="muted">No open bills fit your rules yet.</p>}
            {open(feed.cards).map((card) => <MatchCard key={card.billId} card={card} windowMinutes={windowMinutes} shortened={state.demoShortenedWindow} matchMode={state.modes.matchMode} busy={busy} onHold={hold} />)}
            {feed.skipped.length > 0 && <p className="tiny warn">{feed.skipped.length} skipped: {feed.skipped.map((s) => `${s.invoiceNumber} (${s.reason})`).join(', ')}</p>}
          </div>
        )}
      </section>

      <PatronHolds state={state} onChanged={onChanged} onPay={onPay} />
      </div>
      <aside className="aside">
        <PatronRules state={state} onChanged={onChanged} />
      </aside>
      </div>
    </>
  )
}
