# paypal-plan.md: Settled, APIMatic PayPal TypeScript SDK contract sheet

Written before any project file was edited (the SDK install and `node_modules/` are the only earlier writes). Facts come from the installed package `node_modules/paypal/` (version 2.29.0, API spec 2.29): `sdk-map.md`, `map/operations/orders.md`, `map/operations/payments.md`, and the model files named in the Type sources tables. No PayPal call of any kind was made; the smoke is a VERIFY item (see below).

## 0. Repo survey

| Item | Finding |
| --- | --- |
| Module format | ESM (`"type": "module"`), plain JavaScript, Node >= 20. `instanceof` on SDK error classes is reliable (one dialect). No `tsconfig`, no TypeScript in the app |
| Package manager | npm. `paypal` installed with `npm install git+https://github.com/context-plugins/paypal-typescript-sdk#main`; `dist/` was built by the install (`dist/esm`, `dist/commonjs` present) |
| Test runner | `node --test test/*.test.js`, `node:assert/strict`, stand-in PayPal in `server/integrations/mockPaypal.js` |
| Build | `vite build` (client only) |
| Baseline (untouched tree) | `npm test`: 46 tests, 46 pass |
| Exemplar for layering | `server/integrations/invoicing.js` (live call vs stand-in behind one function surface); `server/http.js` (`HttpError`, central `errorHandler`) |
| Type check | the app has no TypeScript toolchain; there is no `tsc` to run. The adapter is JavaScript and is verified by the tests against the real SDK code (faked `fetch`). Stated in BUILD_REPORT.md |

## 1. Host decision

