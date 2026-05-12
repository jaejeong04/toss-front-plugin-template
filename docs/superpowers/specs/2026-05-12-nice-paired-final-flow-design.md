# NICE-paired Toss Front Payment Flow — Final Design

> **Status:** Approved 2026-05-12 by user (jaejeong). This is the converged design after confirmation from Toss (Slack thread `C0ANAJW463E` parent ts `1778460158.013389`) that NICE 카드 단말기 + 토스 프론트 operates in **시리얼통신 기반 리더기 모드**. Supersedes the 2026-05-08 feasibility review at [docs/payment-flow-with-nice-terminal.md](../../payment-flow-with-nice-terminal.md).
>
> This design seeds three role-specific source-of-truth MDs:
>
> - [docs/payment-flow-with-nice-terminal-frontend.md](../../payment-flow-with-nice-terminal-frontend.md)
> - [docs/payment-flow-with-nice-terminal-backend.md](../../payment-flow-with-nice-terminal-backend.md)
> - [docs/payment-flow-with-nice-terminal-crm.md](../../payment-flow-with-nice-terminal-crm.md)
>
> No flow changes after this document is signed off.

---

## 0. Confirmed Architecture (from Toss, 2026-05-12)

- **NICE 카드 단말기** performs the actual card payment (VAN, approval, receipt) — unchanged from legacy.
- **Toss Front** acts as a **card reader** for NICE in 리더기 모드: passes IC/barcode data to NICE via a VAN module on Toss Front firmware over serial.
- The VAN module operates on a 밴사-defined 전문 (predefined protocol). The plugin web layer **cannot** observe or control this channel.
- During card payment, Toss firmware **automatically overlays the plugin screen with its own 통합결제창**.
- On payment completion, Toss firmware **automatically `setIdle`s** the Toss Front device.
- Therefore: **the custom plugin does NOT handle any card-payment logic** — no `sdk.payment.requestPayment`, no `requestPaymentCancel`, no `getPayment` recovery, no waiting screen, no result UI for card payments.

The plugin's responsibility shrinks to (a) 메디캐시 selection UI + `session.chargeContext` send for all sessions, and (b) the 100% 메디캐시 success branch (plugin-mediated, since firmware doesn't intervene when no card payment occurs).

**Refund scope:** Refunds are NOT covered by this design (see §3.3). Both card refunds and 메디캐시 reversals are handled by pre-existing infrastructure — the CRM↔NICE refund channel for card-side, and the pre-existing backend 메디캐시 reversal mechanism for 포인트-side. The plugin is never involved in refund. The NICE-paired contract additions on WS A do **not** include any refund-related messages.

---

## 1. Topology

| Channel | Endpoints | Notes |
|---|---|---|
| **WS B** | Plugin ↔ Core (BE) | `wss://<core>/ws/plugin?serial=<deviceSerialNumber>&token=<coreToken>` — simplified message set |
| **WS A** | CRM ↔ Core (BE) | `wss://<core>/ws/crm?token=<workstationToken>` — extended with new messages for NICE coordination |
| **HTTP (Core public)** | CRM/Plugin → Core | Existing endpoints unchanged |
| **Internal Feign** | Core ↔ Hospital | Existing internal API unchanged |
| **CRM ↔ NICE 카드 단말기** | Out-of-band | Pre-existing CRM↔NICE protocol — opaque to BE/Plugin, not specified in our MDs |
| **NICE 단말기 ↔ Toss Front firmware** | Serial / VAN module | Toss + 밴사 territory — opaque to our entire stack |

dev core host: `develop.api.core.smartdoctor.systems`.
release core host: `release.api.core.smartdoctor.systems`.

---

## 2. Session State Machine

States: `CREATED → DISPATCHED → IN_PROGRESS → {SUCCEEDED | FAILED | CANCELED | EXPIRED}`.

