# Custom 메디캐시 Page + Payment Flow Restructuring

> **Date:** 2026-05-11
> **Scope:** Frontend plugin only (`front-plugin-js/`).
> **Canonical NICE-paired contract:** [2026-05-12-nice-paired-final-flow-design.md](./2026-05-12-nice-paired-final-flow-design.md) (supersedes `toss-payment-flow.md` §5.5–§6 for the NICE flow).

---

## 1. Summary

Two changes to the Toss FRONT plugin:

1. **Custom 메디캐시 page** — replace `sdk.template.renderUsePointPage` with custom HTML. Toss confirmed the points page can use custom rendering. The template doesn't support renaming "포인트" → "메디캐시", so custom HTML is required.

2. **Flow restructuring** — move `session.chargeContext` from payment.html to order.html (end of phase 1). After chargeContext (charged > 0), plugin enters **reader mode** (`sdk.template.renderIdlePage` + serial bridge) — no waiting screen, no navigation. Backend sends `session.proceed` to **CRM** (not plugin). Payment.html handles only the 100% 메디캐시 skip path.

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
    │     enter reader mode (§3.3):
    │       sdk.template.renderIdlePage({ type: "default" })
    │       sdk.serial.open({ baudRate: 115200, intercept: true })
    │       sdk.serial.listen((params) => sdk.van.write(params))
    │     [Toss SDK auto-overlays 통합결제창 when NICE triggers]
    │     [session.proceed flows Core → CRM (not plugin)]
    │     WS B onmessage:
    │       session.abort (ABORTED_BY_CRM) → toast → home.html
    │       error → error toast → home.html
```

### 3.2 renderOrderPage (confirmation screen)

Skipped in the new flow. The custom 메디캐시 page already displays amounts. Can be re-added later as a UX decision.

### 3.3 Reader mode entry

After `session.chargeContext` is sent (and charged > 0), plugin enters **reader mode** instead of rendering a custom waiting screen. Per Toss guidance (Slack channel C0ANAJW463E msg 1778737088, 2026-05-14), the architecture is 시리얼통신 기반 리더기 모드:

```js
sdk.template.renderIdlePage({ type: "default" });
sdk.serial.open({ baudRate: 115200, intercept: true });
sdk.serial.listen((params) => sdk.van.write(params));
```

- Plugin shows Toss's idle page — Toss SDK auto-overlays 통합결제창 when NICE triggers via serial
- Plugin is a passive bridge: forwards card-reading data from NICE to Toss's internal VAN module via `sdk.van.write`
- No custom waiting UI, no back button, no timeout — Toss SDK + NICE handle the UX
- Plugin does NOT call `sdk.payment.requestPayment` for NICE-mediated payments
- Plugin does NOT send `session.result` — CRM forwards NICE's result to backend

### 3.4 payment.html changes

`session.chargeContext` send is removed from `runPayment` (now in order.html). Under the NICE-paired reader-mode flow, `payment.html` is only entered for the **100% 메디캐시 skip path** (see §3.5) — `requestPayment` / `pendingPayment` are not reached. The legacy `runPayment` code below the skip-path branch is retained for now but is dead code under the NICE-paired contract; removal is a follow-up cleanup.

### 3.5 100%-메디캐시 skip path

Unchanged at the SDK level. When `charged === 0`:
- order.html sends `session.chargeContext` (with `chargedSupplyValue=0`, `chargedTax=0`)
- order.html navigates directly to payment.html (no waiting screen)
- payment.html handles the skip path as today (sends `session.result` with `tossResponse: null`)

### 3.6 `session.proceed` flow (Core → CRM, not plugin)

Backend's `session.proceed` flows from Core to **CRM** (not plugin), with `nextAction: DISPATCH_NICE | SKIP_NICE`. Plugin does not consume this message — it's a CRM-side signal to dispatch (or skip) NICE.

Documented canonically in [2026-05-12-nice-paired-final-flow-design.md](./2026-05-12-nice-paired-final-flow-design.md). The corresponding section in `toss-payment-flow.md` (§5.5 "Plugin Awaits Proceed") is marked obsolete by that doc's superseded banner.

---

## 4. Files touched

| File | Change |
|---|---|
| `front-plugin-js/order.html` | Custom 메디캐시 page + `handlePointChoice` + chargeContext send + reader mode entry (sdk.template.renderIdlePage + sdk.serial bridge) |
| `front-plugin-js/payment.html` | Remove chargeContext send (now in order.html); under reader mode, only the 100%-메디캐시 skip path is reached |
| `front-plugin-js/global.css` | Styles for custom 메디캐시 page |

---

## 5. Out of scope

- Backend `session.proceed` (Core → CRM) — backend team, shipped 2026-05-13
- CRM → NICE dispatch + NICE → CRM result relay (CRM team + NICE vendor)
- Refund flow for NICE-issued payments — `sdk.payment.requestPaymentCancel` semantics for NICE-owned card transactions need clarification from Toss
- `sdk.serial` and `sdk.van` API details — used as suggested by Toss Slack guidance without further documentation
