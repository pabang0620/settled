const COLORS = { model: 'model', server: 'server', paypal: 'paypal', biller: 'paypal', merchant: 'paypal' }

export default function ActivityLog({ items }) {
  if (!items?.length) return <p className="muted">Nothing yet. Every model output, server decision and PayPal call shows up here with its own color.</p>
  return (
    <ul className="activity">
      {[...items].reverse().map((item) => (
        <li key={`${item.at}-${item.tool}-${item.detail}`} className={COLORS[item.source] || 'server'}>
          <span className="tag">{item.source === 'model' ? 'Model output' : item.source === 'paypal' ? 'PayPal call' : 'Server decision'}</span>
          <strong>{item.tool}</strong>
          <span className="muted">{item.detail}</span>
        </li>
      ))}
    </ul>
  )
}
