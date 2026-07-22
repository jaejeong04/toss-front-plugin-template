# BE/CRM Verification Request — 할부 (installment) handling (2026-07-22)

**From:** Frontend plugin (client mode, `feature/client-mode-payment`)
**To:** Backend + CRM
**Type:** **Verification request** — I am not asking you to build anything new. I am asking you to confirm, against your actual code and data, whether four things are already true. Two of them may already be broken in production.
**Supersedes parts of:** [`handoff-crm-backend-2026-07-13.md`](handoff-crm-backend-2026-07-13.md) — see its 2026-07-22 addendum.
**Answer format:** the sign-off table in §5. Please answer each row with evidence (a file/function reference, or a query result), not just ✅.

---

## 1. Why this arrived now

The 2026-07-13 handoff told you that the plugin would show a 할부 개월수 selection screen for payments ≥5만원, and that non-zero `installment` values would start appearing "from now on" as a result.

**That framing was wrong, and the correction is the reason for this request.** The Toss client-mode firmware prompts for 할부 by itself, on its own 서명 (signature) screen, once the charged amount reaches 50,000원. The plugin's screen was redundant and has been removed (`4ff13c6`).

The consequence that matters to you:

> **Non-zero `installment` values do not depend on the plugin shipping anything.** They are produced by the terminal firmware, on any client-mode device, for any customer paying ≥5만원 who taps the 할부 row. There is no feature flag, no plugin gate, and no deploy that turns this on — it is a property of the terminal.

So the obligations in the 2026-07-13 handoff that were framed as "prepare for when 할부 ships" are not future work. They may already be live. That is what §2 and §3 ask you to determine.

---

## 2. What to verify

### V1 — `cancelParams.installment` is copied from the original approval `[BE]` ⚠️ highest priority

**The contract:** `requestPaymentCancel` documents `installment` as **"원본 결제의 할부 개월"**, default `0`. When BE builds `cancelParams` for a `session.dispatch (kind=cancel)`, it must copy the persisted `response.card.installment` from the original approval's `tossResponse`.

**Why the plugin cannot cover for you:** the plugin passes `cancelParams` through to the SDK **verbatim** — see [`front-plugin-js/payment.html:570`](../../front-plugin-js/payment.html:570) (`// 1. Pass cancelParams through as-is — backend constructed it.`) and the `requestPaymentCancel(dispatch.cancelParams)` call below it. Whatever BE puts in the payload is what reaches the VAN. There is no plugin-side default, fallback, or correction.

**Where to look:** wherever BE constructs the `cancelParams` object for a cancel/refund dispatch, from the persisted original `tossResponse`.

**Pass:** `cancelParams.installment` is populated from `tossResponse.response.card.installment` (not hardcoded, not omitted, not defaulted to `0`).

**Fail means:** every refund of a 할부 approval goes out as 일시불. VAN behavior on that mismatch is undocumented — it may silently mis-post rather than reject.

**Report:** the function/file that builds `cancelParams`, and the line that sets `installment`. If it is not set, say so plainly — that is the answer we need.

### V2 — no `2`–`12` constraint anywhere `[BE + CRM]`

**What we retract:** the 2026-07-13 handoff and the old §6.6 published the value set as `일시불 (0) + 2~12개월`, explicitly excluding `1`. **That bound was the plugin screen's, not the firmware's.** It left with the screen.

The firmware picker now defines the domain. `1` is possible. So are 18개월 / 24개월, which are common on 무이자 events.

**Where to look:** any validator, enum, `CHECK` constraint, column width, DTO type, or mapping table keyed on the installment value — on either side. Also anywhere a value outside an expected set would be rejected, clamped, or silently coerced.

**Pass:** the value is persisted and forwarded verbatim, with no range check.

**Fail means:** an 18개월 approval is rejected or truncated on write, and V1's refund path then rebuilds `cancelParams.installment` from a wrong number.

**Report:** confirm you searched, and name anything you found and removed.

### V3 — `HALBU` / `InstallmentPayMonth` reads the real value `[CRM]`

**The contract (unchanged, C5):** `HALBU` / `InstallmentPayMonth` ← `response.card.installment`.

**What changed:** only the likelihood. This field will carry non-zero values in normal operation now, not as an edge case.

**Pass:** the mapping exists, reads `response.card.installment`, and handles any non-negative integer (see V2).

**Report:** the mapping location, and confirmation it is not gated behind a "할부 enabled" flag of any kind.

### V4 — BE→CRM echo relays the full `response.card` `[BE]`

**The contract (unchanged, C5, §2.5 of the 2026-07-13 handoff):** the terminal echo to CRM must carry the **full** `response.card` object — `van`, `timestamp`, `approvalNumber`, `acquirerName`, `acquirerCode`, `issuerName`, `issuerCode`, `cardType`, `balance`, `installment`, `maskedCardNumber`.