| From | To | Trigger | Origin |
|---|---|---|---|
| (new) | CREATED | `session.create` | CRM |
| CREATED | DISPATCHED | `session.dispatch` sent | BE |
| CREATED | CANCELED | `session.abort` | CRM |
| CREATED | FAILED (`DEVICE_OFFLINE`) | 10s grace expired, plugin never registered | BE timer |
| DISPATCHED | IN_PROGRESS | `session.claim` | Plugin |
| DISPATCHED | CANCELED | `session.abort` | CRM |
| DISPATCHED | FAILED (`PLUGIN_UNRESPONSIVE`) | 30s, no claim | BE timer |
| IN_PROGRESS | SUCCEEDED (100% 메디캐시) | `session.result(tossResponse: null)` | Plugin |
| IN_PROGRESS | SUCCEEDED (card) | `session.result(niceResponse, SUCCEEDED)` | CRM (WS A) |
| IN_PROGRESS | FAILED (card) | `session.result(niceResponse, FAILED)` | CRM |
| IN_PROGRESS | CANCELED (during medicash UI) | `session.abort(USER_BACKED_OUT)` | Plugin |
| IN_PROGRESS | CANCELED (NICE-side abort) | `session.result(CANCELED)` | CRM |
| IN_PROGRESS | EXPIRED | Timeout (post-`chargeContext` extended window, BE timer policy TBD) | BE timer |

**Critical contract change** vs. legacy: after `session.claim`, the plugin path is no longer abortable. CRM aborts NICE-side via the CRM↔NICE channel, then relays the outcome via `session.result(CANCELED)` over WS A. The plugin's only IN_PROGRESS abort window is the medicash selection phase.

**IN_PROGRESS timeout policy**: legacy spec set `timeoutMs + 30s` ≈ 90s. With NICE in the loop, this is too short (customer fumbling, multiple card attempts). Backend team must extend the timer. Recommended floor: 180s. Exact value documented in the backend MD.

**Legacy `TIMEOUT` terminal state**: the legacy `toss-payment-flow.md` schema includes a `TIMEOUT` terminal state distinct from `EXPIRED`. In the NICE-paired contract, `TIMEOUT` is retained in the persistence schema for backward compatibility but is never emitted by the new state machine. Timeout-induced terminations use the table's normal terminal states: `FAILED (PLUGIN_UNRESPONSIVE)` for DISPATCHED-side timeouts (plugin never claims within 30s), `EXPIRED` for IN_PROGRESS-side timeouts (extended NICE wait window exceeded).

---

## 3. End-to-End Flows

### 3.1 Card-payment happy path

```
CRM → BE          session.create
BE → Hospital     POST /internal/toss-payment/sessions  (CREATED)
BE → CRM          session.ack (CREATED)
BE → Plugin       session.dispatch                              [simplified — see §5]
BE → Hospital     PATCH .../status (DISPATCHED)
BE → CRM          session.status (DISPATCHED)

Plugin → BE       session.claim
BE → Hospital     PATCH .../status (IN_PROGRESS)
BE → CRM          session.status (IN_PROGRESS)

[Plugin renders 메디캐시 selection UI]
[Customer selects amount, clicks 결제]

Plugin → BE       session.chargeContext (charged > 0)
BE → Hospital     PATCH .../charge-context
BE → CRM          session.chargeContext (forward)               [NEW: BE→CRM direction]

CRM → NICE        dispatch card payment (existing CRM↔NICE)

[NICE ↔ Toss Front firmware: VAN/serial — opaque]
[Toss firmware overlays plugin screen with 통합결제창]
[NICE processes card, gets approval]

NICE → CRM        card payment result (existing CRM↔NICE)
CRM → BE          session.result (niceResponse, status=SUCCEEDED)  [NEW: CRM→BE direction]
BE → Hospital     PATCH .../result (SUCCEEDED, persist niceResponse, deduct medicash if pointUseAmount > 0)
BE → CRM          session.result (terminal echo)

[Toss firmware: auto-setIdle on Toss Front]
[Plugin: next page load returns to home.html]
```

### 3.2 100% 메디캐시 happy path (A1)

```
[Same up to Plugin → BE: session.chargeContext]

Plugin → BE       session.chargeContext (chargedSupplyValue=0, chargedTax=0, pointUseAmount=total)
BE → Hospital     PATCH .../charge-context
BE → CRM          session.chargeContext (forward, with 0 charge)
CRM:              detects 0 charge → does NOT dispatch to NICE

Plugin → BE       session.result (tossResponse=null)             [back-to-back with chargeContext]
BE → Hospital     PATCH .../result (SUCCEEDED, deduct medicash via RCPT_INFO.DC_AMT)
BE → CRM          session.result (status=SUCCEEDED, tossResponse=null)

[Plugin renders custom 100% 메디캐시 success screen]
[Plugin navigates to home.html via location.href (not sdk.app.setIdle to avoid blank-screen lifecycle bug)]
```

