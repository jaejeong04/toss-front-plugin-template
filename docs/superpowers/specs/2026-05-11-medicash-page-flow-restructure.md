# Custom 메디캐시 Page + Payment Flow Restructuring

> **Date:** 2026-05-11
> **Scope:** Frontend plugin only (`front-plugin-js/`).
> **Depends on:** [payment-flow-with-nice-terminal-frontend.md](../../payment-flow-with-nice-terminal-frontend.md) §7 "Pre-test block".

---

## 1. Summary

Two changes to the Toss FRONT plugin:

1. **Custom 메디캐시 page** — replace `sdk.template.renderUsePointPage` with custom HTML. Toss confirmed the points page can use custom rendering. The template doesn't support renaming "포인트" → "메디캐시", so custom HTML is required.

2. **Flow restructuring** — move `session.chargeContext` from payment.html to order.html (end of phase 1). After chargeContext, show a waiting screen until backend sends `session.proceed` over WS B (Alternative A from the feasibility review). Payment.html only runs phase 2 (`requestPayment`).

---

## 2. Custom 메디캐시 Page

### 2.1 Visual spec (from TO-BE reference)

```
┌──────────────────────────────────┐
│ ←                                │
│                                  │
│    메디캐시를 쓸까요?              │
│                                  │
│  (P) 사용 가능한 메디캐시          │
│      5,000캐시                   │
│                                  │
│  메디캐시 사용          5,000캐시  │
│  총 결제 금액          15,400원   │
│                                  │
│  [사용 안 함]    [전액 사용]       │
└──────────────────────────────────┘
```

### 2.2 Data bindings

| Element | Source | Format |
|---|---|---|
| "사용 가능한 메디캐시" amount | `usableCash` (computed from dispatch) | `{n.toLocaleString()}캐시` |
| "메디캐시 사용" amount | same `usableCash` | `{n.toLocaleString()}캐시` |
| "총 결제 금액" | `treatmentTotal - usableCash` | `{n.toLocaleString()}원` |

### 2.3 Interactions

| Element | Action |
|---|---|
| ← (back arrow) | `session.abort(USER_BACKED_OUT)` → home.html |
| "전액 사용" button | `handlePointChoice(usableCash)` |
| "사용 안 함" button | `handlePointChoice(0)` |

### 2.4 When to show

Same condition as current `renderUsePointPage`: `usableCash >= minUseAmount && usableCash > 0`. Otherwise skip directly to `handlePointChoice(0)`.

### 2.5 Styling

Use Toss Design System CSS tokens already loaded (`tds.min.css`, `tps/main.css`, `tps/others.css`). Match the visual weight and spacing of the native `renderUsePointPage` template. The page renders into `#app` via `innerHTML`.

---

## 3. Flow restructuring

### 3.1 New order.html flow

```
mount
  ├─ read dispatch + sessionId (unchanged)
  ├─ open WS B + device.register + session.claim (unchanged)
  ├─ compute usableCash (unchanged)
  ├─ if usableCash >= minUse && usableCash > 0
  │     render custom 메디캐시 page
  │     user clicks "전액 사용" or "사용 안 함"
  │     └─ handlePointChoice(pointUse)
  ├─ else
  │     └─ handlePointChoice(0)
  │
  handlePointChoice(pointUse):
    ├─ compute charged, tax, supplyValue
    ├─ send session.chargeContext over WS B
    ├─ store smartdoctor.dispatch.pointUse in sessionStorage
    ├─ if charged === 0 (100%-메디캐시)
    │     close WS → navigate to payment.html (existing skip path)
    ├─ else
    │     render waiting screen
    │     listen WS B for:
    │       session.proceed → close WS → navigate to payment.html
    │       session.abort   → toast → home.html
    │       error           → error toast → home.html
    │     back arrow → session.abort(USER_BACKED_OUT) → home.html
```

### 3.2 renderOrderPage (confirmation screen)

Skipped in the new flow. The custom 메디캐시 page already displays amounts. Can be re-added later as a UX decision.

### 3.3 Waiting screen

Rendered into `#app` via `innerHTML`. Shows:
- Back arrow (← → session.abort + home.html)
- Message: "카드 단말기에서 결제를 진행해주세요"
- Loading spinner/indicator

Stays foreground until `session.proceed` arrives over WS B.

### 3.4 payment.html changes

Remove the `session.chargeContext` send (current lines 126–134). The rest of `runPayment` is unchanged — it still computes charged/tax/supplyValue from `pointUse` for `requestPayment` and `pendingPayment`.

### 3.5 100%-메디캐시 skip path

Unchanged at the SDK level. When `charged === 0`:
- order.html sends `session.chargeContext` (with `chargedSupplyValue=0`, `chargedTax=0`)
- order.html navigates directly to payment.html (no waiting screen)
- payment.html handles the skip path as today (sends `session.result` with `tossResponse: null`)

### 3.6 `session.proceed` contract (new WS B message)

Backend sends this to plugin over WS B after CRM has dispatched to NICE and NICE is ready for the Toss FRONT payment. Minimal shape:

```json
{
  "type": "session.proceed",
  "payload": {
    "sessionId": "<sessionId>"
  }
}
```

Plugin validates `sessionId` matches the current session before navigating.

---

## 4. Files touched

| File | Change |
|---|---|
| `front-plugin-js/order.html` | Major: custom 메디캐시 page + `handlePointChoice` + chargeContext send + waiting screen |
| `front-plugin-js/payment.html` | Minor: remove chargeContext send (lines 126–134) |
| `front-plugin-js/global.css` | Add styles for custom 메디캐시 page and waiting screen |

---

## 5. Out of scope

- `sdk.webSocket` server wiring (post-test block, per feasibility §7)
- NICE trigger handler (post-test block)
- Backend `session.proceed` implementation (backend team)
- CRM → NICE dispatch (CRM team)
