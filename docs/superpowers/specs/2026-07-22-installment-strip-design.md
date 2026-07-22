# Strip plugin-owned 할부 selection — defer to Toss firmware (2026-07-22)

## Why

The 2026-07-13 device test recorded that "the client-mode firmware payment UI does
**not** prompt for 할부" (§6.6 of `docs/toss-client-mode-flow.md`). On that finding
the plugin grew its own 할부 개월수 selection screen (`renderInstallmentScreen`,
commit `6c0c968`, hardened across `56ffbe4`/`179cc84`/`ab12ba4`).

**That finding was wrong.** The firmware prompts for 할부 on the **signature**
screen (`서명을 해주세요`) — a `할부 / 일시불 >` row that opens the module's own
개월수 picker — and it appears automatically once the charged amount exceeds
50,000원. The plugin screen is redundant: it asks the customer the same question
one screen earlier, and the firmware asks again regardless.

**Goal:** remove the plugin-owned selection screen and every branch that stems
from it; let the module own 할부 end to end.

## Scope

**In scope:** `front-plugin-js/payment.html` (the 할부 sites only),
`docs/toss-client-mode-flow.md` §6.5/§6.6/§10, and
`docs/integration/handoff-crm-backend-2026-07-13.md`.

**Explicitly out of scope — do not touch:**

- The same-session retry machinery: `attempt`/`attemptOnce`/`attemptInFlight`,
  `terminalized`, `hadRejectedAttempt`, `fatalToHome`, `renderFailureScreen`'s
  structure and its `interacted` staleness token, `giveUp`'s `getPayment`
  reconcile, `buildFailedResponse` envelope truthing, and the
  SUCCESS-outranks-error-frame ordering in `attemptOnce`. All of it predates the
  할부 screen or is orthogonal to it. **This is the single largest risk in this
  change** — the 할부 work was interleaved with three rounds of hardening fixes,
  and stripping it must not take any of that hardening with it.
- `order.html`'s `session.abort(reason: "USER_BACKED_OUT")` on the 메디캐시 page.
  Different producer, different lifecycle stage (pre-`chargeContext`), unaffected.
- `runCancel` / refund flow.
- The 100%-메디캐시 (`charged === 0`) branch.
- Every other doc's `installment` references — they describe the SDK response
  shape (`response.card.installment`), which is unchanged.

## Design decisions

### D1 — `installment` is omitted, not zeroed

The parameter is deleted from the `requestPayment` call rather than pinned to
`installment: 0`. The SDK documents the default as `0`, so the two should be
equivalent; omitting is the more conservative signal, because an explicit value
could plausibly be read by the firmware as a merchant pre-set that pins 일시불
and suppresses the built-in row. Undocumented either way → `[MUST TEST]`.

### D2 — payment-side `USER_BACKED_OUT` is retired

`renderInstallmentScreen`'s `onBack` was the only producer of
`FAILED`/`reason: "USER_BACKED_OUT"` on the payment page. After this change,
`chargeContext` is followed immediately by `requestPayment` — there is no
plugin-owned screen in between for a customer to back out of. The envelope
becomes unreachable and is retired from code and from the §6.5 mapping table.

BE/CRM were explicitly told to implement that row, so this requires a **handoff
addendum**, not a silent deletion. Their existing handling stays harmless (a
branch that never fires); the addendum tells them so.

Note the asymmetry that must survive: `order.html`'s `USER_BACKED_OUT` is a
`session.abort` on a **different** wire message at a **different** lifecycle
stage. It keeps working. The addendum must say this explicitly or BE will read
"USER_BACKED_OUT retired" too broadly.

**Correction (final review, 2026-07-22):** the envelope is *not* the only thing lost. The deleted screen used `renderSelectPage`, whose `onBack` is **documented**; the surviving failure screen uses `renderOrderResultPage`, whose `onBack` the frontend spec lists as a `[GAP]`. Because the 할부 screen re-appeared on every retry cycle, ≥5만원 payments previously always had a documented give-up surface, and now they have only the undocumented one. No code change follows from this — §6.5 already carried the `[GAP]` and the `EXPIRED` fallback — but the risk posture changed, and it is now tracked as a ship-blocking device test in §6.6 and as row 8 of the handoff test matrix.

### D3 — retry re-asks nothing

The failure screen's `다시 결제하기` currently branches on
`charged >= INSTALLMENT_MIN_AMOUNT` to re-show the 할부 screen, on the rationale
that switching to installments is the natural remedy for a 한도 초과 decline.
That rationale survives — it just moves to the firmware, which re-prompts on
every fresh `requestPayment`. So retry becomes an unconditional `attempt()`.

### D4 — docs are corrected in place, not deleted

§6.6 stays as a section and is rewritten to record (a) that the 2026-07-13
finding was wrong, (b) what the firmware actually does, (c) that the plugin
passes no `installment`. Deleting it would lose the record and invite someone to
re-derive the plugin-owned screen from the same mistaken premise.