### 3.3 Refunds — out of scope (use pre-existing CRM↔NICE mechanism)

Refunds are **not specified** by this design. Both card refunds and 메디캐시 reversals are handled by the **pre-existing CRM↔NICE refund flow** plus the pre-existing backend 메디캐시 reversal mechanism (separate from this contract). No refund-related messages are introduced on WS A or WS B by the NICE-paired contract; the plugin is not involved in any refund path.

This decision avoids reinventing a flow that already worked in production prior to NICE-Toss pairing. The teams must continue to use their existing refund + 메디캐시 reversal infrastructure for any session reversal — including the orphan-charge case where a session was BE-EXPIRED but NICE actually approved.

---

## 4. Wire Contracts

### 4.1 WS B (Plugin ↔ BE)

**Plugin → BE:**

| Message | Purpose | Trigger |
|---|---|---|
| `device.register` | Plugin registers serial after Toss SDK reports `getSerialNumber` | Plugin connect |
| `session.claim` | Plugin engaged with order/medicash UI; DISPATCHED → IN_PROGRESS | Entering order page |
| `session.chargeContext` | Discounted amount after medicash selection | User clicks 결제 |
| `session.result` | 100% 메디캐시 success only; payload has `tossResponse: null` and `chargedSupplyValue: 0`, `chargedTax: 0` | Immediately after `chargeContext` when 0-charge |
| `session.abort` | User backed out of medicash UI (`reason: "USER_BACKED_OUT"`) | Plugin order-page back/dismiss |

**BE → Plugin:**

| Message | Purpose |
|---|---|
| `device.registered` | Ack for `device.register` |
| `session.dispatch` | Start new session — payload simplified (see §5) |
| `session.abort` | CRM-driven abort relayed (only valid when session is DISPATCHED — plugin is never connected to a CREATED session). Carries `reason: "ABORTED_BY_CRM"` |
| `error` | Per existing §11 error frame contract |

**REMOVED from legacy WS B contract:**

- `session.reconcile` (Plugin → BE response too) — no recovery needed; no Toss SDK payment exists to recover
- `session.proceed` (BE → Plugin) — plugin doesn't need to wait; firmware handles transition
- `session.dispatch (kind: cancel)` — refund no longer involves plugin

### 4.2 WS A (CRM ↔ BE)

**CRM → BE:**

| Message | Status | Purpose |
|---|---|---|
| `session.create` | Existing, unchanged | Start a new session |
| `session.abort` | Existing | Abort, valid only in CREATED/DISPATCHED |
| `session.result` | **NEW** | Relay NICE-side card payment outcome; payload has `status`, `niceResponse` |

**BE → CRM:**

| Message | Status | Purpose |
|---|---|---|
| `session.ack` | Existing | Ack for `session.create` |
| `session.status` | Existing | `DISPATCHED`, `IN_PROGRESS` transitions only (terminal states — `SUCCEEDED` / `FAILED` / `CANCELED` / `EXPIRED` — are delivered via `session.result`) |
| `session.chargeContext` | **NEW** | Forward plugin's chargeContext to CRM — CRM decides NICE dispatch based on `chargedSupplyValue + chargedTax` (>0 = dispatch; ==0 = skip) |
| `session.result` | Existing | Terminal echo (SUCCEEDED/FAILED/CANCELED/EXPIRED) |
| `session.abort.ack` | Existing | Ack for `session.abort` |
| `error` | Existing | Per §11 |

**No ack required for `session.chargeContext` (BE → CRM):** CRM does not ack the forwarded `session.chargeContext`. CRM's subsequent NICE dispatch (when `chargedSupplyValue + chargedTax > 0`) or absence thereof (when `== 0`, the 100% 메디캐시 case) is the implicit ack.

**Refund messages on WS A:** None defined in this contract. Refund flow follows the pre-existing CRM↔NICE mechanism (§3.3). Legacy `refund.*` messages from `toss-payment-flow.md §10` are not used in the NICE-paired flow.

### 4.3 Message envelope details

**`session.dispatch` (BE → Plugin) — simplified:**

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

Dropped from legacy: `kind`, `paymentKey`, `timeoutMs`, `excludePaymentTypes`. These were all Toss-SDK-specific.

