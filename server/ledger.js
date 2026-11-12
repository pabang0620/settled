import { HttpError } from './http.js'
import { callBiller } from './billerGateway.js'
import { readLedger } from './integrations/invoicing.js'
import { getBiller } from './registry.js'

export const billerOf = (bill) => {
  const biller = getBiller(bill.billerId)
  if (!biller) throw new HttpError(409, 'This biller is no longer in the registry.', 'biller_missing')
  return biller
}

// Read the biller's ledger through the gateway. A flaky demo bill times out when it is read for a listing.
export async function loadLedger(bill, { listing = false } = {}) {
  if (bill.ledgerFlaky && listing) {
    throw new HttpError(504, 'The biller ledger did not answer in time.', 'ledger_timeout')
  }
  const invoice = await callBiller(billerOf(bill), 'get_invoice', { invoiceId: bill.invoiceId })
  return readLedger(invoice)
}
