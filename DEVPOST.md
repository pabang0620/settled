# Settled: Half & Half

The bill is untrusted. The payee isn't.

Demo only. No real money, no real billers, no real people. Everything runs on PayPal Sandbox or on a built-in stand-in.

## Inspiration

About 21.5 million U.S. households are behind on their energy bills (NEADA, 2026). Strangers do want to help: utilities run gift-payment desks, and in Istanbul people pay each other's bills anonymously. What is missing is a safe way for an unrelated person to pay half of a stranger's bill when the only evidence is a photo or a PDF. A document can be edited, and it can carry a line like "our bank details changed, send payment to ...". We asked what happens if the document is never allowed to decide where money goes.

## What it does

A person with a past-due bill (the holder) uploads the document. Claude reads it and reports what it says, including any payment instruction. The server then compares it with the biller's own invoice and decides one of three paths: R1 match on the invoice, R2 pay on PayPal's invoice page, R3 decline with a next step.

On R1 the holder pays their own part first, directly to the biller registered in Settled (an Orders v2 order with `payee.merchant_id`). A patron whose rules fit (budget, per-bill cap, "holder pays at least 1/2", region) then sees a card and funds the rest, again straight to the biller. Money never goes to a person.

The three sample documents show the idea. An edited amount is blocked because the paper does not match the ledger. A hidden instruction ("send payment to helpme@example.com") is reported, ignored, and the paper is refused because of that instruction alone: number, amount and due date all match, and the server marks the instruction as the only failing check. The payee stays the registry biller. For patrons there is a budget planner: the server computes two allocation options (urgent first, most bills closed), skips a bill whose ledger lookup timed out, and no offered option is beaten by any other set of bills. Claude only describes the options.

## How we built it

- React 19 + Vite front end, Express back end, zod on every input, one central error handler, integer cents everywhere, per-invoice locks.
- The AI reads and explains; the server decides. Route, amount and payee come from server code, the registry and the biller's ledger.
- PayPal calls go through the APIMatic-generated `paypal` SDK (installed from the PayPal APIMatic Context Plugin) for orders and payments, and through the PayPal Agent Toolkit for invoicing and refunds. A contract sheet (`paypal-plan.md`) was written before the code. Every write claims its operation first, sends a deterministic `PayPal-Request-Id`, and settles a lost answer by re-reading.
- Each side of a deal is a different role: the holder pays first, a patron holds the match, and the match is captured only if the holder's part stays paid for the whole window (3 days in production, shortened for the demo).
- With no keys, a stand-in with PayPal's documented response shapes runs the whole app. 98 tests run on the stand-in (`npm test` forces mock mode).

## Challenges

- The sandbox showed things a fake never would. Voiding an authorization returns 204 with no body and the SDK raised a `DecodeError` on that success; the adapter now settles it by reading the authorization. The Agent Toolkit reports failures as `{ok:false,...}`, and we had treated a 404 as a success until a live run showed it.
- A shared sandbox app can authorize and capture for a payee but gets 403 when it tries to void. Releasing a hold needs the biller's own app credentials. We added `MATCH_MODE=capture_after_window` and a startup warning for setups without them.
- Our sandbox biller app has no Invoicing feature, so recording both payments on the biller's invoice and reaching PAID is verified in the stand-in only.
- Keeping a hidden instruction refused for the right reason, and proving it with a test where the instruction is the only failing check.

## Accomplishments that we're proud of

- Real sandbox results with ids: a payee order captured on the Riverside business account (order 1YM58126NG301100N, capture 5V973346CM946373X, fee paid by the payee), an AUTHORIZE order authorized and captured (authorization 3AR14874A6278953U, capture 94T771459L404044W), a hold voided as the biller app (authorization 6KH08201LE3777732 `VOIDED`), a biller refund (refund 07J41073AN345254V), and the same `PayPal-Request-Id` returning the same order twice (order 7CL75003489574914). They are listed in the README and in the app under Activity.
- The model was run for real through a local Claude account (not the hosted API): it reported the hidden instruction and did not follow it, and the server refused the paper on its own.
- Rules for money are tested: shares and rounding, one open matched bill per PayPal account, a double settle charges once, two patrons on one bill make one match, a reversal voids the hold, other sessions cannot touch a bill.

## What we learned

- Make the document the least trusted thing in the system and the design gets simple: every dollar and every payee comes from somewhere else.
- A generated SDK is only as good as its first live call. The 204 void case passed in review and failed on the first real void.
- A written contract before code (what is claimed, what is sent, what is re-read after a lost answer) made the adapter easy to test with a fake `fetch`.

## What's next

- Turn on the Invoicing feature for the biller app and run the remaining checks: recording both payments, the PAID state, and a full in-app hold, wait and capture.
- Drive the real PayPal approval page and return flow from the browser, and receive refund and dispute webhooks instead of polling.
- Run the hosted API path for the reader (so far only the local account path was run), and host a public demo.
- Onboard a real biller; matching is a commitment device, not fraud proofing, and a payment can still be reversed later (buyer protection claims can arrive up to 180 days after a payment).

## Testing instructions

No account or key is needed.

```bash
cd app
npm install
npm run build
npm start        # http://localhost:3001, stand-in mode
npm test         # 98 tests, mock mode forced
```

1. Open the app and press **Watch one bill get settled**. Approve in the checkout dialog. A prepared bill goes to a patron card, is held, then charged.
2. Go to **I need help with a bill**, choose Riverside Water, press **Try a sample bill**.
3. Upload **Edited amount**: route R3, amount mismatch BLOCKED.
4. Upload **Hidden instruction**: the instruction is shown on the left, "ignored by server" and "Payee unchanged: Riverside Water" on the right, route R3 `unbacked_instruction`, and it is the only failing check.
5. Upload **Real bill**: route R1. Pick a share and press **Pay my part**; the ledger shows PARTIALLY_PAID.
6. In a fresh session go to **I'm a patron**, press **Prepare demo bills**, then **Plan my budget**: Plan A is 4 bills for $256.00, Plan B is 5 bills for $278.90, one bill is skipped for a ledger timeout. Choose one.
7. Then press **Show open bills**, approve a hold, press **Run the settle job now**: the invoice is PAID with two payments.
8. **I'm a biller** (passcode `demo-biller`): turn Sponsorable on or off and set the shutoff date.
9. Open **Activity**: the real sandbox ids are listed under "Sandbox evidence". The header names the real source of the model ("stand-in", or "Claude Sonnet (local account)" with `LLM_BACKEND=account`).

To run on the PayPal Sandbox, fill the PayPal rows in `.env` and follow `VERIFY.md`.