**`session.chargeContext` (Plugin → BE, then BE → CRM — same envelope):**

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

Backend validates: `pointUseAmount + chargedSupplyValue + chargedTax + tip == original total`.

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

**`session.result` (CRM → BE — card path):**

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "SUCCEEDED",
    "niceResponse": {
      "paymentMethod": "CARD",
      "approvalNumber": "30021105",
      "approvalTimestamp": 1761284938000,
      "card": { /* vendor-specific NICE response fields */ }
    }
  }
}
```

For `FAILED`/`CANCELED`, `niceResponse` may carry `reason` / vendor error data.

**`session.result` (BE → CRM — terminal echo):**

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "SUCCEEDED",
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636,
    "amount": { "supplyValue": 27273, "tax": 2727, "tip": 0 },
    "niceResponse": { /* persisted */ } | null,
    "tossResponse": null
  }
}
```

`tossResponse` is retained only for backward compatibility with the legacy contract; it is always `null` in the NICE-paired flow. The legacy `late` field is dropped — `session.reconcile` no longer exists, so `late: true` cannot occur.

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

Sent only when CRM aborts a session that is currently DISPATCHED. Plugin should navigate to `home.html` via `location.href` (do **not** call `sdk.app.setIdle()` — known blank-screen lifecycle bug).

**`failureReason` field on `session.result` (BE → CRM terminal echo):**

For non-SUCCEEDED terminal states, the terminal echo payload includes a top-level `failureReason` field. Recognized values:

- `"USER_BACKED_OUT"` — plugin-driven abort during medicash UI
- `"ABORTED_BY_CRM"` — CRM-driven abort
- `"PLUGIN_UNRESPONSIVE"` — 30s no-claim timeout in DISPATCHED
- `"DEVICE_OFFLINE"` — 10s grace expired in CREATED (plugin never registered)
- `"EXPIRED"` — IN_PROGRESS timeout
- NICE-supplied reason for `FAILED`/`CANCELED` arriving via CRM relay

This carries forward the legacy `toss-payment-flow.md` envelope convention.

**Refund envelopes:** Not defined here. Refund flow is out of scope (see §3.3). Pre-existing CRM↔NICE refund flow + pre-existing backend 메디캐시 reversal mechanism apply.

---

## 5. Plugin Pages & Behavior

Existing pages remain, with simplified scope:

| File | Role in new flow |
|---|---|
| `home.html` | Idle dispatcher. WS B connect + auto-reconnect. Listens for `session.dispatch` → navigates to `order.html`. Removes pendingPayment recovery, `session.reconcile` handling, cancel-dispatch routing. |
| `order.html` | Sends `session.claim` on enter. Renders custom 메디캐시 selection UI (post-5/11 design). On submit: sends `session.chargeContext`. If `chargedSupplyValue + chargedTax > 0` (card path): plugin stays idle on whatever screen the customer last interacted with — firmware will auto-overlay 통합결제창. If 0-charge: navigate to `payment.html`. Removes waiting screen, `AWAITS_PROCEED` flag, `session.proceed` handling. |
| `payment.html` | **Only handles 100% 메디캐시 success branch.** Sends `session.result(tossResponse: null)`, renders custom success screen, navigates to `home.html` via `location.href` (not `sdk.app.setIdle()` — known blank-screen lifecycle bug). Removes all `sdk.payment.*` calls. |
| `settings.html` | Unchanged |
| `config.js` | Removes `AWAITS_PROCEED`, `PENDING_KEY`, `runPendingPaymentRecovery` |
| `sdk.js` | Unchanged |

**Toss SDK methods used by plugin (full list):**

- `sdk.app.getSerialNumber()` — for `device.register`
- `sdk.app.getMerchant()` — for merchant info display
- `sdk.app.setIdle()` — only in `home.html` (idle screen mount)
- `sdk.app.isDebugMode()` — for dev flags
- `sdk.storage.get/set/remove` — for transient page state (not for pendingPayment recovery anymore)
- `sdk.template.renderUsePointPage` — **NOT used** (replaced with custom HTML per 5/11 commit `7f98300`)
- `sdk.template.renderOrderPage` — usage TBD per implementation; may be kept or replaced with custom HTML
- `sdk.template.renderResultPage` — **NOT used** (firmware handles for card; custom HTML for 100% medicash)

