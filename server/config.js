import 'dotenv/config'

const forceMock = process.env.FORCE_MOCK === '1'
const port = Number(process.env.PORT || 3001)
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')
// LLM_BACKEND=account runs the model through the developer's Claude Code login. It never reads ANTHROPIC_API_KEY.
const llmBackend = !forceMock && process.env.LLM_BACKEND === 'account' ? 'account' : 'api'
const matchMode = process.env.MATCH_MODE === 'capture_after_window' ? 'capture_after_window' : 'hold'
const paypalKeysSet = !forceMock && !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET
export const PRODUCTION_WINDOW_MINUTES = 4320
// Stand-in mode defaults to a 1-minute window so the judge path finishes; the sandbox defaults to production (3 days).
// Single-merchant sandbox demo: Riverside is played by the shared app's own sandbox business account,
// so its invoices, payee captures and voids all belong to one merchant and the full PAID path runs with one REST app.
const selfBillerMerchantId = paypalKeysSet ? process.env.SANDBOX_SELF_BILLER_MERCHANT_ID || '' : ''
const DEFAULT_WINDOW_MINUTES = paypalKeysSet ? PRODUCTION_WINDOW_MINUTES : 1
const envNumber = (name, fallback) => (process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name]))

export const config = {
  port,
  publicUrl,
  llmBackend,
  anthropicKey: forceMock || llmBackend === 'account' ? '' : process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  paypalClientId: forceMock ? '' : process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: forceMock ? '' : process.env.PAYPAL_CLIENT_SECRET || '',
  // Minutes between the holder's capture and the earliest match capture (production: 3 days).
  holderSettleMinutes: envNumber('HOLDER_SETTLE_MINUTES', DEFAULT_WINDOW_MINUTES),
  // How often the in-process settle job runs (captures holds whose window is over).
  settleJobSeconds: envNumber('SETTLE_JOB_SECONDS', paypalKeysSet ? 30 : 5),
  // hold = AUTHORIZE now, capture after the window (needs the biller's own app credentials to release).
  // capture_after_window = the card appears only after the window, then one CAPTURE order (nothing to release).
  matchMode,
  seedDailyLimit: Number(process.env.SEED_DAILY_LIMIT || 50),
  billerPasscode: process.env.BILLER_PASSCODE || 'demo-biller',
  opsKey: process.env.OPS_KEY || '',
  // 1 = every patron sees every holder's bill (an open marketplace). 0 = sample bills are only visible to the session that created them.
  publicFeed: process.env.PUBLIC_FEED === '1',
  // Sandbox credentials of each demo biller. The Agent Toolkit calls run as the biller.
  billerCredentials: {
    riverside: selfBillerMerchantId
      ? { clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET }
      : { clientId: process.env.RIVERSIDE_CLIENT_ID || '', clientSecret: process.env.RIVERSIDE_CLIENT_SECRET || '' },
  },
  selfBillerMerchantId,
}

export const modes = {
  llm: config.anthropicKey || llmBackend === 'account' ? 'live' : 'mock',
  paypal: config.paypalClientId && config.paypalClientSecret ? 'sandbox' : 'mock',
  // self = Riverside is the shared app's own sandbox business account (single-merchant demo).
  biller: config.selfBillerMerchantId ? 'self' : 'own_app',
}

// The label the UI and the sources lines show, so a run is never mislabelled.
export const llmLabel = () => {
  if (modes.llm !== 'live') return 'stand-in'
  return config.llmBackend === 'account' ? 'Claude Sonnet (local account)' : 'Claude (API key)'
}

export const DEMO_SHORTENED_WINDOW = config.holderSettleMinutes < PRODUCTION_WINDOW_MINUTES

// Problems worth saying out loud at startup. Pure so a test can feed it any setup.
export function configWarnings(c = config, m = modes) {
  const warnings = []
  const urlPort = Number(new URL(c.publicUrl).port || (c.publicUrl.startsWith('https') ? 443 : 80))
  if (urlPort !== c.port) warnings.push(`PUBLIC_URL (${c.publicUrl}) does not use PORT ${c.port}. PayPal return links go to PUBLIC_URL.`)
  const biller = c.billerCredentials.riverside
  if (m.paypal === 'sandbox' && c.matchMode === 'hold' && !(biller.clientId && biller.clientSecret)) {
    warnings.push('MATCH_MODE=hold needs the biller\'s own app credentials (RIVERSIDE_CLIENT_ID/SECRET) to release a hold; the shared app gets 403 on void. Set them, or use MATCH_MODE=capture_after_window.')
  }
  return warnings
}