The BE and CRM obligations inside §6.6 **survive unchanged** — firmware-owned
할부 makes non-zero `response.card.installment` values *more* likely, not less:

- `[BE, MUST DO]` `cancelParams.installment` ← persisted `response.card.installment`
- `[CRM]` `HALBU`/`InstallmentPayMonth` ← `response.card.installment`

The `[BE]` C4 watchdog note narrows: selection dwell is no longer *pre*-attempt
plugin time, it is inside the firmware's own `timeoutMs` window. Failure-screen
dwell still applies.

### D5 — forward commits, not `git revert`

Four commits after `6c0c968` (`56ffbe4`, `179cc84`, `ab12ba4`, `2804408`) modify
the same functions. Reverting would conflict and risk clobbering hardening that
must survive per Scope. Forward edits on `feature/client-mode-payment`.

## Code changes — `front-plugin-js/payment.html`

All six sites are inside `runPayment`. Line numbers are pre-change.

| # | Site | Change |
|---|---|---|
| 1 | L44–47 | Delete `INSTALLMENT_MIN_AMOUNT` const and its 3-line comment |
| 2 | L401–403 | Reword `renderFailureScreen`'s staleness-token comment — it cross-references `renderInstallmentScreen`, which is being deleted. The token itself and its semantics stay **exactly** as-is |
| 3 | L447–461 | Failure-screen cta `onClick` → `{ interacted = true; attempt().catch(fatalToHome); }`. Comment rewritten per D3. `interacted = true` **must** remain the first statement |
| 4 | L482–550 | Delete `installmentMonths` declaration and all of `renderInstallmentScreen` |
| 5 | L603 | Delete the `installment: installmentMonths,` line from the `requestPayment` argument object (D1) |
| 6 | L644–652 | Entry becomes an unconditional `await attempt();`; comment rewritten |

**Post-condition:**
`grep -n 'INSTALLMENT_MIN_AMOUNT\|installmentMonths\|renderInstallmentScreen\|renderSelectPage' front-plugin-js/payment.html`
returns nothing. A broader `installment\|할부` grep still matches the two
explanatory comment lines added at site 3 — those are intentional (they document
why retry no longer re-asks) and are the only permitted residue.

**Non-obvious hazard at site 6.** The current entry point is deliberately
*fire-and-forget* for the 할부 path — `renderInstallmentScreen(null, null)` is
not awaited, so `attemptInFlight` is never held during customer think-time, and
`attempt()` is entered later from an option's `onClick`. Restoring
`await attempt();` restores the pre-`6c0c968` shape where `runPayment` awaits the
attempt directly. Verify against `git show 63df62f:front-plugin-js/payment.html`
that the restored form matches what the surrounding code (the `await runPayment(...)`
caller and its error handling) expects.

## Doc changes

### `docs/toss-client-mode-flow.md`

- **§6.5 mapping table (L328):** the `FAILED` / `USER_BACKED_OUT` row is marked
  retired 2026-07-22 (kept in the table with a retired marker so BE reading the
  older handoff can find it, rather than silently vanishing).
- **§6.5 same-session-retry bullet (L333):** drop
  "incl. `USER_BACKED_OUT` for a back-out before any attempt".
- **§6.6 (L336–343):** rewritten per D4. Heading becomes firmware-owned; body
  records the corrected finding with its date; BE/CRM obligations retained;
  `[MUST TEST]` list replaced per below.
- **§10 table (L423):** drop "(할부 re-asked per §6.6)" from the card-declined
  row; the `§6.5, §6.6` source cell stays valid.

### `docs/integration/handoff-crm-backend-2026-07-13.md`

An **addendum section dated 2026-07-22** at the top of the doc, plus body edits so
the document does not contradict its own addendum:

- L5 plugin-side status, L14 할부 bullet, L41 `USER_BACKED_OUT` row,
  L51 C4 watchdog note, L79 test row 4, L81 test row 6.
- **Surviving unchanged:** §2.4 `cancelParams.installment` MUST DO, the `HALBU`
  bookkeeping item, and test row 2 (installment approval end-to-end — re-owned to
  the firmware path).

## Test matrix changes

**Retired:** 할부-screen back-arrow → `USER_BACKED_OUT`; `renderSelectPage.onBack`
fires; `installment: N` + BARCODE/QR (the plugin no longer sends `N`).

**New — highest priority:**

1. Omitting `installment` still shows the firmware's 할부 row at ≥ 50,000원, and
   the row is absent below it. Confirms D1.
2. A 3개월 selection on the firmware screen echoes back as
   `response.card.installment === 3` on the plugin's `SUCCESS` result.

**Unchanged and still required:** installment approval end-to-end; refund of an
installment approval with vs. without `cancelParams.installment`; overlay
transition (blank-WebView family).

## Verification

No test suite exists for this page (it is a device-driven kiosk plugin), so
verification is: the post-condition grep, a syntax check on the modified HTML, a
read-through diff against `63df62f` confirming only 할부 lines moved, and
sub-agent review of every task per the user's standing requirement.