**Removed entirely:**

- `sdk.payment.requestPayment`
- `sdk.payment.requestPaymentCancel`
- `sdk.payment.getPayment`

---

## 6. Edge Cases

### Plugin disconnects

| When | Behavior |
|---|---|
| After register, before claim | DISPATCHED → FAILED (`PLUGIN_UNRESPONSIVE`) after 30s grace |
| After claim, before chargeContext | IN_PROGRESS → EXPIRED after timeout |
| After chargeContext (card path) | Irrelevant — CRM→NICE→CRM→BE continues; session terminates normally on CRM's `session.result` |
| After chargeContext (100% 메디캐시), before `session.result` | Narrow window. Session expires (no recovery). |
| After `session.result` (100% 메디캐시) | Irrelevant — session already terminal |

**On plugin reconnect during an in-flight session:** BE does NOT send `session.reconcile`. For card-path sessions, the plugin has no further role. The plugin reverts to home and waits for the next session.

### Aborts

| Scenario | Path |
|---|---|
| CRM aborts before plugin claims (CREATED or DISPATCHED) | `session.abort` (CRM→BE) → BE marks CANCELED → `session.abort.ack` + `session.result(CANCELED, failureReason: "ABORTED_BY_CRM")` to CRM; if state was DISPATCHED, BE additionally relays `session.abort(reason: "ABORTED_BY_CRM")` to plugin → plugin navigates to `home.html` |
| User backs out during medicash UI (post-claim, pre-chargeContext) | `session.abort(USER_BACKED_OUT)` (Plugin→BE) → BE marks CANCELED → `session.result(CANCELED, USER_BACKED_OUT)` to CRM |
| CRM aborts during NICE phase | Out-of-band on CRM↔NICE channel. CRM then sends `session.result(status=CANCELED)` over WS A to BE. Plugin is not notified; firmware closes 통합결제창 on its own. |
| User attempts abort during card phase | **Not possible** — Toss firmware's 통합결제창 owns the screen; plugin has no UI to dismiss |

### Timeout (BE-side)

- DISPATCHED > 30s, no claim → `FAILED / PLUGIN_UNRESPONSIVE`
- IN_PROGRESS > (extended timeout) → `EXPIRED`
  - **Recommended IN_PROGRESS timeout: 180s.** Backend team to confirm exact value during implementation. Must be long enough to accommodate NICE-side card handling (multiple card insertion attempts, customer hesitation, slow VAN response).

### NICE-side failure

- Card declined / VAN error / NICE offline → NICE reports failure to CRM via existing CRM↔NICE channel
- CRM → BE: `session.result(status=FAILED, niceResponse={…error data…})`
- BE marks FAILED, persists niceResponse, does NOT deduct medicash
- BE → CRM: `session.result` terminal echo with `status=FAILED` and `failureReason` set from NICE data

### Late CRM `session.result` after BE EXPIRED

If CRM relays NICE's terminal result (`SUCCEEDED` / `FAILED` / `CANCELED`) *after* BE has already marked the session EXPIRED:

- BE rejects the late `session.result` with `error: INVALID_STATE` per the `toss-payment-flow.md §11` error frame contract.
- BE does **NOT** mutate the session record (state stays EXPIRED).
- CRM **must not retry** the send.
- If NICE in fact approved (orphan card charge), CRM owns recovery via the **pre-existing CRM↔NICE refund mechanism** (§3.3) — including pre-existing 메디캐시 reversal infrastructure. This design does not specify a recovery contract.

### Medicash deduction failure on SUCCEEDED

If BE receives a terminal `session.result` (SUCCEEDED) — either Plugin→BE (100% 메디캐시) or CRM→BE (card path) — and the Hospital Feign call to deduct 메디캐시 fails:

- BE persists the session as SUCCEEDED in Hospital DB regardless (for the card path, NICE has already approved and we cannot unwind it; for 100% 메디캐시, the terminal state is the only source of truth).
- BE retries the 메디캐시 deduction asynchronously with exponential backoff, up to a backend-configurable retry cap (suggested: 5 attempts over ~30 minutes).
- If still failing after the cap, BE escalates to manual reconciliation owned by the backend team.
- BE emits an `error` frame to CRM with code `MEDICASH_DEDUCT_PENDING` so the operator can flag for follow-up.
- The terminal `session.result` echo to CRM still fires with `status=SUCCEEDED` (the payment did succeed); the 메디캐시 deduction is a separate operational concern that does not block bookkeeping closure.

