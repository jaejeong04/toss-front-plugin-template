# Payment Flow with NICE Terminal — Backend Role

> **Status:** Finalized 2026-05-12. Superseded by no document.
>
> **Master design (source of truth):** [docs/superpowers/specs/2026-05-12-nice-paired-final-flow-design.md](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)
>
> **Legacy contract (still in effect for unchanged surfaces):** [docs/superpowers/specs/toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md)
>
> **Superseded:** the 2026-05-08 feasibility review previously embedded in this file (compiled 2026-05-08) is OBSOLETE. The four-party feasibility doc at `docs/payment-flow-with-nice-terminal.md` and the legacy backend doc concepts (Option A / Option B sub-states, plugin-driven `session.result` for card payments, `session.reconcile` recovery for NICE-paired flows, plugin-mediated refund cancel dispatch) no longer apply for the NICE-paired flow.
>
> **Audience:** backend engineer (Core / Spring Boot module).
> **Scope:** backend-only. Frontend and CRM roles live in sibling docs.

---

## 1. Backend's role in the NICE-paired flow

Backend (Core) remains the **orchestrator and single source of truth for session state**. The 2026-05-12 confirmation from Toss (Slack thread `C0ANAJW463E`, parent ts `1778460158.013389`) — that NICE 카드 단말기 + Toss Front operates in **시리얼통신 기반 리더기 모드** with VAN module + 통합결제창 firmware overlay — narrows Backend's plugin-facing surface but expands its CRM-facing surface.

Concretely, Backend now:

1. Owns session state (CREATED → DISPATCHED → IN_PROGRESS → terminal) and persists every transition to Hospital DB via existing Feign endpoints.
2. Dispatches a **simplified** `session.dispatch` to the plugin (no `kind`, no `paymentKey`, no `timeoutMs`, no `excludePaymentTypes`).
3. Receives `session.chargeContext` from plugin (post-메디캐시 selection) and **forwards** it to CRM over WS A so CRM can decide whether to dispatch to NICE.
4. For card payments, expects the terminal `session.result` from **CRM** (relayed from NICE via the out-of-band CRM↔NICE channel), **not** from the plugin.
5. For 100% 메디캐시 payments, accepts a plugin-originated `session.result(tossResponse: null)` as terminal (legacy behavior, retained).
6. Owns the IN_PROGRESS timeout for NICE-paired sessions — the legacy `timeoutMs + 30s` ≈ 90s policy is **replaced** by a backend-owned extended timer (recommended 180s).
7. Emits graceful `error` frames per the existing §11 error frame contract; scope rules carry forward unchanged.

**Refund flow is out of scope** (use pre-existing CRM↔NICE refund mechanism + pre-existing 메디캐시 reversal infrastructure — see [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)). No refund-related messages are introduced on WS A or WS B by the NICE-paired contract.

Backend does NOT:

- Receive `session.result` from the plugin for card payments (NICE-paired) — that surface is REMOVED.
- Send `session.proceed` to the plugin — REMOVED.
- Send `session.reconcile` to the plugin during recovery for NICE-paired sessions — REMOVED.
- Send `session.dispatch(kind=cancel)` to the plugin for refunds — REMOVED.
- Orchestrate refunds — refund flow is out of scope (see [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)); pre-existing CRM↔NICE refund channel + pre-existing 메디캐시 reversal mechanism are used instead.
- Observe, control, or interpret anything on the NICE↔Toss-Front-firmware serial / VAN-module channel.

---

## 2. Endpoints

### 2.1 Core Public API (HTTP)

Unchanged from [toss-payment-flow.md Endpoint Map](./superpowers/specs/toss-payment-flow.md):

- `POST /toss-payments/sessions`
- `GET /toss-payments/sessions/{sessionId}`
- `GET /toss-payments/sessions/reconcile-targets?deviceSerialNumber=...` *(retained for legacy/recovery introspection; not used by NICE-paired flow)*
- `GET /toss-payments/sessions/dispatch-targets?deviceSerialNumber=...`
- `PATCH /toss-payments/sessions/{sessionId}/status`
- `PATCH /toss-payments/sessions/{sessionId}/charge-context`
- `PATCH /toss-payments/sessions/{sessionId}/result`
- `POST /toss-payments/sessions/{sessionId}/abort`

Refund endpoints (`POST /toss-payments/refunds`, `PATCH /toss-payments/refunds/{refundId}/result`) are out of scope for this MD — refund flow uses pre-existing CRM↔NICE infrastructure per [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md).

### 2.2 Core WebSocket

- **WS A (CRM ↔ Core):** `wss://<core>/ws/crm?token=<workstationToken>` — extended message set (new for NICE-paired flow: `session.chargeContext` BE→CRM, `session.result` CRM→BE). No refund-related extensions.
- **WS B (Plugin ↔ Core):** `wss://<core>/ws/plugin?serial=<deviceSerialNumber>&token=<coreToken>` — simplified message set (see §4).

### 2.3 Hosts

- dev: `develop.api.core.smartdoctor.systems`
- release: `release.api.core.smartdoctor.systems`

---

## 3. Session State Machine

States: `CREATED → DISPATCHED → IN_PROGRESS → {SUCCEEDED | FAILED | CANCELED | EXPIRED}`.

Note (per [design doc §2](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)): `TIMEOUT` is **retained in the persistence schema for backward compatibility but never emitted by the new state machine**. All timeout terminations use `EXPIRED`. The DISPATCHED-state 30s wait-for-claim expiry is not a timeout in this sense — it's a `FAILED / PLUGIN_UNRESPONSIVE` failure with its own reason code; only the IN_PROGRESS extended-timer expiry produces a true timeout termination, and that termination is `EXPIRED`.

