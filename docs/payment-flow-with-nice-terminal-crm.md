# Payment Flow with NICE Terminal — CRM Role

> **Status:** Finalized 2026-05-12. Authoritative contract for the CRM (workstation client) team building against the NICE-paired Toss Front payment flow.
>
> **Master design:** [docs/superpowers/specs/2026-05-12-nice-paired-final-flow-design.md](./superpowers/specs/2026-05-12-nice-paired-final-flow-design.md) — single source of truth for all flow facts. This MD is a role-specific projection of that design and must not contradict it.
>
> **Supersedes:** The 2026-05-08 feasibility review version of this file is superseded in full. Anything in that prior draft (TBD envelope names, "Option A vs Option B" abort branching, "observational NICE result") is obsolete. The flow below is the converged, signed-off contract.
>
> **Sibling role docs:**
> - [docs/payment-flow-with-nice-terminal-frontend.md](./payment-flow-with-nice-terminal-frontend.md) — Plugin role
> - [docs/payment-flow-with-nice-terminal-backend.md](./payment-flow-with-nice-terminal-backend.md) — Backend role
>
> **Existing backend contract cross-reference:** [docs/superpowers/specs/toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md) — sections 2 and 7 cover the WS A pieces that remain unchanged (`session.create`, `session.abort`, `session.ack`, `session.status`, `session.result` terminal echo, `session.abort.ack`, `error`). Section 10 (legacy refund flow) is **obsolete** for the NICE-paired flow — refund is out of scope (§6.3 here, design doc §3.3), CRM uses pre-existing CRM↔NICE refund infrastructure.

---

## 1. CRM's role in the NICE-paired flow

In the legacy flow CRM was a thin client: initiate a session, observe the result. In the NICE-paired flow CRM becomes an **orchestrator** sitting between the backend (over WS A) and the NICE 카드 단말기 (over the pre-existing CRM↔NICE channel).

Per design doc §0, Toss confirmed NICE + Toss Front runs in **시리얼통신 기반 리더기 모드**. Toss Front behaves as a card reader; NICE does the real VAN/approval. The plugin no longer touches `sdk.payment.requestPayment` for card flow. That work shifts to CRM↔NICE. The plugin's only remaining authoritative path is the 100% 메디캐시 branch.

CRM's responsibilities, in order:

1. **Initiate** payment sessions via `session.create` over WS A (existing).
2. **Receive `session.chargeContext` forward from BE** (NEW direction): the plugin's post-메디캐시 amount split, relayed to CRM.
3. **Detect 100% 메디캐시**: if `chargedSupplyValue + chargedTax == 0`, do **not** dispatch to NICE. The plugin handles the success-path entirely over WS B; CRM simply waits for the terminal `session.result` echo.
4. **Dispatch card payment to NICE** (existing CRM↔NICE channel) when `chargedSupplyValue + chargedTax > 0`. Pass the discounted charge amount.
5. **Receive NICE result** over the same CRM↔NICE channel.
6. **Relay NICE result to BE** via `session.result` over WS A (NEW direction), carrying `status` and `niceResponse`.

**Refund flow is out of scope.** CRM uses its pre-existing CRM↔NICE refund channel + pre-existing backend 메디캐시 reversal mechanism for any reversal need. No refund-related messages are introduced on WS A by this contract (see §6.3, §9, and design doc §3.3).

Single-source-of-truth rule (unchanged from legacy): the **backend** is the authoritative record of every session outcome. Anything NICE tells CRM directly is operational data CRM uses to drive WS A — never the system-of-record value. CRM books the outcome only after BE's terminal `session.result` echo.

### 1.1 CRM-POV state machine

What CRM observes and originates at each session-state transition:

| Transition | CRM action |
|---|---|
| (new) → CREATED | CRM sends `session.create` |
| CREATED → DISPATCHED | CRM observes `session.status(DISPATCHED)` |
| CREATED → CANCELED | CRM sends `session.abort`, observes `session.abort.ack` + `session.result(CANCELED)` |
| CREATED → FAILED | CRM observes `session.result(FAILED, DEVICE_OFFLINE)` after 10s grace |
| DISPATCHED → IN_PROGRESS | CRM observes `session.status(IN_PROGRESS)` |
| DISPATCHED → CANCELED | Same as CREATED→CANCELED |
| DISPATCHED → FAILED | CRM observes `session.result(FAILED, PLUGIN_UNRESPONSIVE)` after 30s |
| IN_PROGRESS → SUCCEEDED (100% 메디캐시) | CRM observes `session.chargeContext` (0-charge), then `session.result(SUCCEEDED)` |
| IN_PROGRESS → SUCCEEDED (card) | CRM observes `session.chargeContext` (charged>0), dispatches to NICE, **CRM sends** `session.result(SUCCEEDED, niceResponse=...)` |
| IN_PROGRESS → FAILED (card) | CRM observes `session.chargeContext`, dispatches to NICE, **CRM sends** `session.result(FAILED, niceResponse=...)` |
| IN_PROGRESS → CANCELED (NICE-side abort) | CRM aborts NICE-side via CRM↔NICE, then **CRM sends** `session.result(CANCELED, niceResponse=...)` |
| IN_PROGRESS → EXPIRED | CRM observes `session.result(EXPIRED, failureReason='EXPIRED')` |

See design doc §2 for the underlying state machine.

---

## 2. Channels

| Channel | Endpoints | Status | Notes |
|---|---|---|---|
| **WS A** | CRM ↔ Core (BE) | Existing, extended | `wss://<core>/ws/crm?token=<workstationToken>`. New message types added for NICE coordination — see §3. |
| **CRM ↔ NICE 카드 단말기** | Out-of-band | Pre-existing legacy | Owned by CRM/NICE integration. Wire format opaque to BE and plugin. **Not specified in this document.** |
| HTTP (Core public) | CRM → Core | Existing | Optional fallback; flow below assumes WS A. |

dev core host: `develop.api.core.smartdoctor.systems`
release core host: `release.api.core.smartdoctor.systems`

NICE 단말기 ↔ Toss Front firmware is Toss + 밴사 territory (serial / VAN module) and is opaque to the entire stack including CRM. CRM never speaks to Toss Front directly.

---

## 3. Wire Messages on WS A

### 3.1 CRM → BE

| Message | Status | Purpose |
|---|---|---|
| `session.create` | Existing | Start a new payment session. Payload unchanged — see [toss-payment-flow.md §2](./superpowers/specs/toss-payment-flow.md). |
| `session.abort` | Existing | Abort a session. Valid only in `CREATED` / `DISPATCHED`. After `session.claim` flips state to `IN_PROGRESS`, this is rejected — see §8. |
| `session.result` | **NEW direction** | Relay NICE-side card payment outcome to BE. Payload: `sessionId`, `status` (`SUCCEEDED` / `FAILED` / `CANCELED`), `niceResponse`. |

### 3.2 BE → CRM