| Question | Decision |
| --- | --- |
| Environments | the SDK declares one (`https://api-m.sandbox.paypal.com`), no `ServerEnvironment` |
| This deployment talks to | PayPal **sandbox** only (Settled never targets live). The client is built with `serverOptions: { baseUrl: SANDBOX_BASE }` written out explicitly; the factory refuses to build unless the host of that URL is exactly `api-m.sandbox.paypal.com` (guard `assertSandboxHost`, tested) |
| Credential | `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from `.env` (sandbox app). Both must be non-empty or the factory throws at startup (an unset OAuth credential is not an SDK error, it would 401 later) |
| Client lifetime | built once, lazily on first live call, held in a module variable (token cache and resource getters live on it). Mock mode never builds it |

## 2. Operations in scope (all from the map)

| App function (unchanged name) | SDK call | Request type | Wire | Returns | Error class |
| --- | --- | --- | --- | --- | --- |
| `createHolderOrder` / `createMatchOrder` | `client.orders.createOrder` | `Orders.CreateOrderRequest` | `POST /v2/checkout/orders` | `Order` | `Orders.CreateOrderError` |
| `getOrder` | `client.orders.getOrder` | `Orders.GetOrderRequest` | `GET /v2/checkout/orders/{id}` | `Order` | `Orders.GetOrderError` |
| `captureOrder` | `client.orders.captureOrder` | `Orders.CaptureOrderRequest` | `POST /v2/checkout/orders/{id}/capture` | `Order` | `Orders.CaptureOrderError` |
| `authorizeOrder` | `client.orders.authorizeOrder` | `Orders.AuthorizeOrderRequest` | `POST /v2/checkout/orders/{id}/authorize` | `OrderAuthorizeResponse` | `Orders.AuthorizeOrderError` |
| `captureAuthorization` | `client.payments.captureAuthorizedPayment` | `Payments.CaptureAuthorizedPaymentRequest` | `POST /v2/payments/authorizations/{authorization_id}/capture` | `CapturedPayment` | `Payments.CaptureAuthorizedPaymentError` |
| `voidAuthorization` | `client.payments.voidPayment` | `Payments.VoidPaymentRequest` | `POST /v2/payments/authorizations/{authorization_id}/void` | `PaymentAuthorization` | `Payments.VoidPaymentError` |
| `getCapture` | `client.payments.getCapturedPayment` | `Payments.GetCapturedPaymentRequest` | `GET /v2/payments/captures/{capture_id}` | `CapturedPayment` | `Payments.GetCapturedPaymentError` |
| (re-read only) | `client.payments.getAuthorizedPayment` | `Payments.GetAuthorizedPaymentRequest` | `GET /v2/payments/authorizations/{authorization_id}` | `PaymentAuthorization` | `Payments.GetAuthorizedPaymentError` |

Imports are aliased from the package root only: `PaypalClient, PaypalError, ApiError, orderSchema, orderAuthorizeResponseSchema, capturedPaymentSchema, paymentAuthorizationSchema, CheckoutPaymentIntent, PayPalExperienceUserAction, PayeePaymentMethodPreference, defaultLoggingOptions`. The SDK model named `Error` is never imported (JavaScript, no alias needed; the error body is read structurally).

### Fields (channel, wire name, required, default)

| Operation | Field | Channel | Wire | Req | Default |
| --- | --- | --- | --- | --- | --- |
| createOrder | `body` (`OrderRequest`) | body | | yes | |
| createOrder | `payPalRequestId` | header | `PayPal-Request-Id` | no | |
| createOrder | `prefer` | header | `Prefer` | no | `"return=minimal"` (sent even when omitted) |
| createOrder | `payPalMockResponse`, `payPalPartnerAttributionId`, `payPalClientMetadataId`, `payPalAuthAssertion` | header | as named | no | |
| getOrder | `id` | path | | yes | |
| getOrder | `fields`, `payPalMockResponse`, `payPalAuthAssertion` | query/header | | no | |
| captureOrder, authorizeOrder | `id` | path | | yes | |
| captureOrder, authorizeOrder | `payPalRequestId`, `prefer` (default `"return=minimal"`), others | header | | no | |
| captureOrder, authorizeOrder | `body` | body | | no (omitted: no body, no Content-Type) | |
| captureAuthorizedPayment | `authorizationId` | path | `authorization_id` | yes | |
| captureAuthorizedPayment | `body` (`CaptureRequest`) | body | | no | `finalCapture` defaults to `false` inside the model and is sent |
| captureAuthorizedPayment | `payPalRequestId`, `prefer` (default `"return=minimal"`) | header | | no | |
| voidPayment | `authorizationId` | path | `authorization_id` | yes | |
| voidPayment | `payPalRequestId`, `prefer` (default `"return=minimal"`) | header | | no | |
| getCapturedPayment | `captureId` | path | `capture_id` | yes | |
| getAuthorizedPayment | `authorizationId` | path | `authorization_id` | yes | |

SDK-sent on every non-GET operation above: `Idempotency-Key` (minted per call). Six identity headers (`User-Agent`, `X-APIMatic-*`) ride every request.

### Model members the app sets or reads

| Model | Source file | Members set / read (camelCase; wire name in brackets) | Required |
| --- | --- | --- | --- |
| `OrderRequest` | `src/models/order-request.ts` | `intent` (required), `purchaseUnits` [purchase_units] (required), `paymentSource` [payment_source] | `intent`, `purchaseUnits` |
| `PurchaseUnitRequest` | `purchase-unit-request.ts` | `referenceId`, `invoiceId`, `description`, `amount` (required), `payee` | `amount` |
| `AmountWithBreakdown` | `amount-with-breakdown.ts` | `currencyCode` [currency_code], `value` | both |
| `PayeeBase` | `payee-base.ts` | `merchantId` [merchant_id] | optional member, set |
| `PaymentSource.paypal` -> `PayPalWallet.experienceContext` | `payment-source.ts`, `pay-pal-wallet.ts`, `pay-pal-wallet-experience-context.ts` | `returnUrl`, `cancelUrl`, `userAction`, `shippingPreference`, `paymentMethodPreference`. Defaulted members the SDK always sends: `contactPreference`, `landingPage` | optional |
| `CaptureRequest` | `capture-request.ts` | `amount` (`Money`), `invoiceId`, `finalCapture` | all optional |
| `Order` / `OrderAuthorizeResponse` | `order.ts`, `order-authorize-response.ts` | `id`, `status`, `intent`, `payer.payerId`, `purchaseUnits[0].payments.captures[0]`, `.authorizations[0]`, `links[]` | every member optional (`f?: T`): the adapter asserts the members it depends on |
| `CapturedPayment` | `captured-payment.ts` | `id`, `status`, `amount`, `invoiceId`, `finalCapture` | every member optional |
| `PaymentAuthorization` | `payment-authorization.ts` | `id`, `status`, `amount` | every member optional |

Responses are decoded by the SDK into camelCase models. The adapter keeps the existing interface (wire-shaped objects such as `order.purchase_units[0].payments.captures[0].id`, `order.payer.payer_id`) by re-encoding with the exported schema values (`orderSchema.encode(...)`), so `holder.js`, `matching.js` and all tests are untouched.

Enum members used: `CheckoutPaymentIntent.Capture`/`Authorize`, `PayPalExperienceUserAction.PayNow` (`PAY_NOW`), `PayeePaymentMethodPreference.ImmediatePaymentRequired`, `PayPalWalletContextShippingPreference.NoShipping` is a plain string `NO_SHIPPING` taken from `pay-pal-wallet-context-shipping-preference.ts` (member `NoShipping`). Authorization statuses compared as strings: `CREATED`, `CAPTURED`, `PARTIALLY_CAPTURED`, `VOIDED`. Order status `COMPLETED`, `APPROVED`.

### Error arms per operation (tags are schema-derived; read from each operation's own table, never shared)

| Operation | Arms (tag: status) |
| --- | --- |
| createOrder | `error`:400, `error2`:401, `error3`:422, `error4`:default, `undeclared` |
| getOrder | `error`:401, `error2`:404, `error3`:default, `undeclared` |
| captureOrder, authorizeOrder | `error`:400, `error2`:401, `error3`:403, `error4`:404, `error5`:422, `error6`:500, `error7`:default, `undeclared` |
| captureAuthorizedPayment | `error`:400, `error2`:401, `error3`:403, `error4`:404, `error5`:409, `error6`:422, `error500`:500 (no body), `error7`:default, `undeclared` |
| voidPayment | `error`:401, `error2`:403, `error3`:404, `error4`:409, `error5`:422, `error500`:500 (no body), `error6`:default, `undeclared` |
| getCapturedPayment, getAuthorizedPayment | `error`:401, `error2`:403, `error3`:404, `error500`:500 (no body), `error4`:default, `undeclared` |

The adapter's error boundary keys on `err.status` and on the presence of `payload.body` (all declared bodies are the SDK `Error` model: `name`, `message`, `debugId`, `details[].issue`), never on a tag, so one shared translator is correct. `debugId` is logged by our code and is not returned to callers.

## 3. DURABLE WRITES

Store: `server/integrations/claims.js`, an in-memory `Map` owned by this application (same lifetime as the rest of the app state in `server/store.js`; restarting the server resets every session, as stated in the README). A claim is its own row (`key`, `requestId`, `state`, `result`), inserted before the SDK call. The insert refuses a key that already exists (the unique-constraint stand-in: `Map.has` check and `set` run in the same synchronous turn, so two callers in one process cannot both pass). The key is computed from values every caller doing the same operation shares (invoice, intent, amount, order id, authorization id), never from a per-attempt value.

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| create order (holder CAPTURE / match AUTHORIZE) | `claims` row `create:{biller}:{invoiceId}:{intent}:{amountCents}` | `claims.claim(key)` throws `DuplicateClaimError` | `durableWrite` catch, recognised by `instanceof DuplicateClaimError` (code `DUPLICATE_CLAIM`); the loser returns the winner's recorded order | `sdkOrders.js` `durableWrite` called by `createOrder` (claim taken by `claim(key)` from `claims.js`, caught in `durableWrite`) |
| capture order | `claims` row `capture-order:{orderId}` | same | same | `sdkOrders.js` `captureOrder` |
| authorize order | `claims` row `authorize-order:{orderId}` | same | same | `sdkOrders.js` `authorizeOrder` |
| capture authorization | `claims` row `capture-auth:{authorizationId}` | same | same | `sdkOrders.js` `captureAuthorization` |
| void authorization | `claims` row `void-auth:{authorizationId}` | same | same | `sdkOrders.js` `voidAuthorization` |

Order of every write: claim, SDK call, record the result. The claim is released when the provider refused the call (an `ApiError`) or the call never left (`AuthError`, `EncodeError`), so a later legitimate attempt is not blocked. A claim in state `done` stays, and its recorded result is what a later caller gets. The claim's `requestId` (a deterministic hash of the key) is sent as `PayPal-Request-Id`, so even a replay by a later process life would hit PayPal's own dedupe (provider keeps the key 45 days per `api-reference.md`). The key goes beside the claim, not in place of it. The app's existing per-invoice `withLock` still serialises callers in front of this.

### UNKNOWN OUTCOMES

`ConnectionError`, `TimeoutError`, and a `DecodeError` on a 2xx status are unknown, never failed. They are settled in the write's own catch.

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| create order | replay of `orders.createOrder` with the same `PayPal-Request-Id` (PayPal returns the original order for a repeated key; there is no order search by invoice) | the claim's `requestId` | `sdkOrders.js` `createOrder` (`settle: submit`, run by `settleUnknown`) | `test/sdkOrders.test.js` "create order: lost response is settled by replay with the same request id" |
| capture order | `orders.getOrder` | order id; settled when status is `COMPLETED` and a capture is present | `sdkOrders.js` `captureOrder` (`settle`) | "capture order: lost response is settled by get order" |
| authorize order | `orders.getOrder` | order id; settled when an authorization is present | `sdkOrders.js` `authorizeOrder` (`settle`) | "authorize order: lost response is settled by get order" |
| capture authorization | `payments.getAuthorizedPayment`, then replay of the capture with the same request id to learn the capture id | authorization id, claim `requestId` | `sdkOrders.js` `captureAuthorization` (`settle`) | "capture authorization: lost response is settled by get authorization, then the same request id returns the capture" |
| void authorization | `payments.getAuthorizedPayment` | authorization id; settled when status is `VOIDED` | `sdkOrders.js` `voidAuthorization` (`settle`) | "void authorization: lost response is settled by get authorization" and "void authorization: a 204 with no body is settled by get authorization" |

Found: the claim records what the provider holds. Not found, or the re-read itself fails: the claim moves to `unknown`, the caller gets HTTP 502 with code `outcome_unknown` ("PayPal did not confirm ... check before retrying"), never "failed". A later call on an `unknown` claim runs the settle again before anything else. A never-sent failure (`AuthError`, `EncodeError`) makes no re-read (tests "capture order: a never-sent failure (token refused) makes no re-read and frees the claim" and "encode failure is a never-sent failure: no request, no re-read, claim released").

Assumption flagged in section 7: the replay-by-request-id settle for create assumes PayPal returns the original response for a repeated `PayPal-Request-Id`. VERIFY item V10 checks it.

## 4. CROSS-OPERATION INVARIANTS

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| A payee is a registered biller (S1, S12) | the registry (`server/registry.js`), read in full | `assertRegistryEntry(biller)` first line of `createOrder`, before the claim and before any call (unchanged) | existing `test/rules.test.js` S1/S12 (mock mode) plus "sdk: a payee that is not in the registry never reaches fetch and leaves no claim" |
| An order id passed to capture or authorize is an order this app created | the set of order ids recorded by `done` create claims | `requireKnownOrder(id)` before the claim | "sdk: capture or authorize of an order this app did not create is refused and never calls fetch" |
| An authorization id passed to capture or void is one this app obtained from `authorizeOrder` | the set of authorization ids recorded from `done` authorize claims | `requireKnownAuthorization(id)` before the claim | "sdk: void or capture of an unknown authorization is refused and never calls fetch" |
| Amount is a positive integer number of cents computed by server code | the callers (`holderPart`, `matchPart` in `money.js`) | `createOrder` and `captureAuthorization` check `Number.isInteger(cents) && cents > 0` before the claim | existing money tests plus "sdk: a non-positive or fractional amount never reaches fetch" |

## 5. OPTIONAL REQUEST FIELDS

| Operation | Field | What requires it | Set it? |
| --- | --- | --- | --- |
| all five writes | `payPalRequestId` | the DUPLICATE CLAIMS / UNKNOWN OUTCOMES rows (claim `requestId`) | set, from the claim |
| createOrder, captureOrder, authorizeOrder, captureAuthorizedPayment, voidPayment | `prefer` | the app reads the order id, capture id, authorization id and `payer.payer_id` from the response, which `return=minimal` omits (the default the SDK would send); void needs a body because the SDK decodes the success as JSON | set `return=representation` |
| createOrder | `body.purchaseUnits[].payee.merchantId` | the task: pay the biller directly (PLAN) | set |
| createOrder | `body.purchaseUnits[].referenceId`, `invoiceId`, `description`, `amount` | the task: the invoice reference ties the order to the biller's invoice (S10); description is the payer-facing line | set |
| createOrder | `paymentSource.paypal.experienceContext` `returnUrl`, `cancelUrl`, `userAction=PAY_NOW`, `shippingPreference=NO_SHIPPING`, `paymentMethodPreference=IMMEDIATE_PAYMENT_REQUIRED` | the task (return to the app, a bill has nothing to ship, pay now); these five values are exactly the existing hand-written request | set |
| createOrder | `processingInstruction`, `payer`, `applicationContext`, `items`, `shipping`, `customId`, `softDescriptor`, `paymentInstruction`, `supplementaryData`, `breakdown` | nothing | leave out |
| createOrder | `payPalPartnerAttributionId`, `payPalClientMetadataId`, `payPalAuthAssertion`, `payPalMockResponse` | nothing | leave out |
| captureAuthorizedPayment | `body.amount`, `body.invoiceId`, `body.finalCapture=true` | the task: capture exactly the matched cents once, tagged with the invoice reference (existing request) | set |
| captureAuthorizedPayment | `noteToPayer`, `softDescriptor`, `paymentInstruction` | nothing | leave out |
| captureOrder, authorizeOrder | `body` | nothing | leave out (no body, no Content-Type) |
| getOrder, getCapturedPayment, getAuthorizedPayment | `fields`, `payPalMockResponse`, `payPalAuthAssertion` | nothing | leave out |

Test: "sdk: no request carries a header or key this code did not set" collects the headers of every captured request and asserts they are a subset of {authorization, content-type, idempotency-key (SDK), paypal-request-id, prefer, SDK identity headers}, and that the JSON bodies carry only the keys above. Note on `PayPal-Auth-Assertion`: the old hand-written request never sent it and nothing in the task requires it, so it stays out; whether PayPal needs it for a payee order is VERIFY V2.

## 6. WHEN THE API SAYS NO (one table, one translator `toHttpError`, applied identically at every call site)

| status | app answers | caller reads | test |
| --- | --- | --- | --- |
| a 4xx other than 401 / 403 / 429 (400, 404, 409, 422) | the same status | the API's reason (`details[0].issue`, else `name`, plus `message`) from `err.payload.body` | fake a 422 with a reason on capture order and on create order; assert status and reason in the thrown `HttpError` |
| 401 / 403 | 502 | fixed: "PayPal rejected Settled's own credentials." | fake a 401 on capture; assert 502 and the fixed text (reason not echoed) |
| 429 | 503 | fixed: "PayPal is busy. Try again shortly." | fake a 429 on get capture |
| 5xx | 502 | fixed: "PayPal had a problem. Nothing was changed unless noted." | fake a 500 |
| no response, on a write | per UNKNOWN OUTCOMES (502 `outcome_unknown` only after the re-read found nothing) | "unknown", never "failed" | lost-response tests |
| no response, on a read (`getOrder`, `getCapture`) | 502 | fixed: "PayPal could not be reached." | fake a connection failure on get order |
| `DecodeError` on a 2xx for a write | per UNKNOWN OUTCOMES | unknown | the void 204 test |
| `DecodeError` on an error status | the status the provider sent (4xx with no reason) | fixed text | fake an error status with a body that does not fit |
| `AuthError` / `EncodeError` / `ConfigurationError` | 500 `integration_defect` (nothing was sent) | generic server text (central handler hides 500 messages) | token 401 test |

The reason is logged in our code **and** put in the response (`HttpError.message`). The central `errorHandler` (`server/http.js`) already renders `err.message` for non-500 statuses. An SDK `message` is never put on the wire.

## 7. Resilience, logging, seam

| Topic | Decision |
| --- | --- |
| Retry | SDK defaults stand for reads (GET retried up to 3 times on 408/429/5xx and connection faults). No write joins `httpMethodsToRetry` (POST is sent once; the claim plus `PayPal-Request-Id` handle repeats). Per attempt `retry.timeout = 15_000` ms (default 60 s is too long for a person waiting on a button) |
| Logging | on at `level: "warn"` with a small logger (`sdkLogger` in `paypalSdk.js`) that is silent unless `PAYPAL_SDK_LOG=1`, in which case it writes one line to `process.stderr` (no `console.log`). `logRequestBody` stays **off** (request bodies carry payee ids and invoice references), `logRequestHeaders` off, no per-call `logging.level`. `level` is set explicitly so the `PAYPAL_CLIENT_LOG` environment variable cannot switch logging on. The `debugId` from a provider error body is written to the app's own diagnostics sink with the operation name |
| Hooks / pagination / streaming | the SDK has none; the app needs none (no list calls). `ClientOptions.fetch` is left as the global `fetch` in production and is the seam tests use |
| Idempotency | per section 3 |
| Webhook verification | not in the SDK; Settled has no webhook receiver of its own (ops trigger route only), nothing to move |

## 8. Not in the SDK, kept on REST / Toolkit

| Operation | Why it stays |
| --- | --- |
| Invoicing (create, send, get, record payment, create refund) | `server/integrations/invoicing.js` calls the PayPal Agent Toolkit as the biller. The SDK has resources `orders`, `payments`, `vault`, `transactionSearch`, `subscriptions` only; no invoicing. Kept on the Toolkit (the mock stand-in is unchanged) |
| Refund of the holder capture | done by the biller through the Toolkit (`create_refund`); the app never refunds. The SDK has `refundCapturedPayment`, but the app does not use it, so it is not wired |

The hand-written `rest()` and `accessToken()` helpers in `server/integrations/payeeOrders.js` are removed; nothing else used them.

## 9. REQUIRED READING (loaded before code)

- MUST load `typescript-getting-started` (done, lookup layer)
- MUST load `typescript-error-handling` (done, error ladder, unknown outcomes, `DecodeError` on 2xx)
- MUST load `typescript-client-initialization` (done, factory with credential check, explicit base URL, build once)
- MUST load `typescript-authentication` (done, client credentials, lazy token, `AuthError`)
- MUST load `typescript-calling-endpoints` (done, flat request, defaults are sent, `asApiResult` not needed because errors are translated in one catch)
- MUST load `typescript-models` (done, `f?: T` omit, camelCase vs wire, schema encode for the app-facing wire shape)
- MUST load `typescript-configuration-resilience` (done, retry gate, timeouts, logging, write safety options 1, 2 and 4)
- MUST load `typescript-testing` (done, fake `fetch`, token request is the first request, `maxRetries: 0`)

## 10. Assumptions and blockers

| # | Item | Class | Handling |
| --- | --- | --- | --- |
| A1 | PayPal returns the original order for a repeated `PayPal-Request-Id` (used to settle a lost create) | minor assumption, not verifiable offline | VERIFY V10; if false the lost-create path answers `outcome_unknown` and the operator checks the sandbox dashboard |
| A2 | A payee order created by a plain app credential (no `PayPal-Auth-Assertion`) is accepted | existing risk V2 | unchanged, VERIFY V2 |
| A3 | `voidPayment` answers 204 with no body in the real service; the SDK decodes success as JSON | confirmed with a fake: the SDK raises `DecodeError` (kind `decode`, status 204) | handled: `Prefer: return=representation` is sent and a 2xx `DecodeError` is settled by `getAuthorizedPayment` |
| A4 | No TypeScript toolchain in the app | minor | stated in BUILD_REPORT.md |
| A5 | The read-only smoke against the real credential is not run here | per the brief | VERIFY item "SDK smoke" |
| A6 | Same invoice, same amount, same intent after a consumed order returns the earlier order's record (claim `done`) | minor, same as the former `PayPal-Request-Id` behaviour | listed in BUILD_REPORT.md |