| From | To | Trigger | Originator | Hospital DB effect (Feign) |
|---|---|---|---|---|
| (new) | `CREATED` | `session.create` (WS A or HTTP) | CRM | `POST /internal/toss-payment/sessions` (INSERT row, `STATUS_CD=CREATED`) |
| `CREATED` | `DISPATCHED` | BE sends `session.dispatch` to plugin | BE | `PATCH /internal/toss-payment/sessions/{sessionId}/status` (`STATUS_CD=DISPATCHED`) |
| `CREATED` | `CANCELED` | `session.abort` from CRM | CRM | `PATCH /internal/toss-payment/sessions/{sessionId}/status` (`STATUS_CD=CANCELED`) |
| `CREATED` | `FAILED` (`DEVICE_OFFLINE`) | 10s grace expired, plugin never registered | BE timer | `PATCH .../status` (`STATUS_CD=FAILED`, `FAIL_REASON_CD=DEVICE_OFFLINE`) |
| `DISPATCHED` | `IN_PROGRESS` | `session.claim` from plugin | Plugin | `PATCH .../status` (`STATUS_CD=IN_PROGRESS`) |
| `DISPATCHED` | `CANCELED` | `session.abort` from CRM | CRM | `PATCH .../status` (`STATUS_CD=CANCELED`) + BE forwards `session.abort` to plugin |
| `DISPATCHED` | `FAILED` (`PLUGIN_UNRESPONSIVE`) | 30s elapsed, no `session.claim` | BE timer | `PATCH .../status` (`STATUS_CD=FAILED`, `FAIL_REASON_CD=PLUGIN_UNRESPONSIVE`) |
| `IN_PROGRESS` | (no change) | `session.chargeContext` from plugin | Plugin | `PATCH /internal/toss-payment/sessions/{sessionId}/charge-context` (`POINT_USE_AMT`, `TOSS_CHRG_SUPPLY_VAL`, `TOSS_CHRG_TAX_AMT`) |
| `IN_PROGRESS` | `SUCCEEDED` (100% 메디캐시) | `session.result(tossResponse: null)` from plugin | Plugin | `PATCH .../result` (`STATUS_CD=SUCCEEDED`) + 메디캐시 차감 (`RCPT_INFO.DC_AMT` +=`pointUseAmount`) |
| `IN_PROGRESS` | `SUCCEEDED` (card) | `session.result(niceResponse, status=SUCCEEDED)` from CRM | CRM | `PATCH .../result` (`STATUS_CD=SUCCEEDED`, persist `niceResponse`) + 메디캐시 차감 if `pointUseAmount > 0` |
| `IN_PROGRESS` | `FAILED` (card) | `session.result(niceResponse, status=FAILED)` from CRM | CRM | `PATCH .../result` (`STATUS_CD=FAILED`, persist `niceResponse`, fail reason from `niceResponse`) — no 메디캐시 차감 |
| `IN_PROGRESS` | `CANCELED` (medicash UI back-out) | `session.abort(reason: "USER_BACKED_OUT")` from plugin | Plugin | `PATCH .../status` (`STATUS_CD=CANCELED`, `FAIL_REASON_CD=USER_BACKED_OUT`) |
| `IN_PROGRESS` | `CANCELED` (NICE-side abort) | `session.result(status=CANCELED)` from CRM | CRM | `PATCH .../result` (`STATUS_CD=CANCELED`, persist `niceResponse`/cancel reason) |
| `IN_PROGRESS` | `EXPIRED` | Backend IN_PROGRESS extended timer expires (no terminal result received) | BE timer | `PATCH .../result` (`STATUS_CD=EXPIRED`, `FAIL_REASON_CD=EXPIRED`) |

**Critical contract change vs. legacy:** after `session.claim` (i.e., once `IN_PROGRESS`), the plugin path is no longer abortable for the card branch. CRM aborts NICE-side via the out-of-band CRM↔NICE channel and then relays the outcome via `session.result(status=CANCELED)` over WS A. The plugin's only IN_PROGRESS abort window is the 메디캐시 selection phase (before `session.chargeContext`).

---

## 4. Wire Contracts (Messages)

### 4.1 Plugin → BE (incoming WS B)

| Message | Purpose | Trigger | Status |
|---|---|---|---|
| `device.register` | Plugin registers serial after Toss SDK `getSerialNumber` | Plugin connect | Existing |
| `session.claim` | Plugin entering order page; DISPATCHED → IN_PROGRESS | Order page mount | Existing |
| `session.chargeContext` | Discounted amount after 메디캐시 selection | User clicks 결제 on 메디캐시 page | Existing |
| `session.result` | 100% 메디캐시 success only (`tossResponse: null`, `chargedSupplyValue: 0`, `chargedTax: 0`) | Immediately after `chargeContext` when 0-charge | Existing (narrowed) |
| `session.abort` | User backed out of 메디캐시 UI (`reason: "USER_BACKED_OUT"`) | Plugin order-page back/dismiss | Existing |

### 4.2 BE → Plugin (outgoing WS B)

