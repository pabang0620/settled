// All money is integer cents. Shares are fraction strings such as "1/2".

export function toCents(value) {
  const cents = Math.round(Number(value) * 100)
  if (!Number.isFinite(cents)) throw new Error(`Not a money value: ${value}`)
  return cents
}

export const fromCents = (cents) => (cents / 100).toFixed(2)
export const usd = (cents) => `$${fromCents(cents)}`
export const money = (cents) => ({ currency_code: 'USD', value: fromCents(cents) })

export function parseShare(share) {
  const match = /^(\d+)\/(\d+)$/.exec(String(share))
  if (!match) throw new Error(`Bad share: ${share}`)
  const [n, d] = [Number(match[1]), Number(match[2])]
  if (!(n > 0 && d > 0 && n < d)) throw new Error(`Share must be between 0 and 1 exclusive: ${share}`)
  return { n, d }
}

export const shareValue = (share) => {
  const { n, d } = parseShare(share)
  return n / d
}

// roundHalfUp(total * n / d) in integer arithmetic. The one rounding function for every split.
export function roundHalfUp(totalCents, share) {
  const { n, d } = parseShare(share)
  return Math.floor((2 * totalCents * n + d) / (2 * d))
}

export const holderPart = (totalCents, share) => roundHalfUp(totalCents, share)
export const matchPart = (totalCents, share) => totalCents - holderPart(totalCents, share)

// The invoice's minimum partial payment uses the same rounding, so holder_part >= minimum always holds.
export const minimumDue = (totalCents, allowedShares) => {
  const smallest = [...allowedShares].sort((a, b) => shareValue(a) - shareValue(b))[0]
  return roundHalfUp(totalCents, smallest)
}
