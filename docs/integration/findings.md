# Toss Backend Integration Findings

Captured during dev smoke testing on 2026-04-30 against `wss://develop.api.core.smartdoctor.systems` with token `crm_qalmighty`, hospital `99995`, test customer `411160` (테스트).

Reference harness: `smartdoctor-api/tools/toss-payment-test/{plugin,crm}_client.py` (feature/toss-payment branch).

## Summary

| Flow | Status | Notes |
|---|---|---|
| WS handshake | ✅ pass | After host correction (openapi → core); FE config fixed in commit `cb85f03` |
| Happy path (CRM session.create → SUCCEEDED) | ✅ pass | Full Toss response forwarded to CRM; auto-pointContext enrichment works |
| Reconcile recovery (`late: true`) | ✅ pass | ~90s expiry, `session.reconcile` arrives, late SUCCEEDED forwarded |
| Refund (`kind: cancel`) | ✅ pass | `cancelParams` correctly built from persisted Toss fields |
| 100% 메디캐시 (`tossResponse: null`) | ❌ **FAIL** | Backend WS 1011 crash; session poisoned IN_PROGRESS. Backend fix needed. |

**Wire contract:** verified end-to-end. The FE wire fixes (commits `742bf07` → `cb85f03`) land cleanly against deployed dev.

**Outstanding production work:**
- Backend must handle `tossResponse: null` in `session.result` (or coordinate a sentinel shape with FE).
- `CORE_TOKEN` is hardcoded in [front-plugin-js/config.js:14](../../front-plugin-js/config.js); production token-fetch flow TBD (TODO comment in place).
- Open questions from spec §15 (trust model for unknown serials, `merchant.id` wire path) not addressed by this work.



## Pre-flight (WS handshake)

- **Status:** ✅ pass (after host correction)
- **Initial result:** HTTP 401 against `develop.api.openapi.smartdoctor.systems` for both `/ws/plugin` and `/ws/crm`.
- **Cause:** Backend WS endpoints live on the **core** module (`develop.api.core.smartdoctor.systems`), not the open-api module. Backend-team confirmed in Slack thread `C099YT4CL75` on 2026-04-30. FE `BACKEND_HOST` corrected in commit `cb85f03`.
- **After fix:** `plugin_client.py` connects, `device.registered` ack arrives.
- **Action:** Done (FE config updated). Worth flagging for the spec doc — `toss-payment-flow.md` uses `<core>` as a placeholder; we should annotate that this resolves to `develop.api.core.smartdoctor.systems` in dev.

## Happy Path (`session.create` → `session.result SUCCEEDED`)

- **Status:** ✅ pass
- **Test:** Default `session_create_request.json` body, customer 411160, `--use-points` on plugin mock.
- **Observed sequence:**
  - CRM: `connected` → `sent session.create` → `session.ack (CREATED)` → `session.status DISPATCHED` → `session.status IN_PROGRESS` → `session.result SUCCEEDED` ✅
  - Plugin: `device.registered` → `session.dispatch (kind=payment)` → `claimed` → `sent chargeContext` → `sent session.result type=SUCCESS` ✅
- **Final CRM payload:** complete — full `tossResponse` (CARD SUCCESS, approval `30021105`, masked PAN, timestamps), `pointUseAmount`, `chargedSupplyValue`, `chargedTax`, `amount` (CRM original), `late: false`.
- **Heartbeat:** bidirectional pongs observed on both sockets during the flow.
- **No `error` frames.**
- **Anomalies (none blocking):**
  1. `pointContext` was auto-enriched (CRM sent empty `{}`, backend filled it) but all values came back as **zeros** — `availableBalance: 0`, `minUseAmount: 0`, `earnAmount: 0`. Customer 411160 has no medicash balance/min-use config in the dev hospital DB. Means the points-use UI path didn't exercise. Resolve in Task 10 by overriding `pointContext.availableBalance` in a custom request body.
  2. `earnAmount: 0` returned despite `pointAccrualTargetAmount: 20000` — likely `accrualRate=0` for this customer in dev. Backend-side data, not a contract issue.
- **Action:** None on FE/backend; these are dev-data limitations.

## Reconcile (`late: true`)

- **Status:** ✅ pass
- **Test:** Plugin in `--no-result` mode → CRM creates session → plugin claims + chargeContext but never sends result → wait ~90s → plugin reconnects with `--reconcile-success` → fakes a SUCCESS reply.
- **Wall-clock to expiry:** ~90s (spec: `timeoutMs=60000` + 30s grace).
- **Observed sequence:**
  - First CRM frame after expiry: `session.result {status: EXPIRED, failureReason: EXPIRED, late: false, tossResponse: null}` — backend correctly preserves `chargedSupplyValue: 27273`, `chargedTax: 2727` from the prior chargeContext.
  - Plugin reconnect: `session.reconcile` arrives within seconds of `device.registered` ack.
  - After plugin replies: second CRM frame `session.result {status: SUCCEEDED, late: true, tossResponse: {...}}` — full Toss response forwarded.
