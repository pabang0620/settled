// A transcript of one model scene: which calls ran, which tools the model called with what input, what it wrote, and when.
// Only the recording script (scripts/record-runs.js) starts a trace; the app never records in normal use.
let current = null

export function startTrace() {
  current = { startedAt: Date.now(), steps: [] }
}

export function traceStep(step) {
  if (!current) return
  current = { ...current, steps: [...current.steps, { ...step, atMs: Date.now() - current.startedAt }] }
}

export function endTrace() {
  const trace = current
  current = null
  return trace ? { steps: trace.steps, durationMs: Date.now() - trace.startedAt } : null
}
