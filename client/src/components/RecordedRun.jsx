// Replay of a real model run (Claude Sonnet through a local Claude Code account), shown in stand-in mode.
// Every step is what the model did on that run: the tools it called, with what input, what it wrote, and when.
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

function StepLine({ step }) {
  if (step.type === 'model_call') return <li className="tiny muted">{seconds(step.atMs)} model call ({step.mode.replace('_', ' ')}{step.tools.length ? `, tools: ${step.tools.join(', ')}` : ''})</li>
  if (step.type === 'tool_call') {
    return (
      <li>
        <span className="tiny muted">{seconds(step.atMs)}</span> <code>{step.name}</code>
        {step.input && Object.keys(step.input).length > 0 && <pre className="tiny">{JSON.stringify(step.input, null, 1)}</pre>}
      </li>
    )
  }
  return <li><span className="tiny muted">{seconds(step.atMs)}</span> wrote: "{step.text}"</li>
}

export default function RecordedRun({ run }) {
  if (!run) return null
  const calls = run.steps.filter((s) => s.type === 'tool_call').length
  return (
    <details className="recorded-run">
      <summary>{run.label}: what the model did ({calls} tool call{calls === 1 ? '' : 's'}, {seconds(run.durationMs)})</summary>
      <p className="tiny muted">Model {run.model} through {run.backend}. Replayed because no model is configured. {run.note} Server checks, route, payee and amounts are computed now, not replayed.</p>
      <ol className="steps-log">{run.steps.map((step) => <StepLine key={`${step.atMs}-${step.type}-${step.name || ''}`} step={step} />)}</ol>
    </details>
  )
}
