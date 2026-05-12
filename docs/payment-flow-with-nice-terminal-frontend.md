# Payment Flow with NICE Terminal — Frontend (Toss Front Plugin) Role

> **Status:** Finalized contract as of 2026-05-12. This document is the source of truth for the Toss Front custom plugin layer in the NICE-paired payment flow.
>
> **Design doc (authoritative):** [docs/superpowers/specs/2026-05-12-nice-paired-final-flow-design.md](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md). Every flow fact in this document mirrors the design doc verbatim.
>
> **Supersedes:** the 2026-05-08 feasibility-review predecessor that previously lived at this path (based on a flow shape where the plugin owned `sdk.payment.requestPayment`). That shape is no longer valid. Confirmation via Slack thread `C0ANAJW463E` (Toss support, 2026-05-12) established that NICE 카드 단말기 + Toss Front operates in **시리얼통신 기반 리더기 모드**, with Toss firmware auto-overlaying its own 통합결제창 over the plugin during card payment.
>
> **Audience:** plugin engineer working in [`front-plugin-js/`](../front-plugin-js/). For backend and CRM responsibilities see the sibling MDs.

---

## 1. Plugin's role in the NICE-paired flow

In the finalized 리더기 모드 architecture, the **NICE 카드 단말기** owns card payment end-to-end (VAN, approval, receipt) and **Toss Front firmware** auto-overlays its own 통합결제창 plus auto-`setIdle`s the device when card processing completes. The custom plugin web layer therefore does **NOT** participate in any card-payment SDK call. The plugin's responsibility shrinks to two things: (a) the 메디캐시 selection UI plus `session.chargeContext` send for every session (so backend/CRM know how much, if anything, NICE should charge), and (b) the 100% 메디캐시 success branch — the only path where no card payment occurs and where the plugin therefore must render its own success screen and post the terminal `session.result`.

**Refund is out of scope per design doc §3.3 (pre-existing CRM↔NICE mechanism). The plugin is never involved in any refund path.** No refund-related messages exist on WS B; no plugin code path handles refunds.

---

## 2. Plugin pages

Existing pages remain on disk; their scope shrinks. Concrete file references below.

| File | Role in finalized flow | What's being removed |
|---|---|---|
| [`front-plugin-js/home.html`](../front-plugin-js/home.html) | Idle dispatcher. Renders `sdk.template.renderIdlePage`. Opens WS B, sends `device.register`, runs 20s heartbeat with exp-backoff reconnect (capped at 30s, 4403 skips). Listens for `session.dispatch` → stashes payload in `sessionStorage` and navigates to `order.html`. Listens for CRM-driven `session.abort` (valid only in DISPATCHED — plugin never connects to a CREATED session). | The `session.reconcile` handler in `home.html`; the `runPendingPaymentRecovery` invocation from `ws.onopen`; the `dispatch.kind === "cancel"` arm inside the `session.dispatch` handler that routes to `payment.html`; the `recoveredSessions` / `recoveryReady` plumbing that exists only to dedupe reconcile vs recovery. |
| [`front-plugin-js/order.html`](../front-plugin-js/order.html) | Sends `session.claim` on enter (DISPATCHED → IN_PROGRESS). Renders the custom 메디캐시 selection UI (the medicash-selection render block introduced by commit `7f98300`). On 결제 submit: sends `session.chargeContext`. If `chargedSupplyValue + chargedTax > 0` (card path) the plugin stays put on whatever was on screen — Toss firmware will auto-overlay the 통합결제창. If `charged === 0` (100% 메디캐시) the plugin navigates to `payment.html` for the success-only branch. Also handles `session.abort(USER_BACKED_OUT)` when the user taps back during the medicash UI. | The `renderWaitingScreen` function in `order.html`; the `AWAITS_PROCEED` feature gate around the waiting-screen render; the `session.proceed` case in the WS B message handler; the `waitingForProceed` state variable; the 120s defensive timeout inside the waiting screen. |
| [`front-plugin-js/payment.html`](../front-plugin-js/payment.html) | **100% 메디캐시 success branch only.** Reads the dispatch payload + `pointUse` from `sessionStorage`, sends `session.result` with `tossResponse: null` and `chargedSupplyValue/chargedTax === 0`, renders the custom 수납 완료 success screen, navigates to `home.html` via `location.href`. Does **not** call `sdk.app.setIdle()` here — known blank-WebView lifecycle bug per design doc §3.2. | Everything else. Specifically: the `runPayment` non-zero-charge branch in `payment.html` and all of its `sdk.payment.requestPayment` plumbing; the `runCancel` flow in `payment.html` and all of its `sdk.payment.requestPaymentCancel` plumbing; `mapTossFailureToKorean`, `mapPaymentMethodToKorean`, `renderBackendErrorPage` (kept only as needed for medicash branch); the `pendingPayment` storage write inside `runPayment`; the `dispatch.kind === "cancel"` arm in the dispatcher. |
| [`front-plugin-js/settings.html`](../front-plugin-js/settings.html) | Unchanged. Continues to render Toss SN + 시리얼 통신 속도 + 매장명 표시 settings. Not part of the payment flow. | Nothing. |
| [`front-plugin-js/config.js`](../front-plugin-js/config.js) | Continues to export `BACKEND_HOST`, `CORE_TOKEN`, `backendWsUrl`, `pluginWsUrl`. | The `AWAITS_PROCEED` constant in `config.js`; the `PENDING_KEY` constant; the `runPendingPaymentRecovery` function. |
| [`front-plugin-js/sdk.js`](../front-plugin-js/sdk.js) | Unchanged. Continues to expose `window.TossFrontSDK` with dev `overrides({ serialNumber, merchant })`. | Nothing. |

