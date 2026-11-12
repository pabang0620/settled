import { HttpError } from './http.js'
import { now } from './clock.js'
import { aliasOf, getBill } from './store.js'
import { DEFAULT_THANKS, screenText } from './screen.js'

// After a bill is PAID the holder and the matching patron can exchange short thanks. Nothing else.
export function postMessage(session, billId, text) {
  const bill = getBill(billId)
  if (!bill) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  const role = bill.sessionId === session.id ? 'holder' : bill.match.patronSessionId === session.id ? 'patron' : null
  if (!role) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  if (!bill.closed || bill.match.status !== 'captured') throw new HttpError(409, 'Messages open after the bill is paid.', 'not_paid_yet')
  const checked = screenText(text || DEFAULT_THANKS)
  if (!checked.ok) throw new HttpError(422, `Message blocked: ${checked.blocked.join(', ').replaceAll('_', ' ')}.`, 'message_blocked')
  bill.messages = [...(bill.messages || []), { at: now(), from: role, text: checked.text }]
  return messagesFor(session, bill)
}

export function messagesFor(session, bill) {
  const mine = bill.sessionId === session.id ? 'holder' : 'patron'
  return (bill.messages || []).map((m) => ({
    at: m.at,
    mine: m.from === mine,
    from: m.from === mine ? 'You' : m.from === 'holder' ? aliasOf(bill.holder.payerId, 'Holder') : aliasOf(bill.match.patronSessionId, 'Patron'),
    text: m.text,
  }))
}

export function setStory(session, billId, text) {
  const bill = getBill(billId)
  if (!bill || bill.sessionId !== session.id) throw new HttpError(404, 'Bill not found.', 'bill_not_found')
  const checked = screenText(text)
  if (!checked.ok) throw new HttpError(422, `Story blocked: ${checked.blocked.join(', ').replaceAll('_', ' ')}.`, 'story_blocked')
  bill.story = checked.text
  return { story: bill.story, verified: false }
}
