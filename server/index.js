import { config, configWarnings, llmLabel, modes } from './config.js'
import { createApp } from './app.js'
import { settleDue } from './matching.js'

const log = (line) => process.stderr.write(`[settled ${new Date().toISOString()}] ${line}\n`)

// Nothing below may end the process silently. Unexpected errors are logged and the server keeps serving.
process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack || err}`))
process.on('unhandledRejection', (reason) => log(`unhandledRejection: ${reason?.stack || reason}`))
// A closed terminal or shell group sends SIGHUP; ignore it instead of dying unannounced. SIGINT and SIGTERM still stop the server, with a line.
process.on('SIGHUP', () => log('SIGHUP ignored (terminal closed); still serving'))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`)
    process.exit(0)
  })
}
process.on('exit', (code) => log(`process exit, code ${code}`))

// The settle job: capture holds whose window is over, void the reversed ones.
const SETTLE_INTERVAL_MS = 30000
setInterval(() => {
  settleDue().catch((err) => log(`settle job failed: ${err?.message || err}`))
}, SETTLE_INTERVAL_MS).unref()

const server = createApp().listen(config.port, (err) => {
  // Express 5 also calls this with the listen error; the 'error' handler below reports it.
  if (err) return
  process.stdout.write(`Settled on ${config.publicUrl} (PayPal=${modes.paypal}, Claude=${llmLabel()}, hold window=${config.holderSettleMinutes} min, match mode=${config.matchMode})\n`)
  for (const warning of configWarnings()) log(`WARNING ${warning}`)
})
server.on('error', (err) => {
  log(`listen failed: ${err.code || ''} ${err.message}`)
  process.exitCode = 1
})
