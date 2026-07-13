# CRM/Backend Handoff — 결제 실패 처리 + 할부 (2026-07-13)

**From:** Frontend plugin (client mode, `feature/client-mode-payment`)
**Trigger:** 2026-07-13 device-test feedback — (1) 결제 실패 시 재시도 화면 없음, (2) 실패 시 소켓 이벤트 없음 → CRM 처리 불가, (3) 할부 선택 경로 없음, (4) 영수증 카드번호 이상.
**Plugin-side status:** implemented on `feature/client-mode-payment` (retry screen, failure envelope, 할부 선택). One hardening fix-round in progress; **the wire contract below is final and unaffected by it.**
**Design doc:** [`docs/toss-client-mode-flow.md`](../toss-client-mode-flow.md) §6.5 (failure envelope + same-session retry), §6.6 (할부), §9 (receipt).

---

## 1. What the plugin now does (behavior you will observe)

- On a card-payment failure (decline / user-cancel / timeout), the plugin shows an itemized failure screen with **다시 결제하기** and retries `requestPayment` **on the same `sessionId`**. During retries **nothing terminal is sent** — the session must stay `IN_PROGRESS`.
- A terminal `session.result` is sent exactly once, on: **SUCCESS**, or **give-up** (back-arrow). Abandonment (customer walks away) sends nothing → your `EXPIRED` watchdog resolves it.
- For `charged >= 50,000원`, a **할부 개월수 selection screen** (일시불 + 2~12개월) shows before payment; the choice goes into `requestPayment.installment`. Below 5만원: always 일시불 (`installment: 0`).

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
| `FAILED`, reason = `USER_BACKED_OUT` | customer backed out **before any attempt** (할부 screen back-arrow) | `CANCELED` | `USER_CANCELED` — **not** a card decline |
| `FAILED`, any other reason (SDK reject: hard decline / 잔액 부족 / bridge error) | e.g. Toss error code/message | `CANCELED` (or new `FAILED`) | `PAYMENT_DECLINED` (carry `reason` through to CRM) |

Notes:
- `CANCELED`/`TIMEOUT` envelopes are the **real Toss result forwarded unchanged**; `FAILED` is plugin-synthesized only when `requestPayment` rejected (no Toss result exists).
- **No medicash deduction** on any non-success (`pointUseAmount` is 0).

### 2.2 Session state machine: retries are same-session

- Do **not** terminalize a session on a failed attempt — you won't hear about it; the session stays `IN_PROGRESS` until terminal `session.result` or your watchdog `EXPIRE`s it.
- **C4 watchdog budget:** think-time now includes 할부-selection dwell + failure-screen dwell + N retries (each up to `timeoutMs`, default 60s). Size the `IN_PROGRESS`→`EXPIRED` timer accordingly (or accept more `EXPIRED`-then-late-SUCCESS reconciles).
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
| 4 | 할부-screen back-arrow (first prompt) → `FAILED`/`USER_BACKED_OUT` → CRM records user-cancel, not decline | BE + CRM |
| 5 | Refund of a 3개월 approval — with `cancelParams.installment` set vs defaulted 0 | BE + device |
| 6 | `installment: N` when customer pays by QR/BARCODE on the firmware overlay (ignored? rejected?) | FE + device |
| 7 | Receipt mask format: capture raw `maskedCardNumber`, compare with slip expectation | CRM |

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