- **Notable:** CRM receives **two** `session.result` frames for the same `sessionId` (EXPIRED then SUCCEEDED-late). CRM-side receipt-write must be idempotent — write only at SUCCEEDED, regardless of order. This isn't a contract change for the plugin (FE never receives the EXPIRED — backend handled it internally), but worth flagging to the CRM team.
- **Action:** None on FE. Recommend backend team verify CRM idempotency handling — out of FE scope.

## Refund (`kind: cancel`)

- **Status:** ✅ pass
- **Test:** Drove a fresh happy-path session (sessionId `bef06976-…`), then sent `refund.create` over a one-off CRM WS connection with that `originalSessionId`.
- **`cancelParams` from backend `session.dispatch (kind=cancel)`:**
  - `paymentKey: bef06976-…` (matches original) ✓
  - `paymentMethod: "CARD"` ✓
  - `tax: 2727`, `supplyValue: 27273`, `tip: 0` (post-point — same as the chargeContext we sent on the original session) ✓
  - `timestamp: 1777512422214`, `approvalNumber: "30021105"` (from original Toss SUCCESS response, persisted by backend) ✓
  - `installment: 0`, `timeoutMs: 60000`, `localeCode: "ko"` ✓
- **Plugin response:** `refund.result {refundId: 716e0b6c-…, tossResponse: SUCCESS}` (mock approvalNumber `30021106`).
- **CRM-side `refund.result`:** `{status: "SUCCEEDED", refundId, originalSessionId, tossResponse: {full new card SUCCESS}}` ✓
- **Action:** None. Backend correctly builds cancel params from persisted state and round-trips the response. The contract is solid.

## Real-card device test (1,000원 + immediate refund)

- **Date:** 2026-04-30
- **Card:** Samsung Mastercard
- **Amount:** 1,000원 (909 supply + 91 tax)
- **Outcome:** ✅ payment succeeded; ✅ refund eventually succeeded; net-zero on card.
- **Real Toss response:** approval `06903313`, van `KIS`, shopCode `193175545`.

**🐛 Bug discovered during this test (terminal-screen-bricks-device):**

After the payment SUCCESS terminal rendered, tapping `확인` on the success screen left the device on a blank/white screen. From backend's perspective the device went **offline** — its WS connection dropped because the plugin blanked. First refund attempt returned:

```json
{
  "status": "FAILED",
  "failureReason": "REFUND_REJECTED_BY_TOSS",
  "tossResponse": { "type": "FAILED", "response": { "reason": "DEVICE_OFFLINE" } }
}
```

After rebooting the device (which re-loaded home.html → re-connected WS), the refund completed cleanly. So the contract is fine — there's a UI lifecycle bug in our plugin between "terminal render" and "return to idle".

**Hypothesis:** `sdk.app.setIdle()` from the success-screen button (`payment.html:133`) is returning the device to OS idle but the plugin's WebView retains whatever was last shown (or shows blank). When the user wakes the device, no fresh `home.html` mounts, no WS reconnects.

**Symptom family:** Same "blank screen, plugin dead" failure mode as the back-arrow bug (Task 12) — different trigger, same hole. The onBack fix made back-arrow safe, but **every transition that just calls `setIdle()` without re-mounting `home.html` is suspect.** Audit pending.

**Numeric note (non-blocking):** `chargedSupplyValue: 910.0` and `chargedTax: 90.0` (floats!) were sent by plugin even though request was 909/91. Validation passed (1000 == 1000), but the breakdown drifted by 1원 each. Likely a float-math artifact in payment.html's charged-amount calculation. Not pursuing now; flag if it ever causes downstream issues.

## 100% 메디캐시 (`tossResponse: null`)

- **Status:** ❌ **FAIL — backend crashes on `tossResponse: null`**
- **Test:** Drove a session with explicit `pointContext.availableBalance: 999999` (so backend skips auto-enrichment), plugin replied with `session.result {pointUseAmount: 30000, chargedSupplyValue: 0, chargedTax: 0, tossResponse: null}`.
- **Observed sequence (plugin side):**
  1. `device.registered` ✅
  2. `session.dispatch` with our explicit `pointContext` passed through verbatim (good — backend honored "CRM이 명시적으로 넘긴 pointContext는 그대로 저장하고 plugin에 전달한다") ✅
  3. Plugin sent claim → chargeContext → result with `tossResponse: null` ✅
  4. Backend: `session.status IN_PROGRESS` (acknowledged claim) ✅
  5. Backend sent **WS close 1011 ("internal error")** immediately after receiving `session.result {tossResponse: null}` ❌
