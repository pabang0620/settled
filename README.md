<img src="client/public/logo-512.png" width="128" alt="logo" />

# Settled

**Try it:** https://settled.35-216-2-121.sslip.io (hosted demo: PayPal stand-in, recorded Claude Sonnet runs, 1-minute hold window; no login).

**Half & Half: you pay your part of a real bill to the biller through Settled, a stranger matches the rest, and both payments go to the biller and are recorded on its PayPal invoice (run end to end in the PayPal Sandbox with Riverside as its own PayPal app; see Sandbox evidence). The bill is untrusted input: the AI only reads it, and the payee comes from a biller registry and the biller's ledger, never from the document.**

The bill is untrusted. The payee isn't.

Demo only. No real money, no real billers, no real people. Everything below runs on PayPal Sandbox, or on a built-in stand-in when no keys are set.

Unlike Austin Energy's gift payments ([source](https://austinenergy.com/about/news/news-releases/2024/give-the-gift-of-comfort-help-someone-in-need)) and Istanbul's Askıda Fatura ([source](https://www.birgun.net/haber/askida-fatura-projesi-kac-haneye-destek-saglandigi-aciklandi-661887)), which run through the biller's own desk, Settled lets an unrelated person match half of a bill only while the holder's part is still open, and the ledger, not the photo, decides where the money goes.

## What it does

1. A person with a past-due utility bill (the **holder**) uploads the document. Claude reads it and reports what it says, including any "send payment to ..." line. The server compares it with the biller's own invoice (the ledger) and decides one of three paths:
   - **R1 Match on invoice**: the biller is in the registry, the invoice exists, number, amount and due date agree.
   - **R2 Pay on PayPal's invoice page**: the biller only takes payment there, so no matching. The holder is pointed to the invoice link taken from the ledger.
   - **R3 Decline with a next step**: unknown biller, ledger mismatch, a payment instruction in the document, closed invoice, and so on. A payment instruction is never followed: it cannot set the payee or the amount. Its only effect is that the server refuses the paper (the ledger never names another payee; checked first in `server/bills.js`).
2. On R1 the holder pays **their own part first** (default 1/2, chosen from the shares the biller allows) with their own PayPal account. The app creates an Orders v2 order whose `payee.merchant_id` is the registry biller. The share is fixed on that invoice the moment the holder presses pay.
3. As soon as that capture is recorded on the biller's invoice, a **match card** appears for patrons whose rules fit (monthly budget, per-bill cap, "holder pays at least X", region, category).
4. A patron approves a card. PayPal **holds** the matching amount (AUTHORIZE order, payee again the registry biller). Nothing is charged yet.
5. The hold is captured only after the holder's part has stayed paid for the whole window (production: 3 days; the stand-in demo uses 1 minute, and every screen shows the time it waits until). If the holder reverses, the hold is voided and nothing is charged. When captured, the invoice shows two payments and turns PAID. The holder and patron can then exchange a short thank-you ("We each paid half.") that is screened for contact details and asks.

Money never goes to a person. Amounts are integer cents computed by server code from the ledger. The model never sets an amount, a payee, or a route.

## Run it

```bash
npm install
cp .env.example .env     # leave keys empty for the stand-in mode
npm run build
npm start                # http://localhost:3001
npm test                 # node --test, no network
```

`npm run demo:video` builds and starts the exact recording state: stand-in PayPal, recorded Claude runs, a 1-minute hold window and a settle job every 5 seconds, whatever your `.env` says.

Development: `npm run dev:server` and `npm run dev:client` (Vite on 5173 proxies `/api`).

### Repository description

Settled: pay your part of a past-due utility bill straight to the biller, a stranger matches the rest, and the match is charged only after your part stays paid for the hold window. The payee comes from a biller registry, never from the document.

With no keys the app runs fully on built-in stand-ins whose response shapes follow PayPal's Orders v2, Payments v2 and Invoicing v2 schemas. Nothing leaves your machine. To run on the sandbox, fill the PayPal rows in `.env` (see the table) and follow `VERIFY.md`.

### Sandbox demo mode

With sandbox keys in `.env` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` for the payee orders, `RIVERSIDE_MERCHANT_ID`, `RIVERSIDE_CLIENT_ID`, `RIVERSIDE_CLIENT_SECRET` for Riverside's own app with the Invoicing feature), `npm run demo:sandbox` runs the real PayPal flow with a 1-minute window and an open feed: Riverside's app creates, sends and records the invoice and releases holds, the shared app creates the payee orders. The header says "PayPal Sandbox". `node scripts/biller-scope.js` checks that Riverside's app token has the Invoicing scope. Use two different sandbox personal accounts for the holder and the patron, in two browser sessions. With only one REST app, set `SANDBOX_SELF_BILLER_MERCHANT_ID` to the merchant id of the business account behind it: Riverside is then played by that account and the header says "PayPal Sandbox (Riverside played by the app's own sandbox business account)". Without keys it stays on the stand-in.

## Judge walk-through (about 4 minutes, one minute of it waiting)

Start with the defaults (`cp .env.example .env`, keys empty). The header must say "PayPal stand-in" and "hold window 1 minute". The same nine steps are in `DEVPOST.md` and `docs/VIDEO_SCRIPT.md`.

1. **Watch one bill get settled** (Home). A prepared bill whose holder part already stayed paid for the window goes to a patron card. Approve in the checkout dialog. Under "Your matches" it reads "Charged and recorded on the invoice".
2. **Try a sample bill**: go to **I need help**, keep Riverside Water, press **Try a sample bill**. You get invoice INV-4821 ($82.40) and three documents: Real bill, Edited amount, Hidden instruction.
3. **Edited amount**: press **Upload this document** under it. The paper says $382.40; route R3, "Paper amount mismatch BLOCKED".
4. **Hidden instruction**: number, amount and due date all match the ledger, but the paper says to send money to an email address. Left: the instruction. Right: "ignored by server, and the paper is refused because of it", "Payee unchanged: Riverside Water (registry)". Route R3 `unbacked_instruction`, the only failing check (`server/bills.js`, test `bills.test.js`). Open **Recorded run: Claude Sonnet** under it to see the real model's tool call: it reported the line and did not follow it.
5. **Real bill, Pay my part**: route R1. Pick a share (the biller allows 1/3, 1/2, 2/3), press **Pay my part with PayPal to Riverside Water**, approve. The ledger status reads PARTIALLY_PAID.
6. **Hold and settle**: go to **I'm a patron**, press **Show open bills** (your own bill is offered to you; the stand-in uses a different PayPal account for the patron), press **Hold**, approve. The match reads "Held, not charged" and "Charged after HH:MM:SS". **Run the settle job now** before then answers "Not charged yet ... until HH:MM:SS". About a minute later the settle job charges it on its own and the screen updates: "Charged and recorded on the invoice". Under **I need help** the bill reads PAID with your part and the patron's match.
7. **Plan my budget**: press **New session** (top right) for a fresh $300 budget, go to **I'm a patron**, press **Prepare demo bills**, then **Plan my budget**. Plan A: 4 bills, $256.00. Plan B: 5 bills, $278.90. INV-1219 is skipped (ledger timeout). The server computes the options; no option is beaten by another set of these bills. Open **Recorded run: Claude Sonnet** to see the model's own steps: `list_open_bills`, `get_bill_detail` for the bills it chose to check, `draft_allocations`. Choose A and hold a card: prepared bills already passed their window, so it is charged at the next settle run (within 5 seconds).
8. **I'm a biller**: press **Log in** (passcode `demo-biller`, filled in). Turn Sponsorable on or off, set the shutoff date. Urgency is measured only from that date, never from document text.
9. **Activity**: the "Sandbox evidence" panel lists the real PayPal Sandbox results with their ids (the table below).

Optional, stand-in only: under a paid holder part with a hold still open, press "simulate my bank pulling my payment back". The hold is voided and the budget comes back. The link disappears once the bill is PAID.

The window and the settle interval are `HOLDER_SETTLE_MINUTES` and `SETTLE_JOB_SECONDS`. Empty means 1 minute and 5 seconds on the stand-in, and 3 days (4320 minutes) and 30 seconds with sandbox keys.

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
| V10b | `payments.voidPayment` as the biller app, empty 204 answer | PASS | authorization 0ET240840K915803T: 204, settled by reading it back `VOIDED` |
| X1 | `claude plugin list` and the SDK money path above | PASS | `paypal@context-plugins` 0.4.1; captures 5V973346CM946373X, 94T771459L404044W through the APIMatic `paypal` SDK |
| In-app PAID path | The app itself in sandbox mode (`npm run demo:sandbox`), biller = the app's own sandbox business account RLMTMHVTY3E42. Holder pressed Pay my part and approved on PayPal; a patron in another browser session pressed Hold and approved; the settle job captured after the window | PASS | invoice INV2-46D3-DRWW-CZ9Z-EUK3 (INV-5805, $120.00): holder order 918156118R290951V, capture 1XA83390EB780180D $60.00; patron order 6XA11803904094326 (AUTHORIZE), authorization 1J127616CJ147762H `CAPTURED`, capture 8W5514277L700964E $60.00; invoice `MARKED_AS_PAID`, due 0.00, both captures on the ledger |
| V3, V7 | Agent Toolkit `record_payment_for_invoice` from the app | PASS (with a finding) | PayPal answers 404 to any `payment_id`, even a capture on the invoicer's own account, and stores every recorded payment as type `EXTERNAL`, method `PAYPAL`, with its own id (EXTR-5E570351PF431291C, EXTR-4JN06872M7730020Y). Two recorded payments that cover the total make the invoice `MARKED_AS_PAID`, not `PAID`. The app now writes the capture id into the entry's `note` and reads it back from there |
| In-app release | Same setup, patron pressed Release while held | PASS | holder capture 0XL33347CL743351W recorded (invoice INV2-DQHK-Q9KY-WMA7-DN57 `PARTIALLY_PAID`), patron order 3FV78050YJ414083M, authorization 38C66344V0654964E `VOIDED`, nothing charged |
| In-app PAID path, Riverside's own app | The app in sandbox mode with the biller as a separate PayPal app (`npm run demo:sandbox`, `SANDBOX_SELF_BILLER_MERCHANT_ID` empty): Riverside's app creates, sends, records (Agent Toolkit) and voids; payee orders go to merchant H5YUF48MJXAB4 | PASS | invoice INV2-4YWC-MUX7-VLW6-C72C (INV-8331, $101.50): holder order 10159141AW160921D, capture 3WV48562595474619 $50.75 (EXTR-6XX9123548695464G); patron order 78A10805VE078452V, authorization 17N15873N1547330G `CAPTURED`, capture 0P907595PC6764107 $50.75 (EXTR-70C48691VV349323B); invoice `MARKED_AS_PAID`, due 0.00 |
| In-app release, Riverside's own app | Patron pressed Release while held | PASS | invoice INV2-6SNZ-CYYH-WT24-JBD4 `PARTIALLY_PAID` (holder capture 6NY33787GX085131R), authorization 3EV077502S8023244 `VOIDED` |
| In-app refund, Riverside's own app | Toolkit `create_refund` as Riverside on the holder capture, then the settle job | PASS | refund 8C439254B28295732, capture 1WS70995FV7840845 `REFUNDED`, hold authorization 1LJ682639S486245A `VOIDED` (`holder_reversed`), nothing charged |

Three real defects the live runs exposed, all fixed and covered by tests:

1. `payments.voidPayment` answers 204 with no body, and the SDK throws a `DecodeError` on that success. The adapter sends `Prefer: return=representation` and, if the body still cannot be read, settles by reading the authorization (`VOIDED`).
2. The Agent Toolkit reports a failed call as `{ok:false,status,message}` instead of `{error}`, so a 404 on `record_payment_for_invoice` was treated as success. `liveCall` in `server/integrations/invoicing.js` now throws on `ok:false`.
3. Invoicing `record-payment` does not accept a capture id as `payment_id` (404) and keeps every entry as `EXTERNAL`, so a ledger check keyed on `payment_id` could never see the app's own payment. The app records `note: "Settled capture <id>"`, reads the capture from the note (`captureRefOf`), and skips recording when that note is already on the ledger, so a retry after a lost answer cannot record twice (`test/ledgerNote.test.js`). A failed recording is now logged to stderr instead of being silent.

## What the AI does

- Reads the bill document with one structured tool call (`report_bill_fields`) and reports fields and payment instructions. It is told the document is untrusted data.
- Explains the route the server chose, in plain words, and what the person should do next.
- Plans with the patron in a tool loop and chooses its own steps: `list_open_bills`, then `get_bill_detail` for the bills it decides to single out (a skipped bill, a near shutoff), then `draft_allocations`, then a short description. The options themselves are computed by the server (`server/allocation.js`).
- Drafts giving rules from a sentence (`draft_rules`); the patron saves them and zod validates them.
- It never decides a route, an amount, a payee, or moves money. Every money step is a server function behind a person's approval on PayPal.

Where the model runs, and how each screen says so:

| Setting | What runs | Label on screen |
|---|---|---|
| No key (default) | Recorded runs of the real model replay where the input is the recorded one (the Riverside sample papers, the fresh-session plan, the example rules sentence). Anything else uses a text parser and template text | "Recorded run: Claude Sonnet, 2026-11-12", or "stand-in reader" / "stand-in agent" |
| `LLM_BACKEND=account` | Claude Sonnet through your local Claude Code login (Claude Agent SDK, no API key) | "Claude Sonnet (local account)" |
| `ANTHROPIC_API_KEY` | Claude through the hosted API | "Claude (API key)" |

The recordings are in `server/recorded-runs/*.json`: every model call, every tool call with its input, the model's text, and timings. They were made with `npm run record:runs` (`LLM_BACKEND=account`, PayPal on the stand-in). Server checks, routes, payees and amounts are always computed live; only the model's part is replayed. The hosted API path has not been run.

## Environment variables

| Name | Purpose | Default |
|---|---|---|
| `PORT`, `PUBLIC_URL` | Server port and public base URL (used for PayPal return URLs). The server warns at startup if they disagree | 3001, `http://localhost:PORT` |
| `FORCE_MOCK` | `1` ignores all keys and stays on stand-ins | `0` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Live Claude reader and explanations through the hosted API; empty = stand-in agent | empty, `claude-sonnet-5-5` |
| `LLM_BACKEND` | `account` runs the model through your local Claude Code login (Claude Agent SDK, local development only, never reads `ANTHROPIC_API_KEY`). The UI labels it "Claude Sonnet (local account)". `FORCE_MOCK=1` turns it off. Empty with no key: recorded runs replay where they apply | empty |
| `MATCH_MODE` | `hold` = AUTHORIZE now, capture after the window. `capture_after_window` = the card appears only after the window and one CAPTURE order is made (use when the biller's own app credentials are not available) | `hold` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials for payee orders through the SDK (both required for sandbox mode) | empty |
| `PAYPAL_SDK_LOG` | `1` writes one-line PayPal SDK diagnostics (status, reason, debug id; never request bodies) to stderr | empty |
| `RIVERSIDE_MERCHANT_ID`, `CEDAR_MERCHANT_ID` | Sandbox business merchant ids of the demo billers (the registry payee) | stand-in ids |
| `RIVERSIDE_CLIENT_ID`, `RIVERSIDE_CLIENT_SECRET` | Biller-side sandbox credentials for the Agent Toolkit invoicing calls | empty |
| `HOLDER_SETTLE_MINUTES` | Window between the holder's capture and the earliest match capture | empty: 1 on the stand-in, 4320 (3 days) with sandbox keys |
| `SETTLE_JOB_SECONDS` | How often the in-process settle job captures holds whose window is over | empty: 5 on the stand-in, 30 with sandbox keys |
| `SEED_DAILY_LIMIT` | Sample invoices per day (sandbox protection) | `50` |
| `BILLER_PASSCODE` | Demo passcode for the biller console | `demo-biller` |
| `OPS_KEY` | Header `x-ops-key` for `POST /api/ops/settle` | empty (endpoint disabled) |
| `SANDBOX_SELF_BILLER_MERCHANT_ID` | Sandbox demo mode: Riverside is played by the business account behind `PAYPAL_CLIENT_ID` (one REST app runs the whole path) | empty |
| `PUBLIC_FEED` | `1` shows every holder's bill to every patron; `0` keeps sample bills private to their session | `0` |

## Limits, stated plainly

- The full path to a paid invoice ran in the sandbox with Riverside as its own PayPal app (invoice, recording, void and refund on Riverside's credentials), and earlier with the app's own business account playing the biller (`SANDBOX_SELF_BILLER_MERCHANT_ID`). A paid invoice reads `MARKED_AS_PAID` in PayPal, because recorded payments are external entries.
- Releasing a hold uses the biller's own app credentials. The shared app can authorize and capture for a payee but gets 403 on void. Without those credentials the server warns at startup, and `MATCH_MODE=capture_after_window` avoids holds altogether.
- The R2 screen does not open a payment link: the invoice returned by the sandbox has no pay-page link, so it says to pay on PayPal's invoice (the link is in the invoice email).
- Invoices made through the Agent Toolkit carry no due date; the shutoff date set by the biller is what measures urgency.
- The budget planner compares every affordable set of up to 18 bills. With more eligible bills it keeps the 18 most urgent and says so on screen ("no option is beaten by another set of the 18 most urgent bills").
- `npm test` runs on the stand-ins only (it forces mock mode). The real-model and sandbox runs are in `VERIFY.md`; the real-model run used a local Claude account, not the hosted API.
- The stand-in and the sandbox billers are ours. No real utility is connected; a real biller would need to be onboarded with PayPal.
- Matching is a selection and commitment device, not fraud proofing. It confirms that this invoice has a completed payment made through Settled by the holder's PayPal login. It cannot tell whose wallet funded it or whether it is later disputed. PayPal buyer protection claims can arrive up to 180 days after a payment; a 3-day window does not cover that, and the card says so.
- Payment disputes on the patron side are the biller's to handle as a merchant.
- In-memory state: restarting the server resets all sessions.
- Sample documents are rendered text, not PDFs. The live reader gets that text inside an untrusted-data wrapper.
- We did not find another service that lets a holder and an unrelated patron split one biller invoice. That is a search result, not a claim.

## License

MIT. See `LICENSE`.