---

## 3. Toss SDK methods used by the plugin

Full enumeration per design doc §5.

**Still used:**

- `sdk.app.getSerialNumber()` — for `device.register` payload (called in `home.html`, `order.html`, `settings.html`).
- `sdk.app.getMerchant()` — for merchant name display on success/result screens.
- `sdk.app.setIdle()` — **only** in `home.html` (idle screen mount via `renderIdlePage`). Never used on `payment.html` for the 100% 메디캐시 success-screen → home transition — that uses `location.href = "./home.html"` to avoid the blank-WebView lifecycle bug.
- `sdk.app.isDebugMode()` — for dev flags (existing usage).
- `sdk.storage.get` / `sdk.storage.set` / `sdk.storage.remove` — transient page state only. **No longer used for `pendingPayment` recovery.**
- `sdk.template.renderIdlePage` — `home.html` idle screen.
- `sdk.template.openToast` — error/abort toasts in `order.html`.
- `sdk.template.renderOrderPage` — usage TBD per design doc §5; may be kept for receipt-style display or replaced with custom HTML during medicash UI implementation.

**Explicitly NOT used (replaced with custom HTML per commit `7f98300`):**

- `sdk.template.renderUsePointPage` — replaced by `renderMedicashPage()` in `order.html`.
- `sdk.template.renderResultPage` — firmware handles result for the card path; `payment.html` uses custom HTML for the 100% 메디캐시 success screen.

**Removed entirely (no longer present anywhere in the plugin):**

- `sdk.payment.requestPayment` — firmware owns card payment; plugin has nothing to request.
- `sdk.payment.requestPaymentCancel` — refund is out of scope per design doc §3.3 (pre-existing CRM↔NICE refund mechanism); the plugin is not involved.
- `sdk.payment.getPayment` — no pending-payment recovery means no lookups by `paymentKey`.

---

## 4. Wire messages (WS B — Plugin ↔ BE)

WS B URL: `wss://<core>/ws/plugin?serial=<deviceSerialNumber>&token=<coreToken>` ([`config.js:32–39`](../front-plugin-js/config.js)). Connect from `home.html` (long-lived) and `order.html` (per-session).

> Heartbeat is handled at the WebSocket transport layer (legacy convention from `toss-payment-flow.md`); not a plugin-application concern. The plugin-application message tables below do not list `ping`/`pong`.

