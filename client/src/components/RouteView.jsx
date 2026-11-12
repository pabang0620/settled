import { usd } from '../api.js'

const ROUTE_TITLE = {
  R1: 'R1 Match on invoice',
  R2: "R2 Pay on PayPal's invoice page",
  R3: 'R3 Decline with a next step',
}

const FINDING_LABEL = {
  unbacked_instruction: 'No payment instruction the ledger does not back',
  biller_in_registry: 'Biller is in the registry',
  invoice_in_ledger: 'Invoice exists in the biller ledger',
  number_match: 'Invoice number matches',
  amount_match: 'Amount matches the ledger',
  due_match: 'Due date matches the ledger',
}

// Left: what the document says (untrusted). Right: what decides the money. Below: the route the server chose.
export default function RouteView({ analysis }) {
  const { document: doc, ledger, payee, decision, findings } = analysis
  const amountBlocked = findings.some((f) => f.code === 'amount_match' && !f.ok)
  return (
    <div className="route-view">
      <div className="two-col">
        <section className="panel untrusted">
          <h4>What the document says</h4>
          <dl>
            <dt>Biller</dt><dd>{doc.billerName}</dd>
            <dt>Invoice</dt><dd>{doc.invoiceNumber}</dd>
            <dt>Amount on paper</dt><dd>{usd(doc.amountCents)}</dd>
            <dt>Due on paper</dt><dd>{doc.dueDate || '-'}</dd>
          </dl>
          {doc.instructions.length > 0 && (
            <div className="instruction">
              <strong>Instruction found:</strong>
              {doc.instructions.map((line) => <p key={line}>"{line}"</p>)}
            </div>
          )}
        </section>
        <section className="panel trusted">
          <h4>What decides the money</h4>
          <dl>
            <dt>Payee</dt><dd>{payee ? `${payee.name} (${payee.source})` : 'none: not in the registry'}</dd>
            <dt>Amount due</dt><dd>{ledger ? `${usd(ledger.dueCents)} (biller ledger)` : 'no ledger invoice'}</dd>
            {amountBlocked && <><dt>Paper amount mismatch</dt><dd className="bad">BLOCKED</dd></>}
            {doc.instructions.length > 0 && <><dt>Instruction</dt><dd className="bad">ignored by server, and the paper is refused because of it</dd><dt>Payee unchanged</dt><dd className="good">{payee ? `${payee.name} (${payee.source})` : 'none'}</dd></>}
          </dl>
          <ul className="findings">
            {findings.map((f) => <li key={f.code} className={f.ok ? 'good' : 'bad'}>{f.ok ? 'Pass' : 'Fail'}: {FINDING_LABEL[f.code]}</li>)}
          </ul>
        </section>
      </div>
      <section className={`route route-${decision.route}`}>
        <div><span className="tag server">Server</span> {ROUTE_TITLE[decision.route]} <span className="muted">({decision.code.replaceAll('_', ' ')})</span></div>
        <div><span className="tag model">Agent</span> {analysis.explanation} <span className="tiny muted">[{analysis.sources.explainer}]</span></div>
        {decision.route === 'R2' && <p className="tiny muted">Pay on PayPal's invoice. The biller's invoice email carries the link; Settled does not build a payment link from the document.</p>}
      </section>
    </div>
  )
}
