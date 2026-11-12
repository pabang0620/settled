# Settled

**Half & Half: you pay your part of a real bill to the biller through Settled, a stranger matches the rest, and both payments land on the biller's PayPal invoice. The bill is untrusted input: the AI only reads it, and the payee comes from a biller registry and the biller's ledger, never from the document.**

The bill is untrusted. The payee isn't.

Demo only. No real money, no real billers, no real people. Everything below runs on PayPal Sandbox, or on a built-in stand-in when no keys are set.

## What it does

1. A person with a past-due utility bill (the **holder**) uploads the document. Claude reads it and reports what it says, including any "send payment to ..." line. The server compares it with the biller's own invoice (the ledger) and decides one of three paths:
   - **R1 Match on invoice**: the biller is in the registry, the invoice exists, number, amount and due date agree.
   - **R2 Pay on PayPal's invoice page**: the biller only takes payment there, so no matching. The holder is pointed to the invoice link taken from the ledger.
   - **R3 Decline with a next step**: unknown biller, ledger mismatch, a payment instruction in the document (the ledger never names another payee, so the paper is refused because of that instruction, checked first in `server/bills.js`), closed invoice, and so on. The instruction is reported and ignored; it never changes the route, payee or amount.
2. On R1 the holder pays **their own part first** (default 1/2, chosen from the shares the biller allows) with their own PayPal account. The app creates an Orders v2 order whose `payee.merchant_id` is the registry biller. The share is fixed on that invoice the moment the holder presses pay.
3. As soon as that capture is recorded on the biller's invoice, a **match card** appears for patrons whose rules fit (monthly budget, per-bill cap, "holder pays at least X", region, category).
4. A patron approves a card. PayPal **holds** the matching amount (AUTHORIZE order, payee again the registry biller). Nothing is charged yet.
5. The hold is captured only after the holder's part has stayed paid for the whole window (production: 3 days). If the holder reverses, the hold is voided and nothing is charged. When captured, the invoice shows two payments and turns PAID. The holder and patron can then exchange a short thank-you ("We each paid half.") that is screened for contact details and asks.

Money never goes to a person. Amounts are integer cents computed by server code from the ledger. The model never sets an amount, a payee, or a route.

## Run it

```bash
npm install
cp .env.example .env     # leave keys empty for the stand-in mode
npm run build
npm start                # http://localhost:3001
npm test                 # node --test, no network
```

Development: `npm run dev:server` and `npm run dev:client` (Vite on 5173 proxies `/api`).

With no keys the app runs fully on built-in stand-ins whose response shapes follow PayPal's Orders v2, Payments v2 and Invoicing v2 schemas. Nothing leaves your machine. To run on the sandbox, fill the PayPal rows in `.env` (see the table) and follow `VERIFY.md`.

## Judge walk-through (about 3 minutes)

1. Open the app. Press **Watch one bill get settled**. A prepared bill (holder part already paid, window already passed) goes to a patron card. Approve in the checkout dialog and watch it turn into a held, then charged, match.
2. Go to **I need help with a bill**. Choose Riverside Water and **Try a sample bill**. You get a fresh invoice and three documents: Real, Edited amount, Hidden instruction.
3. Upload **Edited amount**: the paper adds $300 to the ledger amount. Route R3, amount mismatch BLOCKED.
4. Upload **Hidden instruction**: number, amount and due date all match the ledger, but the paper says to send money to an email address. The agent reports the line, the server ignores it, the payee stays Riverside Water (registry), and the paper is refused with route R3 `unbacked_instruction`, the only failing check (`server/bills.js:22-62`, test `bills.test.js`).
5. Upload **Real bill**: route R1. Pick a share (the biller allows 1/3, 1/2, 2/3) and **Pay my part**. Approve in the checkout dialog. The ledger now shows PARTIALLY_PAID.
6. Go to **I'm a patron**. Press **Show open bills** (your own bill is offered to you, the stand-in uses a different PayPal account for the patron). Approve the hold. Press **Run the settle job now**. The invoice is PAID with two payments.
7. For the agent branch, use a fresh session (budget $300) and run this before step 6, because matching first lowers the budget. Press **Prepare demo bills**, then **Plan my budget**. In a fresh session the plans are A: 4 bills $256.00, B: 5 bills $278.90. The server computes two allocation options (urgent first versus most bills closed), skips the bill whose ledger times out, and no option is beaten by any other set of bills. Choose one and the cards come out in shutoff order.
8. **I'm a biller** (passcode `demo-biller` by default): turn Sponsorable on or off, set the shutoff date. Urgency is measured only from that date, never from document text.
9. Stand-in only: under a paid holder part, press "simulate my bank pulling my payment back" while a hold is open. The hold is voided and the budget comes back. Releasing a hold uses the biller's own app credentials (verified in the sandbox: authorization 6KH08201LE3777732 VOIDED).

The hold window is shortened for the demo when `HOLDER_SETTLE_MINUTES` is small. The UI says so wherever it shows the window.