### 4.1 Plugin → BE

| Message | Purpose | Trigger |
|---|---|---|
| `device.register` | Register `serialNumber` (and `sdkVersion: "v0"`) with backend — first frame on every connect. | Plugin connects (ws.onopen on `home.html` / `order.html`). |
| `session.claim` | Plugin is engaged with the order/medicash UI; backend transitions DISPATCHED → IN_PROGRESS. | `order.html` `ws.onopen`, right after `device.register`. |
| `session.chargeContext` | Discounted amount after medicash selection. Backend decides (and forwards to CRM) whether NICE should be dispatched (`chargedSupplyValue + chargedTax > 0`) or skipped (== 0). | User clicks the medicash 결제 button in `order.html` (`handlePointChoice`). |
| `session.result` | **100% 메디캐시 success only.** Terminal `tossResponse: null` payload with zero charge values. | `payment.html` enters and detects 0-charge from `sessionStorage`. |
| `session.abort` | User backed out of medicash UI — `reason: "USER_BACKED_OUT"`. Only valid window for plugin-initiated abort is medicash selection (pre-`chargeContext`). | User taps back arrow on `order.html` medicash page (`sendAbortAndGoHome`). |

### 4.2 BE → Plugin

| Message | Purpose |
|---|---|
| `device.registered` | Ack for `device.register`. Log only. |
| `session.dispatch` | Start a new session. Payload simplified — see §4.3. |
| `session.abort` | CRM-driven abort relayed by backend. **Only valid in DISPATCHED** — plugin never connects to a CREATED session. Carries `reason: "ABORTED_BY_CRM"`. Plugin navigates to `home.html` via `location.href` (see §4.3 example). |
| `error` | Per existing §11 error-frame contract (toss-payment-flow.md §11). See §7.6 for plugin handling. |

### 4.3 Envelope examples

**`session.dispatch` (BE → Plugin) — simplified per design doc §4.3:**

```json
{
  "type": "session.dispatch",
  "payload": {
    "sessionId": "{sessionId}",
    "amount": {
      "supplyValue": 27273,
      "tax": 2727,
      "tip": 0
    },
    "orderSnapshot": {},
    "pointContext": {}
  }
}
```

Dropped from legacy: `kind`, `paymentKey`, `timeoutMs`, `excludePaymentTypes` — all were Toss-SDK-specific and no longer apply.

**`session.chargeContext` (Plugin → BE):**

```json
{
  "type": "session.chargeContext",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636
  }
}
```

Backend validates that `pointUseAmount + chargedSupplyValue + chargedTax + tip == original total`. Plugin computes `tax = Math.floor(charged / 11)` and `supplyValue = charged - tax` (same arithmetic as today — see `handlePointChoice` in `order.html`).

**`session.result` (Plugin → BE — 100% 메디캐시 only):**

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 30000,
    "chargedSupplyValue": 0,
    "chargedTax": 0,
    "tossResponse": null
  }
}
```

Sent immediately after `chargeContext` (back-to-back) when the user covered the entire total with 메디캐시. Plugin then renders its custom 수납 완료 screen and navigates `location.href = "./home.html"`.

**`session.abort` (Plugin → BE):**

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "{sessionId}",
    "reason": "USER_BACKED_OUT"
  }
}
```

BE relays `USER_BACKED_OUT` on the terminal echo to CRM as `session.result(failureReason: "USER_BACKED_OUT")`. See design doc §4.3 for the full `failureReason` enum.

