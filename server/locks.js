const tails = new Map()

// Serialize every money move on one key (an invoice). Later callers wait for earlier ones.
export function withLock(key, fn) {
  const previous = tails.get(key) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  tails.set(key, tail)
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
  return run
}