| Message | Status | Purpose |
|---|---|---|
| `session.ack` | Existing | Acknowledge `session.create`. Carries `sessionId`, `clientRequestId`, `status: CREATED`. |
| `session.status` | Existing | `DISPATCHED`, `IN_PROGRESS` transitions only — terminal states (incl. `EXPIRED`) go via `session.result`. |
| `session.chargeContext` | **NEW** | Forward of the plugin's `chargeContext`. Carries `pointUseAmount`, `chargedSupplyValue`, `chargedTax`. CRM dispatches to NICE iff `chargedSupplyValue + chargedTax > 0`. |
| `session.result` | Existing | Terminal echo: `SUCCEEDED` / `FAILED` / `CANCELED` / `EXPIRED`. Authoritative system-of-record value. Includes `failureReason` for non-SUCCEEDED states (see §4.3). |
| `session.abort.ack` | Existing | Acknowledge `session.abort`. May carry `status: REJECTED` with `reason: IN_PROGRESS_NOT_ABORTABLE`. |
| `error` | Existing | Per [toss-payment-flow.md §11](./superpowers/specs/toss-payment-flow.md). Codes: `INVALID_REQUEST`, `INVALID_STATE`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`. |

> **FYI — `session.abort` (BE → Plugin):** When CRM aborts a `DISPATCHED` session, BE relays a `session.abort(reason: "ABORTED_BY_CRM")` envelope to the plugin on WS B. This is **not** a BE → CRM message; CRM never sends nor receives it directly. It's listed here so the CRM team is aware of the plugin-side side effect of their `session.abort` send. (See design doc §4.2.)

> Refund-related messages on WS A are not part of the NICE-paired contract. CRM uses its pre-existing CRM↔NICE refund channel.

---

## 4. Message envelope examples (NEW messages on WS A touching CRM)

Existing envelopes (`session.create`, `session.ack`, `session.status`, `session.abort`, `session.abort.ack`, `error`) follow [toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md) verbatim and are not re-quoted here.

### 4.1 `session.chargeContext` (BE → CRM) — NEW

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

Identical envelope to the plugin's `Plugin → BE` send; BE simply forwards it to the CRM bound to this session's workstation. CRM uses `chargedSupplyValue + chargedTax` as the dispatch decision (§5) and as the NICE charge amount.

**No ack required.** CRM does not ack the BE→CRM forwarded `session.chargeContext`. CRM's subsequent NICE dispatch (when `chargedSupplyValue + chargedTax > 0`) or absence thereof (for 100% 메디캐시) is the implicit ack. (See design doc §4.2.)

### 4.2 `session.result` (CRM → BE — card path) — NEW direction

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

- `status` is one of `SUCCEEDED`, `FAILED`, `CANCELED`.
- For `FAILED` / `CANCELED`, `niceResponse` may carry `reason` or vendor error data instead of (or alongside) approval fields. Exact failure shape is TBD (§13).
- Sent only after NICE returns a result over the CRM↔NICE channel. Do **not** send this for 100% 메디캐시 sessions — the plugin owns that terminal.

### 4.3 `session.result` (BE → CRM — terminal echo) — existing envelope, extended payload

SUCCEEDED example:

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
    "niceResponse": { /* persisted, or null for 100% 메디캐시 */ },
    "tossResponse": null
  }
}
```

Non-SUCCEEDED example (carries `failureReason` top-level):

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "CANCELED",
    "failureReason": "USER_BACKED_OUT",
    "pointUseAmount": 0,
    "chargedSupplyValue": 0,
    "chargedTax": 0,
    "amount": { "supplyValue": 27273, "tax": 2727, "tip": 0 },
    "niceResponse": null,
    "tossResponse": null
  }
}
```

- `tossResponse` is retained only for backward compatibility with the legacy contract; it is always `null` in the NICE-paired flow.
- The legacy `late` field is dropped — `session.reconcile` no longer exists in the NICE-paired flow, so there is no reconcile path that could produce `late: true`.
- `niceResponse` is `null` for 100% 메디캐시.
- `failureReason` (top-level payload field) is set for non-SUCCEEDED terminal states. Recognized values (per design doc §4.3):
  - `"USER_BACKED_OUT"` — plugin-driven abort during medicash UI
  - `"ABORTED_BY_CRM"` — CRM-driven abort
  - `"PLUGIN_UNRESPONSIVE"` — 30s no-claim timeout in DISPATCHED
  - `"DEVICE_OFFLINE"` — 10s grace expired in CREATED (plugin never registered)
  - `"EXPIRED"` — IN_PROGRESS timeout
  - NICE-supplied reason for `FAILED` / `CANCELED` arriving via CRM relay
- This is the **authoritative** terminal value. CRM books bookkeeping/receipts off this message, not off whatever NICE told CRM directly.

> Refund envelopes are not defined here (refund flow out of scope per §6.3).

---

## 5. CRM ↔ NICE channel (high-level)

The CRM↔NICE wire protocol is **legacy** and remains the pre-existing integration between CRM and the 나이스 카드 단말기. Its envelope, transport, and error semantics are **out of scope** of this document and of every other source-of-truth MD in this design.

Conceptually, the in-scope (NICE-paired payment) flows are:

**CRM → NICE:**
- **Card payment dispatch.** Triggered by `session.chargeContext` (BE → CRM) when `chargedSupplyValue + chargedTax > 0`. Carries the discounted charge amount (sum of `chargedSupplyValue + chargedTax`, plus any tip — currently always 0).
- **Abort.** Triggered when CRM needs to cancel an in-flight NICE card phase (e.g., operator-side cancel after NICE has already engaged the card). Out-of-band over CRM↔NICE; not a WS A message.

**NICE → CRM:**
- **Card payment result.** Approval data, decline data, or operator-cancel data. CRM translates the outcome into `status` + `niceResponse` for the WS A `session.result` send.

**Refund flows on CRM↔NICE** are pre-existing and **out of scope** of this contract (see §6.3, §9, and design doc §3.3). CRM continues to use its existing CRM↔NICE refund mechanism without WS A involvement.

**Wire format:** Not specified here. Owned by the CRM team's NICE integration. The only constraint this document places on CRM↔NICE is that whatever NICE returns for card payment must be reducible to the `niceResponse` JSON object CRM puts onto WS A.

---

## 6. End-to-end flows — CRM POV

These mirror design doc §3. CRM-relevant rows only; plugin-internal steps omitted.

### 6.1 Card-payment happy path

```
CRM → BE          session.create
BE → CRM          session.ack (CREATED, sessionId)
BE → CRM          session.status (DISPATCHED)
BE → CRM          session.status (IN_PROGRESS)