**`session.abort` (BE → Plugin):**

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "{sessionId}",
    "reason": "ABORTED_BY_CRM"
  }
}
```

Sent only when CRM aborts a DISPATCHED session. Plugin response: navigate to `home.html` via `location.href` (do **NOT** call `sdk.app.setIdle()` — known blank-WebView lifecycle bug per design doc §3.2). Plugin should NOT receive `session.abort` if it has already sent `session.claim` and progressed past `session.chargeContext` — post-claim CRM aborts during NICE phase go out-of-band via the CRM↔NICE channel and the plugin is not notified (design doc §6 "Aborts").

---

## 5. State machine — plugin's POV

Subset of design doc §2 that the plugin actually observes or triggers. The plugin has no visibility into CREATED (CRM-only) or into terminal states reached purely by CRM/BE timers.

| From | To | Trigger | Plugin's role |
|---|---|---|---|
| CREATED | DISPATCHED | `session.dispatch` sent by BE | Plugin **observes**: receives frame in `home.html`, stashes payload, navigates to `order.html`. |
| DISPATCHED | IN_PROGRESS | `session.claim` | Plugin **triggers**: `order.html` `ws.onopen` sends it. |
| DISPATCHED | CANCELED | `session.abort` (CRM-origin, `reason: "ABORTED_BY_CRM"`) | Plugin **observes**: receives `session.abort` frame on `home.html` (or `order.html` if races), navigates to `home.html` via `location.href`. Valid only in DISPATCHED (plugin never connects to a CREATED session). |
| IN_PROGRESS | CANCELED | `session.abort(USER_BACKED_OUT)` | Plugin **triggers**: only valid window is during medicash UI (pre-`chargeContext`). |
| IN_PROGRESS | SUCCEEDED (100% 메디캐시) | `session.result(tossResponse: null)` | Plugin **triggers**: sent from `payment.html` 0-charge branch. |
| IN_PROGRESS | SUCCEEDED (card) | `session.result(niceResponse, status: SUCCEEDED)` from CRM | Plugin **not involved**: terminal reached over WS A; plugin's screen is being overlaid by firmware 통합결제창; firmware auto-`setIdle`s on completion. |
| IN_PROGRESS | FAILED (card) | `session.result(niceResponse, status: FAILED)` from CRM | Plugin **not involved**. |
| IN_PROGRESS | CANCELED (NICE-side) | `session.result(status: CANCELED)` from CRM | Plugin **not involved**: CRM aborts NICE out-of-band, then echoes terminal. |
| IN_PROGRESS | EXPIRED | BE timer (extended window, design doc §6) | Plugin **not involved**. |

**Critical contract change vs legacy:** after `session.claim` the plugin path is **no longer abortable** by the plugin once `session.chargeContext` has been sent. The plugin's only IN_PROGRESS abort window is the medicash selection screen.

**Terminal-state observation:** the plugin does **not** directly observe terminal states (SUCCEEDED/FAILED/CANCELED/EXPIRED) over WS B. Per design doc §4.2, BE→CRM `session.status` only carries DISPATCHED + IN_PROGRESS — terminal states go via `session.result` from BE to **CRM**, never to plugin. The plugin's primary signal that a session is done is the absence of further frames + the eventual mount of a new `session.dispatch` for a different session (or the plugin already being idle on `home.html` after its own terminal action). For 100% 메디캐시 the plugin observes its own terminal because the plugin is the originator of `session.result`. For card path the plugin's screen is being overlaid by firmware and firmware auto-`setIdle`s on completion.

> Legacy `TIMEOUT` terminal is retained in persistence for backcompat but not emitted by the new state machine. The plugin never directly sees `EXPIRED` either — that terminal arrives via BE→CRM `session.result(EXPIRED)`, not WS B.

---

## 6. End-to-end flows — plugin POV

### 6.1 Card-payment happy path (design doc §3.1)

```
CRM → BE              session.create
BE → Plugin           session.dispatch                  [home.html receives]
                                                        [home.html stashes payload,
                                                         navigates to order.html]

Plugin → BE           session.claim                     [order.html ws.onopen]

[order.html renders custom 메디캐시 selection UI]
[Customer selects partial-medicash or 사용 안함, taps 결제]

Plugin → BE           session.chargeContext             [charged > 0]
                                                        [BE forwards to CRM
                                                         via WS A]

[Plugin stays on whatever screen — does NOT navigate]
[CRM dispatches card payment to NICE out-of-band]
[Toss firmware auto-overlays plugin screen with 통합결제창]
[NICE ↔ Toss Front via VAN/serial — opaque to plugin]
[NICE returns approval to CRM]