| Message | Purpose | Trigger | Status |
|---|---|---|---|
| `device.registered` | Ack for `device.register` | After successful WS B connect | Existing |
| `session.dispatch` | Start new session (simplified payload, see §5.1) | CREATED → DISPATCHED transition | Existing (envelope simplified) |
| `session.abort` | CRM-driven abort relayed (`reason: "ABORTED_BY_CRM"`) | CRM abort while DISPATCHED | Existing (now **DISPATCHED only** — plugin never connects to a CREATED session, per [design doc §4.1](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)) |
| `error` | Per §11 error frame contract | Validation / state / upstream / internal exception | Existing |
| `session.reconcile` | — | — | **REMOVED** |
| `session.proceed` | — | — | **REMOVED** |
| `session.dispatch(kind: cancel)` | — | — | **REMOVED** (refund out of scope, see [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)) |

### 4.3 CRM → BE (incoming WS A)

| Message | Purpose | Trigger | Status |
|---|---|---|---|
| `session.create` | Start a new session | CRM 결제 시작 | Existing |
| `session.abort` | Abort, valid only in CREATED/DISPATCHED | CRM cancels before plugin claim | Existing |
| `session.result` | Relay NICE-side card payment outcome (`status`, `niceResponse`) | CRM receives terminal from NICE | **NEW** |

No refund-related messages on this surface. Any pre-existing legacy `refund.*` messages from [toss-payment-flow.md §10](./superpowers/specs/toss-payment-flow.md) are not used in the NICE-paired flow ([design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)).

### 4.4 BE → CRM (outgoing WS A)

| Message | Purpose | Trigger | Status |
|---|---|---|---|
| `session.ack` | Ack for `session.create` | After CREATED insert | Existing |
| `session.status` | DISPATCHED, IN_PROGRESS transitions only — terminal states (incl. EXPIRED) go via `session.result` ([design doc §4.2](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)) | Non-terminal state change | Existing |
| `session.chargeContext` | Forward plugin's `chargeContext` to CRM; CRM decides NICE dispatch (`chargedSupplyValue + chargedTax > 0` → dispatch; `== 0` → skip). **No ack required** — CRM's subsequent NICE dispatch (or absence thereof for 100% 메디캐시) is the implicit ack ([design doc §4.2](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)) | After plugin `chargeContext` is validated and persisted | **NEW** |
| `session.abort.ack` | Ack for CRM `session.abort` | Immediately after abort transition | Existing |
| `session.result` | Terminal echo (SUCCEEDED/FAILED/CANCELED/EXPIRED) | Reaches terminal state | Existing |
| `error` | Per §11 | Validation / state / upstream / internal exception | Existing |

No refund-related messages on this surface. Refund flow is out of scope ([design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)); pre-existing CRM↔NICE refund channel + pre-existing 메디캐시 reversal mechanism apply.

---

## 5. Message Envelope Examples

### 5.1 `session.dispatch` (BE → Plugin) — simplified

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

**Dropped from legacy** (vs. [toss-payment-flow.md §3](./superpowers/specs/toss-payment-flow.md)): `kind`, `paymentKey`, `timeoutMs`, `excludePaymentTypes`. All were Toss-SDK-specific and have no role in the NICE-paired flow.

### 5.2 `session.chargeContext` (Plugin → BE, then BE → CRM — same envelope)

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

Backend validation: `pointUseAmount + chargedSupplyValue + chargedTax + tip == original supplyValue + tax + tip` (carried forward from [toss-payment-flow.md §5](./superpowers/specs/toss-payment-flow.md)).

After persisting via `PATCH /internal/toss-payment/sessions/{sessionId}/charge-context`, BE forwards the **same envelope shape** to CRM over WS A. CRM uses `chargedSupplyValue + chargedTax` to decide:

- `> 0`: dispatch to NICE with discounted amount.
- `== 0`: 100% 메디캐시 — DO NOT dispatch to NICE; await plugin-originated `session.result(tossResponse: null)`.

### 5.3 `session.result` (Plugin → BE) — 100% 메디캐시 only

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

BE accepts this **only** when `chargedSupplyValue == 0 && chargedTax == 0` and `pointUseAmount` covers the full original total. Any other shape from plugin on this surface MUST be rejected with `error: INVALID_REQUEST`.

### 5.4 `session.result` (CRM → BE) — card path

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
      "card": { }
    }
  }
}
```

For `FAILED` / `CANCELED`, `niceResponse` may carry `reason` / vendor error data. Exact `niceResponse` shape is vendor-specific (NICE) and the precise field set is TBD per design doc §8 — see §14 of this doc.

### 5.5 `session.result` (BE → CRM) — terminal echo

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

`tossResponse` retained only for legacy backcompat (always `null` in NICE-paired flow); `late` field dropped (no reconcile path).

- For the card path: `niceResponse` is the persisted CRM-relayed object; `tossResponse` is `null`.
- For the 100% 메디캐시 path: `niceResponse` is `null` (or omitted); `tossResponse` is `null`.

**`failureReason` field** (non-SUCCEEDED terminal echoes): for any terminal state other than `SUCCEEDED`, the payload includes a top-level `failureReason`. Recognized values (per [design doc §4.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)):

| Value | Origin |
|---|---|
| `"USER_BACKED_OUT"` | Plugin-driven abort during 메디캐시 UI |
| `"ABORTED_BY_CRM"` | CRM-driven abort (in CREATED or DISPATCHED) |
| `"PLUGIN_UNRESPONSIVE"` | 30s no-claim timeout in DISPATCHED |
| `"DEVICE_OFFLINE"` | 10s grace expired in CREATED (plugin never registered) |
| `"EXPIRED"` | IN_PROGRESS timeout (BE-owned extended timer) |
| NICE-supplied reason | `FAILED`/`CANCELED` arriving via CRM `session.result` relay |

Example non-SUCCEEDED terminal echo:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "FAILED",
    "failureReason": "PLUGIN_UNRESPONSIVE",
    "pointUseAmount": 0,
    "chargedSupplyValue": 27273,
    "chargedTax": 2727,
    "amount": { "supplyValue": 27273, "tax": 2727, "tip": 0 },
    "niceResponse": null,
    "tossResponse": null
  }
}
```

