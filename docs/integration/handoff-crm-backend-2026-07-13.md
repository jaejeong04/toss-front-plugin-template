# CRM/Backend Handoff — 결제 실패 처리 + 할부 (2026-07-13)

**From:** Frontend plugin (client mode, `feature/client-mode-payment`)
**Trigger:** 2026-07-13 device-test feedback — (1) 결제 실패 시 재시도 화면 없음, (2) 실패 시 소켓 이벤트 없음 → CRM 처리 불가, (3) 할부 선택 경로 없음 *(— 정정됨 2026-07-22, see addendum)*, (4) 영수증 카드번호 이상.
**Plugin-side status:** implemented on `feature/client-mode-payment` (retry screen, failure envelope). **The 할부 선택 screen was withdrawn 2026-07-22 — see the addendum below.** The wire contract below is otherwise final.
**Design doc:** [`docs/toss-client-mode-flow.md`](../toss-client-mode-flow.md) §6.5 (failure envelope + same-session retry), §6.6 (할부), §9 (receipt).

---

## ⚠️ Addendum 2026-07-22 — the plugin 할부 screen was withdrawn

The 2026-07-13 device finding behind §1's 할부 bullet was **wrong**: the client-mode firmware **does** prompt for 할부, on the **서명 (signature)** screen, automatically once the charged amount reaches 50,000원 (`>= 50000`). The plugin's own 개월수 selection screen was therefore redundant and **has been removed**. The plugin now calls `requestPayment` with **no `installment` param** and the module owns selection end to end.

| Item | Status |
|---|---|
| `FAILED` / reason `USER_BACKED_OUT` (§2.1 table) | **RETIRED.** The 할부 screen's back-arrow was its only producer; the payment page will never emit it. Handling you have already built is harmless — a branch that never fires. |
| C4 watchdog budget (§2.2) | **Expected to narrow** — 할부 dwell should sit inside the firmware's own `timeoutMs` window rather than being separate pre-attempt plugin think-time. This is an inference, not a measurement, and it shrinks a safety margin: **do not resize the timer until device test 9 confirms it.** Failure-screen dwell + N retries still apply. |
| ⚠️ `installment` value domain | **CHANGED — action required.** The withdrawn plugin screen offered exactly `0` + `2`–`12`. That bound is **gone**; the firmware picker defines the domain now, so `1` or 18/24개월 (무이자 events) are possible. **If you built a validator, column constraint, or enum on `2..12`, remove it** — persist and forward `response.card.installment` verbatim. |
| Device test 4 (할부-screen back-arrow) | **Struck** — the screen no longer exists. |
| Device test 6 (`installment: N` + QR/BARCODE) | **Struck** — the plugin no longer sends `installment`. |
| Device test 2 (6만원 + 3개월 end-to-end) | **Still required, re-owned:** the 3개월 is now chosen on the firmware 서명 screen. Must still echo `response.card.installment === 3`. |
| §2.4 `cancelParams.installment` ← MUST DO | **Unchanged, still required — and its trigger is no longer gated on a plugin feature.** The firmware produces non-zero installments on its own, so this may already be live rather than pending. Verify per [`verify-crm-backend-2026-07-22.md`](verify-crm-backend-2026-07-22.md) V1 + §3 data check. |
| §3 `HALBU` / `InstallmentPayMonth` | **Unchanged and still required.** |

**New device test (FE + device):** confirm that omitting `installment` still shows the firmware 할부 row at ≥5만원 and not below. **This is ship-blocking:** if it fails, 할부 is impossible at the kiosk with no plugin fallback.

> **Not affected:** `order.html`'s `session.abort(reason: "USER_BACKED_OUT")` during the 메디캐시 selection UI. That is a **different wire message** at a **different lifecycle stage** (pre-`chargeContext`) and keeps working exactly as specified. "`USER_BACKED_OUT` retired" applies **only** to the `session.result` `FAILED` envelope on the payment page.

