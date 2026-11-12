import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { modes } from '../config.js'

// Transcripts of real model runs (Claude Sonnet through the local Claude Code account), written by scripts/record-runs.js.
// With no model configured, a scene whose input is exactly the recorded input replays the recording, labelled as such.
// Anything else falls back to the stand-in. Nothing here is ever labelled as a live model.
export const RUNS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../recorded-runs')

function loadRuns() {
  if (!existsSync(RUNS_DIR)) return new Map()
  const entries = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(RUNS_DIR, f), 'utf8')))
  return new Map(entries.map((run) => [run.scene, run]))
}

let runs = loadRuns()
export const reloadRuns = () => { runs = loadRuns() }

export const recordingLabel = (run) => `Recorded run: Claude Sonnet, ${run.recordedAt}`

// The recording for a scene, only when no live model is configured and the input matches what was recorded.
export function replayable(scene, matches) {
  if (modes.llm === 'live') return null
  const run = runs.get(scene)
  return run && matches(run) ? run : null
}

export const transcriptOf = (run, note) => ({
  note,
  label: recordingLabel(run),
  model: run.model,
  backend: run.backend,
  recordedAt: run.recordedAt,
  durationMs: run.durationMs,
  steps: run.steps,
})