### 5.6 `session.abort` (BE → Plugin)

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "{sessionId}",
    "reason": "ABORTED_BY_CRM"
  }
}
```

Sent only when CRM aborts a session that is currently DISPATCHED (plugin is never connected to a CREATED session). Plugin response per the frontend MD: navigate to `home.html` via `location.href` (not `sdk.app.setIdle()` — known blank-screen lifecycle bug).

### 5.7 Refund envelopes — not defined here

Refund envelopes are **not defined** in this MD (refund flow is out of scope, see [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)). The legacy `refund.*` contract in [toss-payment-flow.md §10](./superpowers/specs/toss-payment-flow.md) is **not used** in the NICE-paired flow. Refund handling uses the pre-existing CRM↔NICE refund channel + pre-existing 메디캐시 reversal infrastructure.

---

## 6. End-to-End Flows — Backend POV

### 6.1 Card-payment happy path (design doc §3.1)

```
CRM       → BE          session.create
                          BE: validate; auto-enrich pointContext if absent (existing logic per
                              toss-payment-flow.md §2: hospital/reservation Feign calls)
                          BE → Hospital   POST /internal/toss-payment/sessions          (CREATED)
BE        → CRM         session.ack (status=CREATED)

[BE detects plugin online for serial. If offline: 10s grace.]
                          BE → Hospital   PATCH /internal/toss-payment/sessions/{id}/status (DISPATCHED)
BE        → CRM         session.status (DISPATCHED)
BE        → Plugin      session.dispatch  (simplified envelope, §5.1)

Plugin    → BE          session.claim
                          BE → Hospital   PATCH .../status (IN_PROGRESS)
BE        → CRM         session.status (IN_PROGRESS)
                          BE: arm IN_PROGRESS extended timer (recommended 180s)

[Plugin renders 메디캐시 selection UI. Customer selects amount, clicks 결제.]

Plugin    → BE          session.chargeContext   (pointUseAmount=1000, charged>0)
                          BE: validate sum == original total
                          BE → Hospital   PATCH .../charge-context
                                          (POINT_USE_AMT, TOSS_CHRG_SUPPLY_VAL, TOSS_CHRG_TAX_AMT)
BE        → CRM         session.chargeContext   (forward, same envelope §5.2)

CRM       → NICE        (out-of-band CRM↔NICE: dispatch card payment)

[NICE ↔ Toss Front firmware: VAN/serial — opaque to BE]
[Toss firmware overlays plugin screen with 통합결제창]
[NICE processes card, gets approval]
[NICE → CRM out-of-band terminal]

CRM       → BE          session.result   (status=SUCCEEDED, niceResponse=…)   [§5.4]
                          BE → Hospital   PATCH .../result
                                          (STATUS_CD=SUCCEEDED, persist niceResponse)
                          If pointUseAmount > 0:
                            BE → Hospital  (medicash deduction: RCPT_INFO.DC_AMT += pointUseAmount)
                            If deduction fails: terminal echo STILL fires;
                            BE retries deduction async and emits MEDICASH_DEDUCT_PENDING (see §11.5)
BE        → CRM         session.result   (terminal echo, §5.5)

[Toss firmware auto-setIdle on Toss Front]
[Plugin reverts to home.html on next page load — no BE involvement]
```

### 6.2 100% 메디캐시 happy path (design doc §3.2)

```
[Up to Plugin → BE: session.chargeContext, same as §6.1]

Plugin    → BE          session.chargeContext   (pointUseAmount=total, chargedSupplyValue=0, chargedTax=0)
                          BE → Hospital   PATCH .../charge-context
BE        → CRM         session.chargeContext   (forward; CRM sees 0-charge → does NOT dispatch to NICE)

Plugin    → BE          session.result          (tossResponse=null, §5.3)
                          BE: verify chargedSupplyValue==0 && chargedTax==0 && pointUseAmount covers total
                          BE → Hospital   PATCH .../result (STATUS_CD=SUCCEEDED)
                          BE → Hospital   (medicash deduction: RCPT_INFO.DC_AMT += pointUseAmount)
                          If deduction fails: terminal echo STILL fires;
                          BE retries deduction async and emits MEDICASH_DEDUCT_PENDING (see §11.5)
BE        → CRM         session.result          (status=SUCCEEDED, tossResponse=null, §5.5)

[Plugin renders custom 100% 메디캐시 success screen and navigates to home.html via location.href.
 No BE involvement.]