## Server rules and where they are tested

| Rule | What it does | Tests |
|---|---|---|
| S1 | Only registered public utilities or verified businesses; individuals rejected | `rules.test.js` |
| S2 | Match must equal the ledger's due amount; no new match after a holder refund | `flow.test.js` |
| S3 | Ledger status table, document versus ledger, injection never reaches payee or amount | `bills.test.js` |
| S4 | One open matched bill per PayPal account, one per biller account per month, same account cannot pay both sides | `flow.test.js` |
| S5 | Story and message screening, redacted views | `flow.test.js`, `api.test.js` |
| S6 | Biller gateway allow-list; sample seeding is the only exception, capped | `rules.test.js` |
| S7 | Per-invoice lock; two patrons, one match; double settle charges once | `flow.test.js` |
| S8 | Budget reserved at order time, restored on void; per-bill cap | `flow.test.js` |
| S10 | self_paid counts only the holder capture the app made and recorded | `flow.test.js` |
| S11 | Shares, rounding, share fixed at pay time, patron floor is a filter | `money.test.js`, `flow.test.js` |
| S12 | Order functions accept registry entries only | `rules.test.js` |
| S13 | Match capture waits for the window; reversal voids the hold or excludes the payer | `flow.test.js` |
| Allocation | No offered option is dominated by any affordable set of bills | `allocation.test.js` |
| Sessions | Other sessions cannot act on a bill or a hold; patron views hide the holder | `flow.test.js`, `api.test.js` |

## Built with the APIMatic Context Plugin

The PayPal APIMatic Context Plugin (v0.4.1, TypeScript skills) guided the live money path. Skills used, in the order the plugin requires: `typescript-integrate-paypal`, `typescript-getting-started`, `typescript-error-handling`, then `typescript-client-initialization`, `typescript-authentication`, `typescript-calling-endpoints`, `typescript-models`, `typescript-configuration-resilience` and `typescript-testing`.

- SDK package: `paypal` (client `PaypalClient`), installed with `npm install git+https://github.com/context-plugins/paypal-typescript-sdk#main` (not on npm; the install builds it).
- Through the SDK (live mode): `orders.createOrder` (the holder's CAPTURE order and the patron's AUTHORIZE order, both addressed with `purchase_units[].payee.merchant_id`), `orders.getOrder`, `orders.captureOrder`, `orders.authorizeOrder`, `payments.captureAuthorizedPayment`, `payments.voidPayment`, `payments.getCapturedPayment`, and `payments.getAuthorizedPayment` (used only to settle a lost answer). Code: `server/integrations/sdkOrders.js` and `server/integrations/paypalSdk.js`; `payeeOrders.js` keeps the same function surface and still serves the built-in stand-in when no sandbox keys are set.
- Every write claims its operation in a record the app owns before it calls PayPal (`server/integrations/claims.js`), sends a deterministic `PayPal-Request-Id`, and settles a lost answer by re-reading instead of reporting a failure.
- Not in the SDK, kept on the PayPal Agent Toolkit: Invoicing (create, send, get, record payment) and the biller's refund (`server/integrations/invoicing.js`).
- Contract sheet: `paypal-plan.md`, written before the code. The SDK adapter has its own tests with a faked `fetch` (`test/sdkOrders.test.js`).

### Sandbox evidence (2026-11-12)

Real PayPal Sandbox calls made through the SDK (and the Agent Toolkit where noted). The same records are in the app under Activity, "Sandbox evidence". Full notes per item are in `VERIFY.md`.

| Check | Call | Result | IDs |
|---|---|---|---|
| S1 | `orders.getOrder`, `payments.getCapturedPayment`, `payments.getAuthorizedPayment` (read-only) | PASS | token and sandbox host reachable, 404 on made-up ids |
| V2 | `orders.createOrder` with `payee.merchant_id` (Riverside), approved as holder, `orders.captureOrder` | PASS | order 1YM58126NG301100N, capture 5V973346CM946373X `COMPLETED`, fee 0.66 on 5.00 paid by the payee |
| V8 | AUTHORIZE order for Riverside, `orders.authorizeOrder`, `payments.captureAuthorizedPayment` | PASS | order 98417086007169356, authorization 3AR14874A6278953U `CREATED`, capture 94T771459L404044W `COMPLETED` (`final_capture`) |
| V8 | `payments.voidPayment` as the biller app | PASS | authorization 6KH08201LE3777732 `VOIDED`, authorization 0ET240840K915803T `VOIDED` |
| V8 | `payments.voidPayment` with the shared app | blocked | authorization 9HV98331813657537: 403 `PERMISSION_DENIED`, so release needs the biller's own app |
| V4 | Agent Toolkit `create_refund` as Riverside, then `payments.getCapturedPayment` | PASS | refund 07J41073AN345254V `COMPLETED`, capture 70N07908P40881933 reads `REFUNDED` |
| V10a | `orders.createOrder` twice with the same `PayPal-Request-Id` | PASS | order 7CL75003489574914 both times |
| V3 | `record_payment_for_invoice` as Riverside | blocked | the Riverside app lacks the Invoicing feature (403); the invoice record is verified in the stand-in only |

