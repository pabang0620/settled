# Video script: Settled (about 2:30)

Recorded on the hosted app https://settled.35-216-2-121.sslip.io (PayPal stand-in, live Claude Sonnet through the API key, 1-minute hold window). If a live call shows a recorded replay instead, the recording retries once and the video labels the replay honestly.

Start the app in the recording state with one command:

```bash
npm run demo:video     # builds, then serves http://localhost:3001: stand-in PayPal, recorded Claude runs, 1-minute window, settle job every 5 s
```

Use a fresh browser profile (or press **New session** first). Browser at 1440x900. Step numbers match the README walk-through and the DEVPOST testing instructions. Every scene below is something the app shows today; nothing depends on a sandbox item that VERIFY.md marks blocked.

| Time | Step | On screen | Narration / caption (English) | Criterion |
|---|---|---|---|---|
| 0:00-0:15 | Hook | Home page, tagline "The bill is untrusted. The payee isn't." | "About 21.5 million U.S. households are behind on their energy bills (NEADA, 2026). Strangers want to help, but a bill is just a document, and documents lie." | Impact (problem, linked number) |
| 0:15-0:35 | 1 Watch one bill get settled | Press **Watch one bill get settled**, approve in the checkout dialog, "Charged and recorded on the invoice" | "Settled pays bills at the source. A holder pays their part, a patron matches the rest, and both payments go to the biller, never to a person." | Idea, Presentation |
| 0:35-0:50 | 2 Try a sample bill, 3 Edited amount | **I need help**, **Try a sample bill**, upload **Edited amount**: "Paper amount mismatch BLOCKED" | "The amount comes from the biller's ledger. An edited paper is blocked." | Technology |
| 0:50-1:20 | 4 Hidden instruction | Upload **Hidden instruction**. Pause on left/right panels: instruction, "ignored by server, and the paper is refused because of it", "Payee unchanged". Open **Recorded run: Claude Sonnet**, zoom on the `report_bill_fields` call and the instruction it reported | "This paper matches the ledger in every field, but it says to send money to an email address. A live Claude Sonnet call reads it, reports the line and does not follow it. The server refuses the paper, and the payee stays the registry biller." | Innovation (memorable scene), AI use |
| 1:20-1:40 | 5 Real bill, Pay my part | Upload **Real bill**, R1, pick 1/2, **Pay my part with PayPal to Riverside Water**, approve, PARTIALLY_PAID | "The real bill passes. The holder pays half first, straight to Riverside Water's merchant account." | Technology (PayPal payee order) |
| 1:40-2:05 | 6 Hold and settle | **I'm a patron**, **Show open bills**, **Hold**, approve. Show "Charged after HH:MM:SS", press **Run the settle job now**: "Not charged yet ... until". Caption "One minute later" with the header visible, then "Charged and recorded on the invoice" and the PAID bill under **I need help** | "The patron's match is only held. It is charged after the holder's part stays paid for the window: three days in production, one minute here. If the holder pulls their payment back, the hold is released." | Technology, Impact |
| 2:05-2:25 | 7 Plan my budget | **New session**, **Prepare demo bills**, **Plan my budget**: A 4 bills $256.00, B 5 bills $278.90, INV-1219 skipped. Open the recorded run: `list_open_bills`, `get_bill_detail` x3, `draft_allocations` | "A patron says: use my last 300 dollars, most urgent first. The server computes the options. Claude chooses which bills to check and explains the trade-off; it cannot change an option or move money." | AI use, Technology |
| 2:25-2:35 | 9 Activity | **Activity**, zoom on the Sandbox evidence panel (V2, V8, V4, V10a ids) | "These payments also ran in the PayPal Sandbox through the APIMatic PayPal SDK. The ids are in the app and the README." | Technology (sandbox proof), APIMatic |
| 2:35-2:45 | Close | Home page | "Settled. The bill is untrusted. The payee isn't." | Presentation |

Notes for recording:
- Do not show step 8 (biller console) unless time allows; it is in the README and DEVPOST.
- Say "live" only for live calls. Say "recorded run" whenever a replayed transcript is on screen. Do not call the stand-in text a model.
- The hold-window wait (about 1 minute) is cut in the edit and marked "One minute later".
- Show the invoice reaching PAID in the PayPal Sandbox only in the `npm run demo:sandbox` scene (VERIFY.md V3 and V7 passed there); on the stand-in the header says "PayPal stand-in".
