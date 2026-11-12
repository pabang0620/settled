import evidence from '../sandboxEvidence.json'

const BADGE = { pass: 'Sandbox PASS', blocked: 'Blocked' }

// Static record of what the real sandbox returned. It is the same in stand-in mode and does not call PayPal.
export default function SandboxEvidence() {
  return (
    <section className="panel sandbox-evidence">
      <h3>Sandbox evidence ({evidence.date})</h3>
      <p className="tiny muted">{evidence.note}</p>
      <ul className="activity">
        {evidence.items.map((item) => (
          <li key={`${item.check}-${item.what}`} className={item.status === 'pass' ? 'paypal' : 'server'}>
            <span className="tag">{BADGE[item.status]}</span>
            <strong>{item.check}</strong> {item.what}
            <div className="tiny muted">{item.ids.join(' | ')}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