**Why it is in this list:** V3 is unachievable if `installment` is stripped in transit. The legacy §6 example redacted `response.card` to `{}` / `{timestamp, approvalNumber}` — that was illustrative, not a field limit, but if anyone implemented from it, `installment` never reaches CRM.

**Pass:** the echo carries `response.card` unredacted.

**Report:** confirm the field list actually transmitted.

---

## 3. Data check — is this already live?

This is the question that decides whether V1 is a production bug or a pre-emptive fix. Please run it before answering V1.

**Query intent:** among persisted successful card approvals, are there any with a non-zero installment?

```sql
-- Adapt to your schema / JSON accessor.
-- Looking for: any stored approval where the customer chose 할부 on the terminal.
SELECT COUNT(*)                              AS installment_approvals,
       MIN(<installment_expr>)               AS min_months,
       MAX(<installment_expr>)               AS max_months
FROM   <sessions_or_receipts_table>
WHERE  <installment_expr> IS NOT NULL
  AND  <installment_expr> <> 0;
```

where `<installment_expr>` is your accessor for `tossResponse.response.card.installment`.

**Interpretation:**

| Result | Meaning |
|---|---|
| count = 0 | No 할부 approval has been taken yet. V1 is a pre-emptive fix — still MUST DO, but nothing is broken retroactively. |
| count > 0 **and** V1 passes | Working as intended. Please still report the max value — it tells us the real domain for V2. |
| count > 0 **and** V1 fails | **Production issue.** Every refund already issued against those approvals went out as 일시불. Report the count and the affected session IDs so we can scope remediation together. |

Also worth reporting: the **max** value observed. It is the only empirical evidence any of us has about what the firmware picker actually offers, and it directly informs V2.

---

## 4. What needs NO action

Do not spend time on these — they are listed so you can stop if you were about to.

| Item | Status |
|---|---|
| `FAILED` / reason `USER_BACKED_OUT` handler | **Dead but harmless — leave it.** The plugin 할부 screen's back-arrow was its only producer and that screen is gone. The payment page will never emit it. Do not delete surrounding logic to "clean up"; the branch simply never fires. |
| `order.html` `session.abort(reason: "USER_BACKED_OUT")` | **Unaffected — still fires.** This is a **different wire message** at a **different lifecycle stage** (during 메디캐시 selection, pre-`chargeContext`). "USER_BACKED_OUT retired" applies **only** to the `session.result` `FAILED` envelope on the payment page. If you were about to remove abort handling, don't. |
| C4 `IN_PROGRESS`→`EXPIRED` watchdog timer | **Hold.** The 2026-07-22 addendum said 할부 dwell now sits inside the firmware's `timeoutMs` window, implying you could shrink the timer. That was an inference, not a measurement, and shrinking it is the unsafe direction. **Do not resize until we have measured it on-device.** Leave the current value. |
| Failure envelope / same-session retry semantics | **Unchanged** from the 2026-07-13 handoff. |
| `FAILED` → late-`SUCCESS` idempotency (§2.3) | **Unchanged.** |
| Receipt `maskedCardNumber` item | **Unchanged** — still open on its own track. |

---

## 5. Sign-off

Please fill in and return. "Evidence" means a file/function reference or a query result, not a checkmark.

| # | Item | Owner | Status | Evidence |
|---|---|---|---|---|
| V1 | `cancelParams.installment` ← persisted `response.card.installment` | BE | ☐ pass ☐ fail ☐ unclear | |
| V2 | No `2`–`12` (or any) range constraint on the installment value | BE + CRM | ☐ pass ☐ fail ☐ unclear | |
| V3 | `HALBU`/`InstallmentPayMonth` ← `response.card.installment`, ungated | CRM | ☐ pass ☐ fail ☐ unclear | |
| V4 | BE→CRM echo relays full `response.card` incl. `installment` | BE | ☐ pass ☐ fail ☐ unclear | |
| §3 | Data check — count of non-zero installment approvals | BE | count = ___, max = ___ | |

**If any row is `fail` or `unclear`, please say which and stop there** — we will work through it together rather than have you guess at intent.

---

## Reference

- Plugin-side change: commit `4ff13c6` (screen removed), `03aaeb0` (handoff addendum)
- Current design: [`docs/toss-client-mode-flow.md`](../toss-client-mode-flow.md) §6.6 — 할부 is firmware-owned
- Prior handoff: [`handoff-crm-backend-2026-07-13.md`](handoff-crm-backend-2026-07-13.md) — its §2.4, §2.5, §3.2 are the obligations being verified here
- The plugin now calls `requestPayment` with **no** `installment` param at all; the module owns selection end to end.