Two real defects the live run exposed, both fixed in the adapter and covered by tests:

1. `payments.voidPayment` answers 204 with no body, and the SDK throws a `DecodeError` on that success. The adapter sends `Prefer: return=representation` and, if the body still cannot be read, settles by reading the authorization (`VOIDED`).
2. The Agent Toolkit reports a failed call as `{ok:false,status,message}` instead of `{error}`, so a 404 on `record_payment_for_invoice` was treated as success. `liveCall` in `server/integrations/invoicing.js` now throws on `ok:false`.

## What the AI does

- Reads the bill document (Claude in live mode, a text parser in the stand-in; the UI header and every sources line name which one ran) and reports fields and payment instructions.
- Explains the route the server chose, in plain words, and what the person should do next.
- Describes the allocation options the server computed; drafts giving rules from a sentence (the patron saves them); second-pass screening of free text.
- It never decides a route, an amount, a payee, or moves money. Every money step is a server function behind a person's approval on PayPal.

## Environment variables

| Name | Purpose | Default |
|---|---|---|
| `PORT`, `PUBLIC_URL` | Server port and public base URL (used for PayPal return URLs). The server warns at startup if they disagree | 3001, `http://localhost:PORT` |
| `FORCE_MOCK` | `1` ignores all keys and stays on stand-ins | `0` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Live Claude reader and explanations through the hosted API; empty = stand-in agent | empty, `claude-sonnet-5-5` |
| `LLM_BACKEND` | `account` runs the model through your local Claude Code login (Claude Agent SDK, local development only, never reads `ANTHROPIC_API_KEY`). The UI labels it "Claude Sonnet (local account)". `FORCE_MOCK=1` turns it off | empty |
| `MATCH_MODE` | `hold` = AUTHORIZE now, capture after the window. `capture_after_window` = the card appears only after the window and one CAPTURE order is made (use when the biller's own app credentials are not available) | `hold` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials for payee orders through the SDK (both required for sandbox mode) | empty |
| `PAYPAL_SDK_LOG` | `1` writes one-line PayPal SDK diagnostics (status, reason, debug id; never request bodies) to stderr | empty |
| `RIVERSIDE_MERCHANT_ID`, `CEDAR_MERCHANT_ID` | Sandbox business merchant ids of the demo billers (the registry payee) | stand-in ids |
| `RIVERSIDE_CLIENT_ID`, `RIVERSIDE_CLIENT_SECRET` | Biller-side sandbox credentials for the Agent Toolkit invoicing calls | empty |
| `HOLDER_SETTLE_MINUTES` | Window between the holder's capture and the earliest match capture | `4320` (3 days) |
| `SEED_DAILY_LIMIT` | Sample invoices per day (sandbox protection) | `50` |
| `BILLER_PASSCODE` | Demo passcode for the biller console | `demo-biller` |
| `OPS_KEY` | Header `x-ops-key` for `POST /api/ops/settle` | empty (endpoint disabled) |
| `PUBLIC_FEED` | `1` shows every holder's bill to every patron; `0` keeps sample bills private to their session | `0` |

## Limits, stated plainly

- Recording on the biller's invoice needs the biller app's Invoicing feature. In our sandbox run the holder capture landed in the biller's account (capture 5V973346CM946373X); the invoice record step and the PAID state are verified in the stand-in only.
- Releasing a hold uses the biller's own app credentials. The shared app can authorize and capture for a payee but gets 403 on void. Without those credentials the server warns at startup, and `MATCH_MODE=capture_after_window` avoids holds altogether.
- The R2 screen does not open a payment link: the invoice returned by the sandbox has no pay-page link, so it says to pay on PayPal's invoice (the link is in the invoice email).
- Invoices made through the Agent Toolkit carry no due date; the shutoff date set by the biller is what measures urgency.
- `npm test` runs on the stand-ins only (it forces mock mode). The real-model and sandbox runs are in `VERIFY.md`; the real-model run used a local Claude account, not the hosted API.
- The stand-in and the sandbox billers are ours. No real utility is connected; a real biller would need to be onboarded with PayPal.
- Matching is a selection and commitment device, not fraud proofing. It confirms that this invoice has a completed payment made through Settled by the holder's PayPal login. It cannot tell whose wallet funded it or whether it is later disputed. PayPal buyer protection claims can arrive up to 180 days after a payment; a 3-day window does not cover that, and the card says so.
- Payment disputes on the patron side are the biller's to handle as a merchant.
- In-memory state: restarting the server resets all sessions.
- Sample documents are rendered text, not PDFs. The live reader gets that text inside an untrusted-data wrapper.
- We did not find another service that lets a holder and an unrelated patron split one biller invoice. That is a search result, not a claim.

## License

MIT. See `LICENSE`.
