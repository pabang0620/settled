import { dayLabel, timeLabel, usd, windowWords, dueWords } from '../api.js'

// A card is short on purpose: four lines up front, the risks one click away.
export default function MatchCard({ card, index, total, windowMinutes, shortened, matchMode, busy, onHold, onSkip }) {
  const capture = matchMode === 'capture_after_window'
  const days = card.urgency?.kind === 'shutoff' ? card.urgency.days : null
  return (
    <article className="card patron-card">
      <header>
        <span className="label orange">Patron's match</span>
        {total > 1 && <span className="tiny muted"> Card {index + 1} of {total}</span>}
      </header>
      <h4>{card.billerName} - {card.category} - {card.region}</h4>
      <p className="tiny">{card.invoiceNumber} {card.accountMask} - {dueWords(card.dueDate)}{card.urgency?.kind === 'shutoff' && <> - shutoff {dayLabel(card.urgency.date)}{days != null && days >= 0 && <> (in {days} days)</>}</>}</p>
      <p>{usd(card.holderPaidCents)} already paid on this invoice through Settled by the account holder's PayPal login ({card.noRefundsSoFar ? 'no refunds so far' : 'refund recorded'})</p>
      <p><strong>Your match: {usd(card.matchCents)} to {card.billerName}</strong> - closes the bill</p>
      {capture
        ? <p>Their part has stayed paid for the whole window{shortened ? ' (demo: shortened)' : ''}. You are charged when you approve on PayPal; nothing is held.</p>
        : <p>Held now, charged {card.chargeAfter > Date.now() ? <>after <strong>{timeLabel(card.chargeAfter)}</strong></> : 'at the next settle run'} if their part stays paid (window {windowWords(windowMinutes)}{shortened ? ', shortened for the demo; production is 3 days' : ''})</p>}
      <details>
        <summary>What could happen</summary>
        <ul>
          <li>{capture ? 'The card appeared only after their part stayed paid for the whole window. Once you approve, your match is charged and stays with the biller, never a person.' : 'If their part is reversed before the charge, your hold is released. After the charge, your match stays with the biller, never a person.'}</li>
          <li>PayPal can still reverse a payment long after the hold window (up to 180 days for buyer protection claims), which this window does not cover.</li>
          <li>Fee: as a normal PayPal payment to the biller.</li>
          <li>Biller will see: your PayPal name and email.</li>
        </ul>
      </details>
      <div className="row">
        <button className="primary orange" disabled={busy} onClick={() => onHold(card)}>{capture ? 'Match' : 'Hold'} {usd(card.matchCents)} for {card.billerName}</button>
        {onSkip && <button className="ghost" onClick={() => onSkip(card)}>Skip</button>}
      </div>
    </article>
  )
}
