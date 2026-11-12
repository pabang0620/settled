import { useCallback, useEffect, useState } from 'react'
import { api, forgetSession, windowWords } from './api.js'
import Home from './components/Home.jsx'
import Holder from './components/Holder.jsx'
import Patron from './components/Patron.jsx'
import Biller from './components/Biller.jsx'
import ActivityLog from './components/ActivityLog.jsx'
import SandboxEvidence from './components/SandboxEvidence.jsx'
import MockCheckout from './components/MockCheckout.jsx'

const TABS = [['home', 'Home'], ['holder', 'I need help'], ['patron', "I'm a patron"], ['biller', "I'm a biller"], ['log', 'Activity']]

export default function App() {
  const [tab, setTab] = useState('home')
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [checkout, setCheckout] = useState(null)

  const refresh = useCallback(async () => {
    try {
      setState(await api('GET', '/state'))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // Finish a PayPal payment: capture for the holder's part, authorize (hold) for the patron's match.
  const finish = useCallback(async ({ role, billId, autoSettle }) => {
    if (role === 'holder') await api('POST', `/bills/${billId}/holder/complete`)
    else {
      await api('POST', `/matches/${billId}/confirm`)
      // A prepared bill whose window has already passed is charged right away; others report "waiting".
      if (autoSettle) await api('POST', `/matches/${billId}/settle`).catch(() => null)
    }
    await refresh()
  }, [refresh])

  // While a hold is waiting for its window, refresh so the settle job's result shows up without a click.
  const waiting = !!state && (state.bills.some((b) => b.match.status === 'held') || state.patron.holds.some((h) => h.status === 'held'))
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [waiting, refresh])

  // Back from PayPal's real approval page: finish the payment named in the return URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const done = async () => {
      if (params.get('paypal') === 'return') {
        setTab(params.get('role') === 'holder' ? 'holder' : 'patron')
        try { await finish({ role: params.get('role'), billId: params.get('bill') }) } catch (err) { setError(err.message) }
      }
      window.history.replaceState({}, '', window.location.pathname)
    }
    refresh().then(done)
  }, [refresh, finish])

  // `info` is display only (biller, invoice, amounts already on screen) for the stand-in checkout.
  async function onPay({ role, billId, order, goto, autoSettle, info }) {
    if (order.approvalUrl && !order.approvalUrl.startsWith('mock:')) {
      window.location.href = order.approvalUrl
      return
    }
    setCheckout({ role, billId, order, goto, autoSettle, info })
  }

  async function closeCheckout(done) {
    const current = checkout
    setCheckout(null)
    if (done && current) {
      try {
        await finish(current)
        if (current.goto) setTab(current.goto)
      } catch (err) {
        setError(err.message)
      }
    }
    await refresh()
  }

  if (!state) return (
    <main className="page">
      {error ? <><p role="alert">Could not load your bill. {error}</p><button onClick={refresh}>Retry loading this session</button></> : <p>Loading...</p>}
    </main>
  )
  const sandboxText = state.modes.biller === 'self' ? "PayPal Sandbox (Riverside played by the app's own sandbox business account)" : 'PayPal Sandbox'
  const mock = state.modes.paypal === 'mock'
  const modeText = mock ? 'PayPal stand-in (no real calls)' : sandboxText

  return (
    <div className="shell">
      <header className="top">
        <div className="top-in">
          <strong className="brand"><img className="brand-logo brand-logo--chip" src="/logo-512.png" width="28" height="28" alt="Settled" />Settled</strong>
          <nav aria-label="Sections">
            {TABS.map(([id, label]) => <button key={id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{label}</button>)}
          </nav>
          <div className="top-right">
            <span className={mock ? 'mode' : 'mode live'}><span className="dot" aria-hidden="true" />{modeText} - {state.modes.llm === 'live' ? state.modes.llmLabel : 'Claude: stand-in, replays recorded Sonnet runs'}{state.demoShortenedWindow ? ` - hold window ${windowWords(state.holdWindowMinutes)} (demo; production 3 days)` : ''}</span>
            <button className="ghost" onClick={() => { forgetSession(); window.location.reload() }}>New session</button>
          </div>
        </div>
      </header>
      <main className="page">
        {error && <p className="error banner">{error}</p>}
        {tab === 'home' && <Home state={state} go={setTab} onChanged={refresh} onPay={onPay} />}
        {tab === 'holder' && <Holder state={state} onChanged={refresh} onPay={onPay} />}
        {tab === 'patron' && <Patron state={state} onChanged={refresh} onPay={onPay} />}
        {tab === 'biller' && <Biller state={state} onChanged={refresh} />}
        {tab === 'log' && (
          <>
            <div className="pagehead"><div><p className="eyebrow">Activity</p><h1>Every model output, server decision and PayPal call</h1></div></div>
            <div className="stack">
              <section className="panel"><h3>Activity</h3><ActivityLog items={state.activity} /></section>
              <SandboxEvidence />
            </div>
          </>
        )}
      </main>
      {checkout && (
        <MockCheckout
          order={checkout.order}
          info={checkout.info}
          role={checkout.role}
          matchMode={state.modes.matchMode}
          windowText={`${windowWords(state.holdWindowMinutes)}${state.demoShortenedWindow ? ', shortened for the demo' : ''}`}
          payee="the biller (registry payee)"
          persona={checkout.role === 'holder' ? 'me' : 'patron'}
          onDone={() => closeCheckout(true)}
          onCancel={() => closeCheckout(false)}
        />
      )}
    </div>
  )
}
