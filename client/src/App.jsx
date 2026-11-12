import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
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

  async function onPay({ role, billId, order, goto, autoSettle }) {
    if (order.approvalUrl && !order.approvalUrl.startsWith('mock:')) {
      window.location.href = order.approvalUrl
      return
    }
    setCheckout({ role, billId, order, goto, autoSettle })
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

  if (!state) return <main className="app"><p>{error || 'Loading...'}</p></main>
  const modeText = state.modes.paypal === 'mock' ? 'PayPal stand-in (no real calls)' : 'PayPal Sandbox'

  return (
    <main className="app">
      <header className="topbar">
        <strong className="brand">Settled</strong>
        <nav aria-label="Sections">
          {TABS.map(([id, label]) => <button key={id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        <span className="mode">{modeText} - {state.modes.llmLabel}{state.demoShortenedWindow ? ' - hold window shortened for demo' : ''}</span>
      </header>
      {error && <p className="error banner">{error}</p>}
      {tab === 'home' && <Home state={state} go={setTab} onChanged={refresh} onPay={onPay} />}
      {tab === 'holder' && <Holder state={state} onChanged={refresh} onPay={onPay} />}
      {tab === 'patron' && <Patron state={state} onChanged={refresh} onPay={onPay} />}
      {tab === 'biller' && <Biller state={state} onChanged={refresh} />}
      {tab === 'log' && (
        <>
          <section className="panel"><h3>Activity</h3><ActivityLog items={state.activity} /></section>
          <SandboxEvidence />
        </>
      )}
      {checkout && (
        <MockCheckout
          order={checkout.order}
          payee="the biller (registry payee)"
          persona={checkout.role === 'holder' ? 'me' : 'patron'}
          onDone={() => closeCheckout(true)}
          onCancel={() => closeCheckout(false)}
        />
      )}
    </main>
  )
}