Everything else in this document — the failure envelope, same-session retry semantics, `FAILED`→late-`SUCCESS` idempotency, and the receipt mask item — is unchanged.

---

## 1. What the plugin now does (behavior you will observe)

- On a card-payment failure (decline / user-cancel / timeout), the plugin shows an itemized failure screen with **다시 결제하기** and retries `requestPayment` **on the same `sessionId`**. During retries **nothing terminal is sent** — the session must stay `IN_PROGRESS`.
- A terminal `session.result` is sent exactly once, on: **SUCCESS**, or **give-up** (back-arrow). Abandonment (customer walks away) sends nothing → your `EXPIRED` watchdog resolves it.
- **할부 (superseded 2026-07-22 — see addendum):** the plugin sends no `installment` and shows no selection screen. The **firmware** prompts for 할부 on its 서명 screen once the amount reaches 50,000원 (`>= 50000`), and the chosen 개월수 comes back on `response.card.installment` as before.

## 2. Backend — required changes

### 2.1 Accept the new `FAILED` envelope in `session.result` ← fixes "CRM 처리 불가"

Non-success terminal envelope (Plugin→BE):

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 0,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636,
    "tossResponse": { "type": "CANCELED" | "TIMEOUT" | "FAILED", "response": { "reason": "..." } }
  }
}
```

Mapping (BE assigns terminal state + `failureReason` on the BE→CRM echo):

| `tossResponse.type` | reason | Session STATUS | `failureReason` |
|---|---|---|---|
| `CANCELED` (Toss-resolved: user canceled at terminal) | — | `CANCELED` | `USER_CANCELED` |
| `TIMEOUT` (Toss-resolved: card UI timed out) | — | `EXPIRED` | `EXPIRED` |
| ~~`FAILED`, reason = `USER_BACKED_OUT`~~ | **RETIRED 2026-07-22** (see addendum) — its only producer was the withdrawn 할부 screen's back-arrow. Not emitted by the payment page. Unrelated to `order.html`'s `session.abort(USER_BACKED_OUT)`, which still fires. | ~~`CANCELED`~~ | ~~`USER_CANCELED`~~ |
| `FAILED`, any other reason (SDK reject: hard decline / 잔액 부족 / bridge error) | e.g. Toss error code/message | `CANCELED` (or new `FAILED`) | `PAYMENT_DECLINED` (carry `reason` through to CRM) |

Notes:
- `CANCELED`/`TIMEOUT` envelopes are the **real Toss result forwarded unchanged**; `FAILED` is plugin-synthesized only when `requestPayment` rejected (no Toss result exists).
- **No medicash deduction** on any non-success (`pointUseAmount` is 0).

### 2.2 Session state machine: retries are same-session

- Do **not** terminalize a session on a failed attempt — you won't hear about it; the session stays `IN_PROGRESS` until terminal `session.result` or your watchdog `EXPIRE`s it.
- **C4 watchdog budget:** think-time now includes failure-screen dwell + N retries (each up to `timeoutMs`, default 60s). Firmware 할부 dwell is *expected* to sit inside each attempt's `timeoutMs` window and so need no separate budget (revised 2026-07-22 — see addendum) — but that is unmeasured; **device test 9 must confirm it before you shrink the timer.** Size the `IN_PROGRESS`→`EXPIRED` timer accordingly (or accept more `EXPIRED`-then-late-SUCCESS reconciles).
- ⚠️ The old §10-style rule "first CANCELED result = session terminal, retry needs fresh `session.create`" is **superseded** — do not implement from stale doc rows.

### 2.3 `FAILED` → late-`SUCCESS` idempotency

A give-up `FAILED` can be followed by a late `SUCCESS` for the same `sessionId` (via `session.reconcile` / pending-payment recovery — e.g. the bridge dropped after an on-device approval). **`SUCCESS` wins**: idempotent receipt write, or flag for refund of the orphan. (Extends the existing §6.4 EXPIRED→late-SUCCESS rule.)

### 2.4 Refunds of 할부 payments: `cancelParams.installment` ← MUST DO

`requestPaymentCancel` documents `installment` as **"원본 결제의 할부 개월"** (default 0). When building `cancelParams` from the persisted `tossResponse`, copy `response.card.installment` in — otherwise every refund of an installment payment goes out as 일시불. (VAN behavior on mismatch is undocumented → joint device test, §4.)

### 2.5 Relay the full `response.card` on the BE→CRM echo (reconfirm)

Already agreed under C5 — reiterating because 할부 makes it load-bearing: CRM's `HALBU`/`InstallmentPayMonth` reads `response.card.installment`, which will now be non-zero.

## 3. CRM — required changes

1. **Handle failure echoes** (`CANCELED` / `EXPIRED` / `PAYMENT_DECLINED` per §2.1) — this is the missing "실패 시 처리" path. No card receipt on non-success. Note: there are **no per-attempt events**; you learn the outcome at success / give-up / expiry only.
2. **`HALBU` bookkeeping:** `InstallmentPayMonth` ← `response.card.installment` — expect non-zero values from now on.
3. **영수증 카드번호 [MUST CONFIRM]:** in client mode the printable card number is **Toss's `maskedCardNumber` only** — Toss's VAN never returns the full PAN, and the NICE CAT (now printer-only) does not see the card. The "이상하게 들어감" report is (most likely) Toss's mask format differing from NICE's old format. If the *format* is the issue, normalize `maskedCardNumber` CRM-side before printing; needs business sign-off that a Toss-masked PAN on the 매출전표 is acceptable (it is PCI-standard).

## 4. Joint device-test items (blocking full sign-off)

| # | Test | Owner |
|---|---|---|
| 1 | Same-`paymentKey` retry accepted by `requestPayment` after a decline (design-gating) | FE + device |
| 2 | 6만원 + 3개월 approval end-to-end → `response.card.installment === 3` on echo, `HALBU` written, receipt prints | FE + BE + CRM |
| 3 | Give-up after TIMEOUT reaches BE as `TIMEOUT` (→ `EXPIRED`), not `FAILED` | BE |
| 4 | ~~할부-screen back-arrow → `FAILED`/`USER_BACKED_OUT`~~ **STRUCK 2026-07-22** — screen withdrawn. Replaced by: firmware 할부 row appears ≥5만원 and not below, with no `installment` sent | FE + device |
| 5 | Refund of a 3개월 approval — with `cancelParams.installment` set vs defaulted 0 | BE + device |
| 6 | ~~`installment: N` when customer pays by QR/BARCODE~~ **STRUCK 2026-07-22** — the plugin no longer sends `installment` | — |
| 7 | Receipt mask format: capture raw `maskedCardNumber`, compare with slip expectation | CRM |
| 8 | **[SHIP-BLOCKING]** `renderOrderResultPage.onBack` fires on device — give-up on the payment page now depends on it alone (the documented `renderSelectPage.onBack` went with the withdrawn screen). If it does not fire, an abandoned failure screen resolves only via your `EXPIRED` watchdog | FE + device |
| 9 | Does `timeoutMs` bound the 서명/할부 dwell? Time a 6만원 attempt with a deliberate ~60s dwell on the 개월수 picker. Gates the C4 timer resize (§2.2) | FE + BE + device |

## 5. Reference — success envelope (unchanged)

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636,
    "tossResponse": { "type": "SUCCESS", "response": { "paymentMethod": "CARD", "card": { "van": "...", "timestamp": 0, "approvalNumber": "...", "acquirerName": "...", "acquirerCode": "...", "issuerName": "...", "issuerCode": "...", "cardType": "...", "balance": 0, "installment": 3, "maskedCardNumber": "..." } } }
  }
}
```

Questions → frontend plugin team (this repo). Envelope/table source of truth: `docs/toss-client-mode-flow.md` §6.5–6.6.
