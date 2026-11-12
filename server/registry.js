import { HttpError } from './http.js'
import { parseShare } from './money.js'

// The biller registry: the only source of where money may go (S1, S12).
export const ENTITY_TYPES = ['public_utility', 'business_verified']
export const PAYMENT_MODES = ['payee_order', 'invoice_page']
export const APP_DEFAULT_SHARE = '1/2'

const entries = new Map()
const registered = new WeakSet()

const REQUIRED_APPROVALS = ['paypalBusinessAccount', 'issuesPayPalInvoices', 'operatorApproved', 'creditPledge']

// S1: only organisations that pass every criterion enter the registry. Individuals never do.
export function validateBillerEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new HttpError(400, 'Biller entry is missing.', 'biller_invalid')
  if (!ENTITY_TYPES.includes(entry.entityType)) throw new HttpError(400, `Biller type "${entry.entityType}" is not accepted. Only public utilities and verified businesses can be registered.`, 'biller_entity')
  for (const key of REQUIRED_APPROVALS) {
    if (entry[key] !== true) throw new HttpError(400, `Biller does not meet the registry criterion: ${key}.`, 'biller_criteria')
  }
  if (!entry.merchantId || typeof entry.merchantId !== 'string') throw new HttpError(400, 'Biller needs a PayPal merchant id.', 'biller_merchant')
  if (!Array.isArray(entry.paymentModes) || !entry.paymentModes.length || entry.paymentModes.some((m) => !PAYMENT_MODES.includes(m))) {
    throw new HttpError(400, 'Biller payment modes are invalid.', 'biller_modes')
  }
  const allowed = entry.allowedShares ?? [APP_DEFAULT_SHARE]
  allowed.forEach(parseShare)
  const holderShare = entry.holderShare ?? APP_DEFAULT_SHARE
  parseShare(holderShare)
  if (!allowed.includes(holderShare)) throw new HttpError(400, 'The default share must be one of the allowed shares.', 'biller_share')
  if (entry.entityType === 'business_verified' && !entry.businessVerifiedBy) throw new HttpError(400, 'business_verified needs an operator who checked the documents.', 'biller_verified')
}

export function registerBiller(entry) {
  validateBillerEntry(entry)
  const normalized = Object.freeze({
    ...entry,
    holderShare: entry.holderShare ?? APP_DEFAULT_SHARE,
    allowedShares: Object.freeze([...(entry.allowedShares ?? [APP_DEFAULT_SHARE])]),
    paymentModes: Object.freeze([...entry.paymentModes]),
  })
  entries.set(normalized.id, normalized)
  registered.add(normalized)
  return normalized
}

export const listBillers = () => [...entries.values()]
export const getBiller = (id) => entries.get(id) || null
export const findBillerByName = (name) => {
  const wanted = String(name || '').toLowerCase().replace(/[^a-z]/g, '')
  return listBillers().find((b) => wanted.startsWith(b.name.toLowerCase().replace(/[^a-z]/g, ''))) || null
}

// S12: money functions take a registry entry object, never an email or a free merchant id.
export function assertRegistryEntry(biller) {
  if (!biller || !registered.has(biller) || entries.get(biller.id) !== biller) {
    throw new HttpError(403, 'Payee must be a registered biller.', 'payee_not_registered')
  }
  return biller
}

export function clearRegistryForTests() {
  entries.clear()
}

const demo = {
  entityType: 'public_utility',
  paypalBusinessAccount: true,
  issuesPayPalInvoices: true,
  operatorApproved: true,
  creditPledge: true,
  holderShare: '1/2',
  allowedShares: ['1/3', '1/2', '2/3'],
  region: 'OH',
  category: 'utilities',
}

export function loadDemoRegistry(env = process.env) {
  entries.clear()
  registerBiller({ ...demo, id: 'riverside', name: 'Riverside Water', merchantId: env.RIVERSIDE_MERCHANT_ID || 'RIVERSIDE0WATER', paymentModes: ['payee_order'] })
  registerBiller({ ...demo, id: 'cedar', name: 'Cedar Electric', merchantId: env.CEDAR_MERCHANT_ID || 'CEDAR0ELECTRIC', paymentModes: ['invoice_page'] })
}

loadDemoRegistry()