- **CRM-side observed (Terminal B):** `session.ack` → `session.status DISPATCHED` → `session.status IN_PROGRESS` → **then nothing** (only heartbeat pongs). No terminal `session.result`, no `error` frame. The session is stuck IN_PROGRESS on the backend side from CRM's perspective.
- **Diagnosis:** WS 1011 is a server-side unhandled exception, not a validation rejection. Backend's `session.result` handler does not handle `tossResponse: null`.
- **Severity bump:** This isn't only a happy-path-rejection bug. The crash poisons the session — backend persists the session as IN_PROGRESS, watchdog will eventually expire it (~90s, per Task 8), and on reconcile the plugin would replay the same `tossResponse: null` payload and trigger the same crash. **Sessions in this state cannot resolve cleanly via the existing recovery flow.**
- **Spec context:**
  - FE spec `2026-04-27-frontend-plugin.md` says: when `charged === 0` (treatment fully covered by medicash), plugin skips `requestPayment` and sends `session.result` with `tossResponse: null`. FE commit `cbcc11d` (2026-04-29) implements this.
  - Backend deployed-flow doc `toss-payment-flow.md` §6 example shows `tossResponse` always populated. The null path is not specified.
  - The two specs disagree. FE behavior follows its spec; backend lacks corresponding handling.
- **Recommended backend fix (any of):**
  1. Accept `tossResponse: null` in `session.result` payload, treat as POINTS_ONLY: mark session SUCCEEDED, set `toss_payment_method = null`, forward `tossResponse: null` to CRM.
  2. Define a sentinel shape (e.g. `tossResponse: { type: "POINTS_ONLY", response: null }`) and update FE to send that instead.
  3. Update both specs to align on whichever choice.
- **FE-side action (if backend picks option 2):** Trivial change in [front-plugin-js/payment.html:108-118](../../front-plugin-js/payment.html) — replace `tossResponse: null` with the agreed sentinel.
- **Action: file with backend in Slack thread `C099YT4CL75`.** Reproduce: `python3 tools/100pct-medicash-test.py --token crm_qalmighty` against deployed dev with the override JSON.

## Non-zero `pointUseAmount` (any medicash use)

- **Status:** ❌ **FAIL — backend crashes on non-zero `pointUseAmount` in `session.result`**
- **Date:** 2026-04-30
- **Original session:** `b1a2dfa0-0866-4708-bf0a-3eec36ce974f`
- **Test setup:** CRM `session.create` with explicit `pointContext.availableBalance: 500` against 1,000원 total ([tools/device-test-request-medicash.json](../../tools/device-test-request-medicash.json)). Real Samsung Mastercard, real Toss SDK call.
- **What the device user did:** order page → tapped 메디캐시 사용 → use-points page applied **all 500원** (Toss Front UI is all-or-none by design — no partial amount entry possible) → returned to order page showing 500원 to charge → Toss SDK card terminal → tapped card → real-card SUCCESS screen with valid approval number → 확인 → idle. **No user-visible failure on the device.**
- **Observed sequence (CRM side):** `session.ack` → `session.status DISPATCHED` → `session.status IN_PROGRESS` → CRM WS aborted **TCP-level** (`no close frame received or sent`) before any `session.result` arrived.
- **The reason device looked clean:** plugin's Task 17 auto-reconnect re-opened the WS after backend dropped it, masking the backend crash from the device user.
- **Refund attempt confirmation:** `refund.create` against the same `originalSessionId` over a fresh CRM WS → **WS close 1011 (internal error)** immediately, no `error` frame, no plugin dispatch (device stayed idle). Confirms the original session is stuck `IN_PROGRESS` with partially-written state on backend.
- **Diagnosis:** `session.result` handler crashes on the points-application code path when `pointUseAmount > 0`, even with valid `tossResponse`. Different trigger from the 100%-medicash bug (non-zero `pointUseAmount` + valid `tossResponse`), same crash family (WS 1011, session poisoned).
- **Why this wasn't caught earlier:** the Python harness's "happy path with `--use-points`" test ran against customer 411160 whose auto-enriched `pointContext.availableBalance` was 0 → `pointUseAmount = 0` end-to-end → never exercised the points-application path. Today's test is the first time non-zero `pointUseAmount` was driven end-to-end on dev.
- **Production blast radius:** **100% of medicash use crashes backend.** The Toss Front use-points UI is all-or-none (no partial amount entry possible — UI constraint, intended), so every customer who taps "use points" will land in one of two crash paths:
  - `availableBalance >= total` → 100%-medicash null-tossResponse crash (existing bug above)
  - `availableBalance < total` → non-zero `pointUseAmount` crash (this bug)
- **Real-money side effect:** 500원 was captured on the user's Samsung Mastercard. Cannot be refunded via the broken session (refund handler crashes too). Backend team to either fix the bug + heal the session, or issue a Toss admin cancel directly.
- **Severity:** higher than 100%-medicash bug. Mixed-payment is the dominant production path; 100% coverage is rarer.
- **Action: file with backend in Slack thread `C099YT4CL75`** alongside the 100%-medicash bug. Two-bug pattern strongly suggests medicash code paths need a defensive audit, not one-off fixes.