CRM → BE              session.result (SUCCEEDED, niceResponse)   [WS A]
BE → CRM              session.result (terminal echo)

[Toss firmware: auto-setIdle on Toss Front device]
[Plugin next page load returns to home.html]
```

Plugin does **not** observe the card outcome over WS B. Plugin does **not** render a card-side success/failure page. The firmware handles the visual transition.

### 6.2 100% 메디캐시 happy path (design doc §3.2)

```
CRM → BE              session.create
BE → Plugin           session.dispatch                  [home.html receives]
                                                        [navigates to order.html]

Plugin → BE           session.claim                     [order.html ws.onopen]

[order.html renders 메디캐시 selection UI]
[Customer chooses 전액 사용 — covers entire total]

Plugin → BE           session.chargeContext             [chargedSupplyValue=0,
                                                         chargedTax=0,
                                                         pointUseAmount=total]
                                                        [BE forwards to CRM]
                                                        [CRM detects 0 charge,
                                                         does NOT dispatch NICE]

[order.html navigates to payment.html#sessionId
 (charged === 0 branch)]

Plugin → BE           session.result                    [tossResponse: null,
                                                         chargedSupplyValue=0,
                                                         chargedTax=0]
                                                        [back-to-back after
                                                         chargeContext]

[payment.html renders custom 수납 완료 success screen
 (no sdk.template.renderResultPage)]
[After timer / 확인 tap:
 location.href = "./home.html"
 — NOT sdk.app.setIdle() — known blank-screen bug]