```

### 6.3 Refunds — out of scope

Refund flow (card refund, mixed refund, 100% 메디캐시 refund) is **not specified** by this design. See [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md). Refund handling uses:

- The **pre-existing CRM↔NICE refund channel** for card-side reversal.
- The **pre-existing backend 메디캐시 reversal mechanism** for 포인트-side reversal.

Neither this MD nor the WS A NICE-paired extensions introduce any refund-related messages. The orphan-charge recovery case (BE EXPIRED + NICE actually approved) also uses these pre-existing channels.

---

## 7. Hospital Feign Endpoints

Carried forward from [toss-payment-flow.md Endpoint Map > Hospital Internal API](./superpowers/specs/toss-payment-flow.md). All endpoints are Core-only callers.

| Endpoint | Used by | Status |
|---|---|---|
| `POST /internal/toss-payment/sessions` | `session.create` (insert CREATED row) | Unchanged |
| `GET /internal/toss-payment/sessions/{sessionId}` | Session lookup | Unchanged |
| `GET /internal/toss-payment/sessions/reconcile-targets?deviceSerialNumber=...` | Legacy recovery introspection | Unchanged (not used by NICE-paired flow) |
| `GET /internal/toss-payment/sessions/dispatch-targets?deviceSerialNumber=...` | Find CREATED sessions for a serial on plugin (re)register | Unchanged |
| `PATCH /internal/toss-payment/sessions/{sessionId}/status` | All non-terminal state transitions (DISPATCHED, IN_PROGRESS, CANCELED via abort) | Unchanged |
| `PATCH /internal/toss-payment/sessions/{sessionId}/charge-context` | Persist `POINT_USE_AMT`, `TOSS_CHRG_SUPPLY_VAL`, `TOSS_CHRG_TAX_AMT` | Unchanged |
| `PATCH /internal/toss-payment/sessions/{sessionId}/result` | Terminal state (SUCCEEDED/FAILED/CANCELED/EXPIRED). For NICE-paired card path, persists `niceResponse` in place of `tossResponse`. | Unchanged shape; new payload field `niceResponse` |
| (Hospital medicash deduction API — exact path/contract owned by Hospital module) | 메디캐시 차감 via `RCPT_INFO.DC_AMT` adjustment, looked up by `CARE_ORG_ID` + `CUST_NO` + `INSR_SEQNO` + `MDCL_SEQNO` + `SEQNO=1` | Unchanged mechanism; called on terminal-SUCCEEDED (deduct). Medicash **reversal** for refunds is handled by the pre-existing 메디캐시 reversal infrastructure (refund flow out of scope, see [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)) |

Refund-related Hospital endpoints (`POST /internal/toss-payment/refunds`, `PATCH /internal/toss-payment/refunds/{refundId}/result`) are not used by the NICE-paired backend flow — refund handling is out of scope per [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md).

Auth: BE uses the WS A `workstationToken` / WS B `coreToken` to extract `hospitalId`, which is then used to mint Hospital API tokens via the existing flow (per [toss-payment-flow.md §2/§6](./superpowers/specs/toss-payment-flow.md)). `CARE_ORG_ID` (from `crmOrigin.organizationId`) is used as `RCPT_INFO` lookup key, never as auth context.

---

## 8. Medicash Handling

### 8.1 When BE deducts

On `IN_PROGRESS → SUCCEEDED`, **only if** `pointUseAmount > 0`:

1. BE finds `RCPT_INFO` by `CARE_ORG_ID` (= `crmOrigin.organizationId`), `CUST_NO`, `INSR_SEQNO`, `MDCL_SEQNO`, `SEQNO=1` (carried forward from [toss-payment-flow.md §6](./superpowers/specs/toss-payment-flow.md)).
2. BE adds `pointUseAmount` to `RCPT_INFO.DC_AMT` via the Hospital medicash deduction API.
3. BE uses the hospital API token minted from the WS-token-derived `hospitalId`.

This applies to **both** terminal-SUCCEEDED paths:

- Card path (CRM → BE `session.result(SUCCEEDED, niceResponse)` with `pointUseAmount > 0` from earlier `chargeContext`)
- 100% 메디캐시 path (Plugin → BE `session.result(tossResponse: null)` with `pointUseAmount == total`)

Deduction failure handling on SUCCEEDED is non-blocking — see §11.5.

### 8.2 Medicash reversal (refunds) — out of scope

Medicash reversal on refund is handled by the **pre-existing 메디캐시 reversal infrastructure** (refund flow out of scope per [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)). No backend contract for this case in the NICE-paired flow.

---

## 9. Timeout Policies

| State | Timeout | Action | Note |
|---|---|---|---|
| `DISPATCHED` | 30s with no `session.claim` | → `FAILED / PLUGIN_UNRESPONSIVE`; CRM gets `session.result(FAILED)` | Unchanged from legacy |
| `IN_PROGRESS` | **Backend-owned extended timer (recommended 180s; exact value TBD per design doc §8 — see §14)** | → `EXPIRED`; CRM gets `session.result(status=EXPIRED, failureReason="EXPIRED")` (terminal echo per §5.5) | **REPLACES legacy `timeoutMs + 30s` ≈ 90s** ([toss-payment-flow.md §9](./superpowers/specs/toss-payment-flow.md)) |

**Why the change:** the legacy ~90s window was scoped to a single `sdk.payment.requestPayment` call. In the NICE-paired flow, IN_PROGRESS now spans 메디캐시 selection + customer card insertion (potentially multiple attempts) + VAN approval + relay back through CRM. Real-world customer behavior at a 카드 단말기 requires multiple minutes of headroom. Backend MUST commit to a single, configurable value at implementation time — there is no `timeoutMs` field flowing in via `session.dispatch` anymore (dropped per §5.1) for the backend to read.

**Recovery on plugin reconnect during IN_PROGRESS:** BE does NOT send `session.reconcile`. There is nothing to recover plugin-side (no `requestPayment` was ever called). The session continues on its CRM-relayed path or expires per the timer.

---

## 10. Error Frames

The error-frame contract from [toss-payment-flow.md §11](./superpowers/specs/toss-payment-flow.md) is **preserved verbatim** in the NICE-paired flow.

### 10.1 Codes

| Code | Meaning |
|---|---|
| `INVALID_REQUEST` | JSON 파싱 실패, 필수 필드 누락, 금액 검증 실패 (e.g., `pointUseAmount + chargedSupplyValue + chargedTax + tip != original total`) |
| `INVALID_STATE` | 상태 전이 오류 (e.g., `session.result` arriving while `CREATED`, late `session.result` after EXPIRED), `RCPT_INFO` 미존재 등 |
| `UPSTREAM_ERROR` | Hospital / Reservation Platform Feign 실패 during a blocking step (session create, status PATCH, result PATCH). 메디캐시 deduction failure on terminal SUCCEEDED is **non-blocking** and uses `MEDICASH_DEDUCT_PENDING` instead — see §11.5. |
| `MEDICASH_DEDUCT_PENDING` | 메디캐시 deduction on terminal SUCCEEDED failed and is being retried asynchronously (see §11.5). Operator-flag only; terminal echo still fires. |
| `INTERNAL_ERROR` | 그 외 예외 |

### 10.2 Envelope

```json
{
  "type": "error",
  "payload": {
    "code": "INVALID_STATE",
    "message": "receipt info not found",
    "sessionId": "{sessionId}"
  }
}
```

### 10.3 Scope rules

- Error arising while processing a **plugin** message with a discoverable `sessionId`: BE sends the same `error` frame to **both** the plugin WS and the corresponding CRM WS.
- Error arising while processing a **CRM** message: BE sends the `error` frame to the CRM WS only.
- Error arising during BE-internal processing (e.g., timer, async Feign retry) where a session is identifiable: same scope as the originating message's owner. For `MEDICASH_DEDUCT_PENDING` (async retry of medicash deduction after terminal SUCCEEDED), the frame goes to **CRM only** (the session is already terminal and the plugin has already navigated home; this is an operator-facing reconciliation signal).
- BE does NOT close WS connections on errors (no 1011 closes for application-level failures). Connection lifecycle is independent of message-level errors.

---

## 11. Edge Cases — Backend POV

### 11.1 Plugin disconnect

| When | BE behavior |
|---|---|
| After register, before claim | DISPATCHED timer continues; if 30s elapses without claim → `FAILED / PLUGIN_UNRESPONSIVE` |
| After claim, before `session.chargeContext` | IN_PROGRESS timer continues; on expiry → `EXPIRED`. No reconcile sent on reconnect. |
| After `chargeContext` (card path) | **Irrelevant.** BE awaits CRM-originated `session.result`. Plugin reconnect: no reconcile; plugin reverts to home. Session terminates normally when CRM relays the NICE result. |
| After `chargeContext` (100% 메디캐시), before `session.result` | Narrow window. IN_PROGRESS timer continues; on expiry → `EXPIRED`. No recovery — the plugin's terminal `session.result(tossResponse: null)` is unrecoverable if not delivered. |
| After plugin's `session.result` (100% 메디캐시) | Irrelevant — session already terminal. |

**On plugin reconnect during an in-flight session:** BE does NOT send `session.reconcile`. The plugin has no recovery role in the NICE-paired flow. BE's only reconnect-time action is to send `session.dispatch` for any sessions still in `CREATED` for that serial (existing logic, [toss-payment-flow.md §1](./superpowers/specs/toss-payment-flow.md)).

### 11.2 CRM abort

| Scenario | BE behavior |
|---|---|
| CRM aborts in `CREATED` | `STATUS_CD=CANCELED`; send `session.abort.ack` (CANCELED) + `session.result(CANCELED, failureReason: "ABORTED_BY_CRM")` to CRM. No plugin notification (plugin never saw dispatch). |
| CRM aborts in `DISPATCHED` | `STATUS_CD=CANCELED`; send `session.abort.ack` + `session.result(CANCELED, failureReason: "ABORTED_BY_CRM")` to CRM; forward `session.abort(reason: "ABORTED_BY_CRM")` to plugin (§5.6). |
| CRM aborts in `IN_PROGRESS` (via `session.abort`) | **Rejected.** BE responds with `session.abort.ack(REJECTED, IN_PROGRESS_NOT_ABORTABLE)` (carried forward from [toss-payment-flow.md §7](./superpowers/specs/toss-payment-flow.md)). |
| CRM aborts in `IN_PROGRESS` during NICE phase (out-of-band CRM↔NICE cancel) | CRM cancels on the NICE channel out-of-band, then relays `session.result(status=CANCELED, niceResponse=…)` over WS A. BE persists CANCELED, no plugin notification (firmware closes 통합결제창 on its own). |
| User attempts abort during card phase | **Not possible at all.** Toss firmware's 통합결제창 owns the screen; plugin has no UI to dismiss. BE has no surface for this case. |

### 11.3 NICE-side failure

- Card declined / VAN error / NICE offline / timeout: NICE reports failure to CRM out-of-band.
- CRM → BE: `session.result(status=FAILED, niceResponse={vendor error data})`.
- BE: `PATCH .../result` (`STATUS_CD=FAILED`, persist `niceResponse`); **does NOT deduct 메디캐시**.
- BE → CRM: `session.result` terminal echo with `status=FAILED`.

### 11.4 BE timer expiry (IN_PROGRESS → EXPIRED)

- BE: `PATCH .../result` (`STATUS_CD=EXPIRED`, `FAIL_REASON_CD=EXPIRED`); does NOT deduct 메디캐시.
- BE → CRM: `session.result(status=EXPIRED, failureReason: "EXPIRED")` terminal echo.
- BE does NOT notify plugin (plugin has no UI to react; firmware overlay either succeeded NICE-side — in which case this is a soft data loss the CRM must reconcile out-of-band with NICE — or failed/was abandoned).

### 11.5 Medicash deduction failure on SUCCEEDED

Per [design doc §6](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md): if BE receives a terminal `session.result(SUCCEEDED)` — Plugin→BE for 100% 메디캐시 OR CRM→BE for card path — and the Hospital Feign call to deduct 메디캐시 fails:

- BE persists the session as `SUCCEEDED` regardless (NICE-side payment is already approved for card; for 100% 메디캐시 the terminal state is authoritative — there is no upstream to unwind).
- BE retries the 메디캐시 deduction asynchronously with exponential backoff, up to a backend-configurable cap (suggested: 5 attempts over ~30 minutes; exact policy TBD per design doc §8 — see §14).
- If still failing after the cap, BE escalates to manual reconciliation owned by the backend team.
- BE emits an `error` frame to CRM with code `MEDICASH_DEDUCT_PENDING` so the operator can flag for follow-up.
- The terminal `session.result` echo to CRM **still fires** with `status=SUCCEEDED` (the payment did succeed); 메디캐시 deduction is a separate operational concern that does **not** block bookkeeping closure.

### 11.6 Late CRM `session.result` after BE EXPIRED

Per [design doc §6](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md), if CRM relays a `session.result` (`SUCCEEDED` / `FAILED` / `CANCELED`) for a session that BE has already marked EXPIRED:

- BE rejects the late `session.result` with `error: INVALID_STATE` (per [toss-payment-flow.md §11](./superpowers/specs/toss-payment-flow.md) error frame contract).
- BE does **NOT** mutate the session record (stays EXPIRED).
- CRM **must not retry** the send.
- If NICE in fact approved (orphan card charge), CRM uses the **pre-existing CRM↔NICE refund mechanism** + the pre-existing backend 메디캐시 reversal infrastructure ([design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)). No backend contract is specified here for this case.

### 11.7 BE → Plugin `error` frame response

When BE rejects a plugin-originated message (e.g., invalid `session.chargeContext`, claim against wrong state, late result), BE sends an `error` frame per [toss-payment-flow.md §11](./superpowers/specs/toss-payment-flow.md). The plugin response (toast via `sdk.template.openToast` + navigate to `home.html`) is specified in the frontend MD. From BE's side:

- BE marks the session terminal if the error reflects an unrecoverable state transition failure.
- Otherwise the session retains its prior state and waits for plugin retry — though per the frontend MD the plugin will navigate to home rather than retry.

### 11.8 Plugin reconnect after BE EXPIRED

When a plugin reconnects (or registers fresh) after BE has already marked an in-flight session EXPIRED:

- BE acks `device.register` with `device.registered`.
- BE does **NOT** send `session.dispatch` for the EXPIRED session — that session is terminal.
- BE **may** send `session.dispatch` for any other session that is still `CREATED` on this serial (existing dispatch-targets logic).
- If no eligible session, BE sends nothing further; plugin stays idle on `home.html`.

The operator is informed of the EXPIRED outcome via the CRM-side `session.result(EXPIRED)` terminal echo (independent of plugin presence).

### 11.9 Hospital DB write failure mid-flight

- `session.create` Feign failure → `error: UPSTREAM_ERROR` to CRM; no session row exists.
- `status` PATCH failure during DISPATCHED/IN_PROGRESS transition → `error: UPSTREAM_ERROR` to CRM (and plugin if plugin-originated); session is held in its prior state pending retry/intervention.
- `result` PATCH failure → `error: UPSTREAM_ERROR`; do NOT send terminal echo to CRM. Subsequent retry can complete the persistence.
- 메디캐시 deduction failure on SUCCEEDED → non-blocking; see §11.5 (terminal echo still fires; async retry).

---

## 12. What's Removed vs. Legacy

Per design doc §7, the following are removed from Backend's surface:

**Refund flow — entirely out of scope:**
- All refund orchestration is **out of scope** for this MD. Refund handling uses the pre-existing CRM↔NICE refund channel + pre-existing backend 메디캐시 reversal mechanism per [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md). The NICE-paired WS A extensions introduce **no** refund-related messages.
- `refund.dispatch` (BE → CRM) — never introduced; the prior plan to add it is dropped.
- `refund.result` (CRM → BE direction) — never introduced; the prior plan to add it is dropped.
- `refund.result` (BE → CRM direction) — not used in NICE-paired flow.
- Any prior reference in earlier drafts to refund-related messages being "NEW" in WS A is now wrong — they were never shipped.

**WS B (BE → Plugin) outgoing:**
- `session.proceed` — REMOVED.
- `session.reconcile` (and the corresponding plugin → BE response handler for it) — REMOVED for NICE-paired sessions. (The endpoint shell can remain for legacy session introspection; no NICE-paired code path sends this.)
- `session.dispatch(kind=cancel)` — REMOVED (refund out of scope).

**WS B (Plugin → BE) incoming — the BE handlers for these are narrowed:**
- `session.result` with `tossResponse != null` from plugin — REMOVED. Only `tossResponse: null` (100% 메디캐시) is accepted on this surface.
- `refund.result` from plugin — REMOVED entirely (refund out of scope).

**`session.dispatch` envelope fields:**
- `kind` — REMOVED.
- `paymentKey` — REMOVED.
- `timeoutMs` — REMOVED (replaced by BE-owned extended timer, see §9).
- `excludePaymentTypes` — REMOVED.

**Backend recovery logic:**
- `session.reconcile` send on plugin reconnect for non-terminal sessions — REMOVED for NICE-paired flow.
- `late: true` terminal echoes from plugin recovery — no longer generated (`late: false` is the only emission, kept in envelope for backward compat).
- Orphan-NICE-recovery backend contract (prior "BE must allow `refund.create` against EXPIRED" rule) — REMOVED. Orphan handling uses pre-existing CRM↔NICE refund infrastructure per [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md).

**Impact on existing [toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md):**
- **§5.5 (`session.proceed` contract) — OBSOLETE.** Plugin no longer waits, BE no longer sends `session.proceed`. The `AWAITS_PROCEED` plugin-side feature gate is removed.
- **§9 (Timeout And Reconciliation sub-flow) — partially obsolete.** Timeout policy is retained but values change (see §9 of this doc). Reconciliation (`session.reconcile` + `getPayment` + late echo) is OBSOLETE for NICE-paired flow.
- **§10 (Refund — legacy plugin-side refund flow) — OBSOLETE in the NICE-paired flow.** Refunds no longer involve the plugin at all (no `session.dispatch(kind=cancel)`); the entire refund flow is out of scope here and uses the pre-existing CRM↔NICE refund infrastructure per [design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md).
- **§10 caveat ("100% 메디캐시 결제는 ... 별도 API/정책이 필요하다") — out of scope.** Resolution for the 100% 메디캐시 refund case is provided by the pre-existing 메디캐시 reversal infrastructure (not specified here).
- **Data Ownership block — Core owns:** `session.proceed dispatch` and `skip-NICE signaling to CRM on zero-charge sessions` lines are obsolete in their current wording. The new owning surfaces are §5.2 (BE forwards `session.chargeContext` to CRM; CRM decides skip locally) and the §3 state machine (no separate proceed signal).
- **Data Ownership block — Plugin owns:** `requestPayment`, `requestPaymentCancel`, `getPayment recovery`, `Phase 1 → phase 2 waiting screen and session.proceed consumption` are OBSOLETE for NICE-paired flow. (Plugin retains: `Toss SDK app/storage calls`, `Order/point UI rendering`, `Point-use amount selection and session.chargeContext`, `100% 메디캐시 skip-NICE detection`.)

---

## 13. Removed legacy flows — quick reference

For audit-trail completeness, the following sub-flows from the 2026-05-08 backend doc that was previously at this filename are now OBSOLETE:

- Option A (`AWAITING_NICE` sub-state) and Option B (two coupled sessions) — neither is adopted; single `IN_PROGRESS` state with extended timer is the chosen approach.
- `session.proceed` envelope BE→CRM signaling — does not exist.
- Phase-1→phase-2 wait timer as a distinct sub-state — folded into the IN_PROGRESS extended timer.
- "Discounted amount → CRM envelope" as a backend design choice — the choice is made: `session.chargeContext` is forwarded verbatim (§5.2), no new envelope name introduced.
- `sdk.webSocket` foreground/idle fallback considerations for `session.dispatch` retaining a phase-2 trigger role — irrelevant (no phase-2 trigger exists; firmware handles the transition).

---

## 14. Open Items / TBDs (Backend)

Per design doc §8, the following are non-blocking but require backend decisions at implementation time:

| Item | Recommendation | Owner | Notes |
|---|---|---|---|
| Exact IN_PROGRESS extended timeout value | **180s floor**; final value at backend's discretion | Backend | Must accommodate multiple card-insertion attempts + customer hesitation. Make it configurable. |
| Whether `session.status` IN_PROGRESS gets a sub-status for "awaiting NICE" (e.g., `IN_PROGRESS/AWAITING_NICE`) | Cosmetic; not part of the wire contract | Backend | If introduced, MUST NOT affect the §3 state machine transitions. CRM should not branch on a sub-status. |
| Exact `niceResponse` envelope shape for FAILED/CANCELED variants (only SUCCEEDED example concrete in §4.3; CRM + Backend must converge before implementation kickoff) | TBD with CRM team | CRM + Backend | Persisted opaquely on the BE side. |
| Exact retry / backoff / escalation policy for 메디캐시 deduction failure on terminal SUCCEEDED (see §11.5) | Suggested: 5 attempts over ~30 min, exponential backoff, then manual reconciliation | Backend | Non-blocking for the terminal echo. Must produce a clear operator signal (`MEDICASH_DEDUCT_PENDING` error frame, plus internal alerting). |

**Removed from prior TBD list** (no longer applicable now that refund is out of scope, [design doc §7](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)):

- BE-side logic for 메디캐시 re-credit on refund (mixed + 100% paths) — refund is handled by pre-existing infrastructure ([design doc §3.3](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)).

---

## 15. References

- **Master design (source of truth):** [docs/superpowers/specs/2026-05-12-nice-paired-final-flow-design.md](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md)
- **Legacy contract (still in effect for unchanged surfaces):** [docs/superpowers/specs/toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md)
- **Companion role docs:**
  - [docs/payment-flow-with-nice-terminal-frontend.md](./payment-flow-with-nice-terminal-frontend.md)
  - [docs/payment-flow-with-nice-terminal-crm.md](./payment-flow-with-nice-terminal-crm.md)
- **Toss confirmation:** Slack thread `C0ANAJW463E`, parent ts `1778460158.013389`, dated 2026-05-12.
