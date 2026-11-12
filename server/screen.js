// Free text (the holder's story, thank-you messages) never carries contact details, payment handles or asks.
const RULES = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.]+/i],
  ['link', /https?:\/\/|www\./i],
  ['phone', /(?:\+?\d[\s().-]?){7,}/],
  ['payment_handle', /\$[a-z][\w]{2,}|\b(cash ?app|venmo|zelle|paypal\.me|bitcoin|btc)\b/i],
  ['account_number', /\b\d{6,}\b/],
  ['extra_request', /\b(send me|dm me|text me|call me|can you also|please also send|wire)\b/i],
  ['real_name', /\bmy (full |real )?name is\b/i],
]

export function screenText(text) {
  const value = String(text ?? '').trim()
  if (!value) return { ok: false, blocked: ['empty'], text: value }
  if (value.length > 400) return { ok: false, blocked: ['too_long'], text: value }
  const blocked = RULES.filter(([, re]) => re.test(value)).map(([code]) => code)
  return { ok: blocked.length === 0, blocked, text: value }
}

export const DEFAULT_THANKS = 'We each paid half. Thank you.'