BE → CRM          session.chargeContext (pointUseAmount, chargedSupplyValue, chargedTax)
CRM:              evaluate chargedSupplyValue + chargedTax
                    → > 0: card path (this flow)
CRM → NICE        dispatch card payment (chargedSupplyValue + chargedTax)
                  [legacy CRM↔NICE protocol]

[NICE ↔ Toss Front firmware: VAN/serial — opaque to CRM web layer]
[Toss firmware overlays plugin screen with 통합결제창]

NICE → CRM        card payment result (approval)
CRM → BE          session.result (status=SUCCEEDED, niceResponse={…})
BE → CRM          session.result (terminal echo, persisted state)

[Toss firmware: auto-setIdle on Toss Front; plugin returns to home.html]
CRM:              books receipt off BE's terminal session.result
```

### 6.2 100% 메디캐시 happy path

```
CRM → BE          session.create
BE → CRM          session.ack (CREATED)
BE → CRM          session.status (DISPATCHED)
BE → CRM          session.status (IN_PROGRESS)

BE → CRM          session.chargeContext (pointUseAmount=total, chargedSupplyValue=0, chargedTax=0)
CRM:              evaluate chargedSupplyValue + chargedTax
                    → == 0: skip NICE dispatch entirely

[Plugin → BE: session.result(tossResponse=null) — back-to-back with chargeContext]
[BE persists SUCCEEDED, deducts medicash via RCPT_INFO.DC_AMT]

BE → CRM          session.result (status=SUCCEEDED, niceResponse=null, tossResponse=null)
CRM:              books 100% 메디캐시 receipt off BE's terminal session.result
```

CRM never speaks to NICE in this flow. The decision point is the `chargedSupplyValue + chargedTax == 0` check on receipt of `session.chargeContext`.

### 6.3 Refunds — out of scope (use pre-existing CRM↔NICE flow)

Refunds are NOT specified by this design. See design doc §3.3. CRM continues to use:
- Its pre-existing CRM↔NICE refund channel for card-side reversal.
- Its pre-existing trigger mechanism for backend 메디캐시 reversal.

Neither this MD nor the NICE-paired contract additions on WS A introduce any refund-related messages. The orphan-charge scenario (BE EXPIRED + NICE actually approved) also uses these pre-existing channels — no contract recovery path is defined here.

---

## 7. 100% 메디캐시 detection (CRM logic)

The detection rule is local and deterministic.

**Trigger:** On receipt of `session.chargeContext` (BE → CRM).

**Rule:**

```
if (payload.chargedSupplyValue + payload.chargedTax == 0):
    # 100% 메디캐시 path — DO NOT dispatch to NICE
    # The session continues entirely BE-side via the plugin's session.result.
    # CRM simply waits for the terminal session.result echo from BE.