### Plugin receives an `error` frame for a plugin-originated message

If BE responds to a plugin-originated message (e.g., `session.chargeContext`, `session.claim`, `session.result`) with an `error` frame per `toss-payment-flow.md §11`:

- Plugin surfaces a toast via `sdk.template.openToast` describing the failure (e.g., showing `error.payload.message`).
- Plugin navigates to `home.html` via `location.href` — the session is unrecoverable from the plugin side.
- Plugin does **NOT** retry the message. BE has already terminated the session (or rejected the request as invalid); retrying would error again or no-op.

### Plugin reconnect after BE EXPIRED

When the plugin reconnects after BE has already marked an in-flight session EXPIRED:

- BE acks `device.register` with `device.registered`.
- BE does **NOT** send `session.dispatch` for the EXPIRED session — that session is terminal.
- Plugin remains idle on `home.html` waiting for a new `session.dispatch`.
- The operator is informed of the EXPIRED outcome via the CRM-side `session.result(EXPIRED)` terminal echo (independent of plugin presence).

---

## 7. What's Removed vs. Legacy Contract

For audit clarity:

**WS B plugin-side removals:**
- `session.proceed` listener
- `session.reconcile` handler + `getPayment` recovery
- `pendingPayment` storage + `runPendingPaymentRecovery`
- `AWAITS_PROCEED` feature flag + waiting screen
- All `sdk.payment.*` SDK calls
- `session.dispatch(kind=cancel)` handler

**WS A changes:**
- **New (added for NICE-paired flow):** `session.chargeContext` (BE→CRM, forward direction), `session.result` (CRM→BE direction, for NICE result relay).
- **Removed/not extended:** No refund-related WS A extensions. The entire refund flow uses the pre-existing CRM↔NICE mechanism (§3.3); the legacy `refund.*` messages from `toss-payment-flow.md §10` are not used in the NICE-paired flow.

**Plugin code removals:**
- `payment.html` `sdk.payment.requestPayment` flow (only 100% 메디캐시 path retained)
- `payment.html` `sdk.payment.requestPaymentCancel` flow (refund out of scope per §3.3)
- `config.js` `runPendingPaymentRecovery`, `PENDING_KEY`
- `order.html` waiting screen, `AWAITS_PROCEED` gate, `session.proceed` listener

**Spec doc obsolescence (carried in `toss-payment-flow.md` banner):**
- `toss-payment-flow.md §5.5` (session.proceed contract) — obsolete
- `toss-payment-flow.md §9` (timeout-and-reconcile sub-flow) — partially obsolete (timeout policy remains; reconcile removed)
- `toss-payment-flow.md §10` (legacy plugin-side refund flow) — obsolete; refund handled by pre-existing CRM↔NICE per §3.3

---

## 8. Open Items (Non-Blocking for MD Writing)

These are implementation details for individual teams, not flow-level decisions:

| Item | Owner |
|---|---|
| Exact IN_PROGRESS timeout value (recommended 180s floor) | Backend |
| Exact `niceResponse` envelope shape for FAILED/CANCELED payment variants (only SUCCEEDED example is concrete in §4.3; CRM + Backend must converge on field shape before implementation kickoff) | CRM + Backend |
| Whether `session.status` IN_PROGRESS gets a sub-status for "awaiting NICE" (cosmetic, doesn't affect contract) | Backend |
| CRM-side logic for detecting 100% 메디캐시 from `session.chargeContext(0, 0)` | CRM |
| Exact retry/backoff/escalation policy for 메디캐시 deduction failure on SUCCEEDED (§6) | Backend |
| Cleanup of obsolete plugin code (separate execution plan) | Frontend |

---

## 9. Acceptance Criteria for Source-of-Truth MDs

Each role-specific MD must:

1. Describe its role's responsibilities completely (no "see other doc" punts for in-scope behavior)
2. Enumerate every message it sends and receives, with example envelopes
3. Cover happy path + edge cases (disconnect, abort, timeout, failure)
4. Be self-consistent with this design doc — no contradictions
5. Mark anything explicitly TBD with a clear flag and owner

The head-reviewer agent will cross-check all three MDs against this document and against each other.