```

---

## 7. Edge cases — plugin POV

### 7.1 Plugin disconnects (design doc §6)

| When | What plugin sees / does |
|---|---|
| After `device.register`, before `session.claim` | WS dropped. Reconnect with exp-backoff (existing `home.html` loop). Backend may have already transitioned the session to FAILED (`PLUGIN_UNRESPONSIVE`) after 30s grace — on reconnect, plugin just re-registers and waits for the next `session.dispatch`. No reconcile expected. |
| After `session.claim`, before `session.chargeContext` | WS dropped. Backend will EXPIRE the session after the extended IN_PROGRESS timeout (recommended ≥180s per design doc §6, exact value owned by backend). Plugin reverts to `home.html` on reconnect; no recovery action. |
| After `session.chargeContext` (card path) | Irrelevant to plugin. The card flow continues CRM↔NICE↔CRM↔BE; terminal arrives over WS A. Plugin has no further role. |
| After `session.chargeContext` (100% 메디캐시), before `session.result` | Narrow window. Session expires per BE timer policy — **no recovery on the plugin side**. Plugin re-mounts `home.html` on reconnect; backend's terminal state stands. |
| After `session.result` (100% 메디캐시) | Session is already terminal. Disconnect is irrelevant. |

**On plugin reconnect during an in-flight session:** backend does **NOT** send `session.reconcile`. The plugin has no recovery responsibility — the card path is fully owned by CRM↔NICE, and the 100% 메디캐시 path is best-effort one-shot.

### 7.2 Aborts (design doc §6)

| Scenario | Plugin's role |
|---|---|
| CRM aborts before plugin claims (CREATED) | Plugin never receives `session.dispatch` (plugin is never connected to a CREATED session). No-op for plugin. |
| CRM aborts after dispatch but before claim is en route (DISPATCHED) | BE → Plugin: `session.abort(reason: "ABORTED_BY_CRM")` arrives on `home.html` (or `order.html` if races). Plugin navigates to `home.html` via `location.href` (toast on `order.html` — existing `session.abort` handler in `order.html`). Valid only in DISPATCHED. |
| User backs out during medicash UI (post-claim, pre-`chargeContext`) | Plugin sends `session.abort(reason: "USER_BACKED_OUT")` over WS B. Back to `home.html`. (`sendAbortAndGoHome` helper in `order.html`.) |
| CRM aborts during NICE phase (post-`chargeContext`, card path) | **Out-of-band on CRM↔NICE.** CRM then relays `session.result(status: CANCELED)` over WS A to BE. Plugin is **not** notified; firmware closes the 통합결제창 on its own. |
| User attempts to abort during card phase | **Not possible.** Toss firmware's 통합결제창 owns the screen; plugin has no UI to surface a back button. |

### 7.3 Timeout

- **DISPATCHED > 30s, no `session.claim`** → BE terminates as `FAILED / PLUGIN_UNRESPONSIVE`. Plugin learns nothing directly; on reconnect it just waits for next dispatch.
- **IN_PROGRESS > extended timeout (recommended ≥180s)** → BE terminates as `EXPIRED`. Plugin learns nothing directly. Exact timeout value is a backend-owned open item (see §9).

### 7.4 NICE-side failure (card path)

Card declined, VAN error, NICE offline, etc.: NICE → CRM → BE: `session.result(status: FAILED, niceResponse: {…})`. BE persists, does **not** deduct medicash. Plugin is **not** notified; firmware closes 통합결제창 and auto-`setIdle`s the device.

### 7.5 Late CRM `session.result` after BE EXPIRED

If CRM relays a NICE-terminal `session.result` (SUCCEEDED / FAILED / CANCELED) *after* BE has already marked the session EXPIRED, BE rejects it with `error: INVALID_STATE` (per `toss-payment-flow.md §11`) and does not mutate session state. CRM must not retry. If NICE actually approved (orphan card charge), CRM owns recovery via the **pre-existing CRM↔NICE refund mechanism** (design doc §3.3) — refund flow is entirely out of scope for this contract.

The plugin is **not** involved in either the rejection or any subsequent recovery. By the time this scenario fires, the plugin has long since returned to `home.html` waiting for the next `session.dispatch`. No plugin code path is needed.

> Orphaned NICE Recovery (formerly a separate sub-flow) is **gone** — it is now subsumed under design doc §3.3's "pre-existing CRM↔NICE refund mechanism." There is no `refund.create` against EXPIRED with CRM-supplied `niceResponse` in the NICE-paired contract; the pre-existing refund infrastructure handles it.

### 7.6 Plugin receives an `error` frame for a plugin-originated message

If BE responds to a plugin-originated message (e.g., `session.chargeContext`, `session.claim`, `session.result`) with an `error` frame per `toss-payment-flow.md §11`:

- Plugin surfaces a toast via `sdk.template.openToast` describing the failure (e.g., showing `error.payload.message`).
- Plugin navigates to `home.html` via `location.href`. The session is unrecoverable from plugin side.
- Plugin does **NOT** retry. BE has already terminated the session if the error was substantive.

See design doc §6 ("Plugin receives an `error` frame for a plugin-originated message").

### 7.7 Plugin reconnect after BE EXPIRED

When the plugin reconnects after BE has already marked an in-flight session EXPIRED:

- BE acks `device.register` with `device.registered`.
- BE does **NOT** send `session.dispatch` for the EXPIRED session.
- Plugin remains idle on `home.html` waiting for a new `session.dispatch`.

See design doc §6 ("Plugin reconnect after BE EXPIRED").

### 7.8 메디캐시 deduction failure on SUCCEEDED (informational only)

If BE encounters a Hospital-side 메디캐시 deduction failure after terminal SUCCEEDED, BE will emit a CRM-side `error` frame with code `MEDICASH_DEDUCT_PENDING` and async-retry the deduction. **The plugin is not involved** — this failure mode is invisible to the plugin and doesn't change the SUCCEEDED flow on the Toss Front side. Documented here for completeness; no plugin code path required. See design doc §6 ("Medicash deduction failure on SUCCEEDED").

---

## 8. What's removed vs legacy (cleanup-planning input)

For the frontend team's cleanup execution plan. All paths absolute from repo root.

> Code locations referenced by function/section name to avoid line-number drift as cleanup commits land.

**WS B contract — plugin-side removals (design doc §7):**

- `session.proceed` listener handling (was the `session.proceed` case in the `order.html` WS B message handler)
- `session.reconcile` handler (was the `session.reconcile` handler in `home.html`)
- `getPayment` recovery path
- `pendingPayment` storage write + `runPendingPaymentRecovery` call
- `AWAITS_PROCEED` feature flag + waiting screen
- All `sdk.payment.*` SDK calls
- `session.dispatch(kind: "cancel")` handler arm

**Plugin code removals (concrete sites):**

- [`front-plugin-js/payment.html`](../front-plugin-js/payment.html) — the `runPayment` non-zero-charge branch including the `sdk.payment.requestPayment` call, retry/error pages, `mapTossFailureToKorean`, `mapPaymentMethodToKorean` (if no longer needed on the 100% medicash branch), and the `pendingPayment` storage write.
- [`front-plugin-js/payment.html`](../front-plugin-js/payment.html) — the `runCancel` function in its entirety and its dispatcher arm (the `dispatch.kind === "cancel"` branch in the WS B message handler).
- [`front-plugin-js/home.html`](../front-plugin-js/home.html) — the `runPendingPaymentRecovery` invocation from `ws.onopen`, the `recoveredSessions` Set, the `recoveryReady` promise, and the `session.reconcile` handler.
- [`front-plugin-js/home.html`](../front-plugin-js/home.html) — the `dispatch.kind === "cancel"` arm inside the `session.dispatch` handler.
- [`front-plugin-js/order.html`](../front-plugin-js/order.html) — the `renderWaitingScreen()` function, the `waitingForProceed` state variable, the `AWAITS_PROCEED` gate around the waiting-screen render, and the `session.proceed` case in the WS B message handler.
- [`front-plugin-js/config.js`](../front-plugin-js/config.js) — the `AWAITS_PROCEED` constant, the `PENDING_KEY` constant, and the `runPendingPaymentRecovery` function.

**Spec doc removals (design doc §7):**

- [`docs/superpowers/specs/toss-payment-flow.md` §5.5](./superpowers/specs/toss-payment-flow.md) (`session.proceed` contract) — obsolete.
- [`docs/superpowers/specs/toss-payment-flow.md` §9](./superpowers/specs/toss-payment-flow.md) (timeout-and-reconcile sub-flow) — partially obsolete; the IN_PROGRESS timeout concept survives but reconcile is gone.

---

## 9. Open items / TBDs (frontend-touching only)

From design doc §8. Only items that touch the plugin are listed here; backend/CRM-only items are not the plugin's concern.

| Item | Owner | Plugin impact |
|---|---|---|
| Exact IN_PROGRESS timeout value (recommended 180s) | Backend | Plugin observes nothing directly. Affects how long a user can sit on the medicash UI before backend expires. No plugin code change either way. |
| `niceResponse` envelope shape (vendor-specific) | CRM + Backend | None — plugin never receives `niceResponse`. |
| Cleanup of obsolete plugin code (separate execution plan) | **Frontend** | This is our action item. See §8 for the concrete file/line inventory. |

No other TBDs in design doc §8 touch the frontend.

---

## 10. References

- **Design doc (authoritative):** [docs/superpowers/specs/2026-05-12-nice-paired-final-flow-design.md](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)
- **Sibling MDs:**
  - [docs/payment-flow-with-nice-terminal-backend.md](./payment-flow-with-nice-terminal-backend.md)
  - [docs/payment-flow-with-nice-terminal-crm.md](./payment-flow-with-nice-terminal-crm.md)
- **Existing WS B protocol spec (legacy reference — being trimmed per §8):** [docs/superpowers/specs/toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md)
- **Plugin source:**
  - [front-plugin-js/home.html](../front-plugin-js/home.html)
  - [front-plugin-js/order.html](../front-plugin-js/order.html)
  - [front-plugin-js/payment.html](../front-plugin-js/payment.html)
  - [front-plugin-js/settings.html](../front-plugin-js/settings.html)
  - [front-plugin-js/config.js](../front-plugin-js/config.js)
  - [front-plugin-js/sdk.js](../front-plugin-js/sdk.js)