else:
    # Card path — dispatch to NICE with charged amount
    CRM → NICE: dispatch card payment (chargedSupplyValue + chargedTax)
```

**Notes:**
- BE validates `pointUseAmount + chargedSupplyValue + chargedTax + tip == originalTotal` before forwarding, so CRM does not need to revalidate the arithmetic.
- The detection is on `chargedSupplyValue + chargedTax`, not on `pointUseAmount`. A zero `pointUseAmount` does not imply skip-NICE; only a zero charge does.
- Edge cases (e.g., negative or fractional values) are flagged TBD in §13.

---

## 8. Abort handling

Abort semantics depend on session state and abort origin.

| Scenario | Originator | Mechanism | Notes |
|---|---|---|---|
| Pre-claim abort (`CREATED` or `DISPATCHED`) | CRM | `session.abort` over WS A (existing) | BE → CRM: `session.abort.ack` + terminal `session.result(CANCELED)`. If `DISPATCHED`, BE also sends `session.abort` to plugin. |
| Plugin user backs out during medicash UI (post-claim, pre-chargeContext) | Plugin | `session.abort(USER_BACKED_OUT)` over WS B | CRM sees BE → CRM: `session.result(status=CANCELED, failureReason=USER_BACKED_OUT)`. CRM took no NICE action so no NICE-side cleanup is needed. |
| NICE-side abort during card phase (post-chargeContext, NICE engaged) | CRM-initiated, executed over CRM↔NICE | Out-of-band on CRM↔NICE, then `session.result(status=CANCELED, niceResponse={…})` over WS A | This is the **NEW direction** of `session.result`. Plugin is not notified separately; firmware closes 통합결제창 when NICE ends the card transaction. |
| User attempts abort during card phase | (not possible) | — | Toss firmware's 통합결제창 owns the screen; plugin has no UI to dismiss. Only CRM (via the operator) can abort, by going through the CRM↔NICE cancel path. |

**Critical contract point:** Once the plugin has sent `session.claim` (state `IN_PROGRESS`), CRM-driven `session.abort` over WS A is **rejected** by BE with `status: REJECTED`, `reason: IN_PROGRESS_NOT_ABORTABLE`. To cancel after that point CRM goes through the CRM↔NICE channel and reports the outcome via `session.result(CANCELED)`. The plugin path no longer has an abort window after `session.claim`; the medicash UI back-out is the plugin's last abort opportunity.

---

## 9. Refund initiation — out of scope

Refund initiation is **out of scope** of this design (see §6.3 here and design doc §3.3). CRM uses its pre-existing CRM↔NICE refund channel for card-side reversal and its pre-existing trigger mechanism for backend 메디캐시 reversal. No refund-related messages are introduced on WS A by the NICE-paired contract.

For the orphan-charge case (BE EXPIRED + NICE actually approved), the same pre-existing mechanisms apply — see §10.5 and §10.6.

---

## 10. Edge cases — CRM POV

### 10.1 Plugin disconnect

Mostly invisible to CRM. BE handles plugin lifecycle.

| Plugin disconnect timing | CRM impact |
|---|---|
| Before `session.dispatch` reaches plugin (offline at create) | After 10s grace BE → CRM: `session.result(FAILED, DEVICE_OFFLINE)`. CRM aborts any planned NICE dispatch (it had no reason to dispatch yet). |
| After `device.register`, before `session.claim` (30s grace) | BE → CRM: `session.result(FAILED, PLUGIN_UNRESPONSIVE)`. No NICE action taken; no cleanup needed. |
| After `session.claim`, before `session.chargeContext` | BE → CRM: `session.result(EXPIRED)` after IN_PROGRESS timeout (see §10.3). No NICE action taken; CRM never received chargeContext. |
| After `session.chargeContext` (card path) | Irrelevant. CRM has already dispatched to NICE; the card transaction completes via firmware. CRM relays `session.result` normally. BE → CRM terminal echo continues. |
| After `session.chargeContext` (100% 메디캐시), before plugin's `session.result` | Narrow window. Session expires; no recovery (no `session.reconcile` in new flow). BE → CRM: `session.result(EXPIRED)`. CRM took no NICE action. |
| After plugin's `session.result` (100% 메디캐시) | Irrelevant — session already terminal. |

### 10.2 NICE failure

- Card declined / VAN error / NICE offline — NICE reports failure to CRM over the legacy channel.
- CRM → BE: `session.result(status=FAILED, niceResponse={…vendor error data…})`.
- BE marks `FAILED`, persists `niceResponse`, does **not** deduct medicash.
- BE → CRM: terminal `session.result` echo with `status=FAILED`.

### 10.3 Timeout (BE-driven)

CRM is a passive observer of timeouts.

| Timer | Threshold | CRM observable |
|---|---|---|
| DISPATCHED → no claim | 30s | `session.result(FAILED, PLUGIN_UNRESPONSIVE)` |
| IN_PROGRESS → no terminal | Extended (recommended 180s floor; exact value TBD per backend MD) | `session.result(EXPIRED)` |

The legacy `timeoutMs + 30s ≈ 90s` is **insufficient** with NICE in the loop (customer fumbling, multiple card attempts, slow VAN). Backend extends this; CRM does not need to action it but should not assume short timeouts when building the operator UX.

### 10.4 Session expiry semantics

`EXPIRED` is terminal. CRM treats it as failed for bookkeeping purposes. There is **no** `session.reconcile` in the new flow — the legacy reconcile loop is removed because there is no Toss SDK payment to recover from the Toss cache. If CRM observes an `EXPIRED` after dispatching to NICE, CRM must verify with NICE separately what state the card transaction ended in; if NICE in fact approved, CRM uses its pre-existing CRM↔NICE refund mechanism + pre-existing 메디캐시 reversal infrastructure (see §10.5). No contract recovery path is defined here.

**TIMEOUT caveat.** CRM observes `EXPIRED` only as the terminal timeout state. Legacy `TIMEOUT` is retained in the persistence schema but is **not** emitted by the NICE-paired state machine. (See design doc §2.)

### 10.5 Orphaned NICE approval (out of scope)

If BE EXPIRED a session but NICE actually approved the card charge, CRM uses its pre-existing CRM↔NICE refund mechanism to reverse the charge, plus the pre-existing backend 메디캐시 reversal infrastructure if 메디캐시 was involved. No contract recovery path is defined in this design (per design doc §3.3 and §6 "Late CRM result after BE EXPIRED").

### 10.6 Late CRM `session.result` after BE EXPIRED

If CRM relays a NICE terminal result (`SUCCEEDED` / `FAILED` / `CANCELED`) **after** BE has already marked the session `EXPIRED`:

- BE rejects the late `session.result` with `error: INVALID_STATE` per [toss-payment-flow.md §11](./superpowers/specs/toss-payment-flow.md).
- BE does **not** mutate the session record — state stays `EXPIRED`.
- CRM **must NOT retry** sending `session.result`. The rejection is final.
- If NICE in fact approved (orphan card charge), CRM uses its pre-existing CRM↔NICE refund mechanism + pre-existing 메디캐시 reversal infrastructure to reverse the charge. No contract recovery path is defined here — see §10.5.

(See design doc §6.)

### 10.7 메디캐시 deduction failure (informational)

If BE encounters a Hospital-side 메디캐시 deduction failure after the session is marked SUCCEEDED, BE emits an `error` frame on WS A with code `MEDICASH_DEDUCT_PENDING`. The terminal `session.result(SUCCEEDED)` still fires; the deduction is async-retried by BE. CRM should surface this error to the operator for follow-up but does not need to take protocol action — BE handles retry/escalation internally. (See design doc §6.)

---

## 11. What's removed vs. legacy CRM contract

For audit clarity — items the prior 2026-05-08 draft mentioned that no longer apply to CRM:

- **Refund flow entirely out of scope.** Uses pre-existing CRM↔NICE mechanism per §6.3 (and design doc §3.3). No `refund.dispatch` / `refund.result` extensions are added; these were planned in earlier drafts but are now never added. (See design doc §7.)
- **`toss-payment-flow.md §10` (legacy refund flow) is now obsolete for the NICE-paired flow.** CRM uses pre-existing infrastructure for any reversal need.
- **"Observational NICE result" framing.** Removed. NICE result is **not** observational; CRM actively relays it to BE via `session.result(NEW direction)`. BE's terminal echo remains the system-of-record value, but CRM's relay is the source of that value.
- **Backend Option A vs. Option B abort state machine.** Removed. The state machine is finalized (§2 of design doc). Plugin path is non-abortable after `session.claim`; NICE-side aborts come back over WS A as `session.result(CANCELED)`.
- **"Discounted-amount envelope name TBD".** Removed. Envelope is `session.chargeContext` (BE → CRM direction), with the same shape as the plugin's send.
- **"Skip-path bypass signal TBD".** Removed. CRM detects from `chargedSupplyValue + chargedTax == 0` directly — no separate signal.
- **CRM↔NICE protocol scoping question.** Closed for purposes of this doc. The protocol stays legacy and out of scope; this MD acknowledges it as a black-box channel and specifies only the conceptual messages exchanged (§5).
- **`session.dispatch (kind=cancel)` involvement.** Refund no longer flows through plugin (and refund is out of scope entirely for this contract).

No existing CRM → BE message shapes are dropped. All additions are new message types, not breaking changes.

---

## 12. Cross-reference: unchanged WS A messages

The following messages keep their legacy envelopes verbatim. See [toss-payment-flow.md](./superpowers/specs/toss-payment-flow.md) for full shapes:

- §2: `session.create` (CRM → BE), `session.ack` (BE → CRM)
- §3: `session.status` (BE → CRM) — **`DISPATCHED` and `IN_PROGRESS` transitions only**; terminal states (incl. `EXPIRED`) are delivered via `session.result`
- §7: `session.abort` (CRM → BE), `session.abort.ack` (BE → CRM)
- §11: `error` frame

Notable extension: the BE → CRM `session.result` envelope (§4.3 here) is the same shape as legacy but with `niceResponse` populated (or `null`), `tossResponse` always `null`, and a new top-level `failureReason` field for non-SUCCEEDED terminal states.

Refund messages from `toss-payment-flow.md §10` are **not** part of the NICE-paired contract — see §6.3 and §9.

---

## 13. Open items / TBDs

Only items from design doc §8 that touch CRM. Implementation details for other roles are tracked in their respective MDs.

| # | Item | Owner | CRM impact |
|---|---|---|---|
| 1 | Exact `niceResponse` envelope shape for FAILED/CANCELED payment variants (only SUCCEEDED example concrete in §4.2; CRM + Backend must converge before implementation kickoff) | CRM + Backend | CRM owns translating the legacy CRM↔NICE result into the JSON shape that goes onto WS A. Once both sides agree, this MD's §4.2 example will be tightened. |
| 2 | 100% 메디캐시 detection edge cases | CRM | The base rule `chargedSupplyValue + chargedTax == 0` is finalized. Edge cases (e.g., negative values from BE bugs, malformed payloads, or `pointUseAmount` mismatches that should never happen given BE's pre-forward validation) are TBD on CRM-side defensive handling. |

Items in design doc §8 not affecting CRM directly (exact IN_PROGRESS timeout value, `AWAITING_NICE` sub-status, 메디캐시 deduction retry/backoff policy on SUCCEEDED, plugin-side cleanup) live in the backend / frontend MDs.

**Out of scope for this MD (formerly TBD, now resolved by being out of scope):** medicash re-credit on refund. Refund flow is entirely out of scope (§6.3) and uses pre-existing infrastructure.
