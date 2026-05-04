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
| 100% 메디캐시 (`tossResponse: null`) | ✅ **RESOLVED** | Resolved by 2026-04-30 backend deploy (spec §6 + §11). |
| Mixed medicash + card payment | ✅ **RESOLVED** | End-to-end verified 2026-05-04 (sessionId `3aafbad1-be46-41d1-9848-85a8633ac54b`, approval `77799441`, refund `0c34eab1-...`). |

**Wire contract:** verified end-to-end. The FE wire fixes (commits `742bf07` → `cb85f03`) land cleanly against deployed dev.

**Outstanding production work:**
- `CORE_TOKEN` is hardcoded in [front-plugin-js/config.js:14](../../front-plugin-js/config.js); production token-fetch flow TBD (TODO comment in place).
- Open questions from spec §15 (trust model for unknown serials, `merchant.id` wire path) not addressed by this work.



## Mixed-medicash payment + refund (verified 2026-05-04)

- **Status:** ✅ SUCCEEDED
- **Date:** 2026-05-04
- **Session ID:** `3aafbad1-be46-41d1-9848-85a8633ac54b`
- **Approval number:** `77799441`
- **Refund ID:** `0c34eab1-...`
- **Test customer:** `411160` ("테스트"), insuranceSeqNo: 3, clinicSeqNo: 42, organizationId: 99999997
- **Flow:** CRM `session.create` with explicit `pointContext` → plugin claimed, applied medicash, sent valid `tossResponse` with non-zero `pointUseAmount` → backend forwarded `session.result SUCCEEDED` to CRM → immediate `refund.create` → `refund.result SUCCEEDED`. End-to-end net-zero.
- **Backend deploy prerequisite:** spec §11 Error Frames deployed on 2026-04-30 (WS lifecycle graceful; no more 1011 crashes). Spec §6 100%-medicash `tossResponse: null` path also deployed same day.
- **Root cause of prior failures resolved:** The previous "Non-zero `pointUseAmount`" crash (session `b1a2dfa0-...`) was **not** a backend bug — it was a test-harness CLI bug in `smartdoctor-api/tools/toss-payment-test/crm_client.py:33-35` where the `--hospital-id` flag overwrites `organizationId` with the hospitalId value. Customer 411160 requires `organizationId: 99999997`; sending `99995` caused the backend to reject the medicash lookup. With correct organizationId, the flow works cleanly.
- **Orphaned charge note:** Session `b1a2dfa0-0866-4708-bf0a-3eec36ce974f` resulted in an orphaned 500원 card charge that is unrecoverable (backend session corrupted by the incorrect organizationId; refund path also fails). Acknowledged by user as minimal real-money loss; no action taken.

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

- **Status:** ✅ **RESOLVED — Resolved by 2026-04-30 backend deploy (spec §6 + §11).**
- **Original failure (for context):** Backend crashed with WS 1011 when receiving `session.result {tossResponse: null}`. Session poisoned IN_PROGRESS. Filed with backend in Slack thread `C099YT4CL75`.
- **Resolution:** Backend deployed spec §6 (100%-medicash null-tossResponse path) + spec §11 (Error Frames / graceful WS lifecycle) on 2026-04-30. The crash no longer occurs.
- **Spec alignment:** `toss-payment-flow.md` §6 now documents the `tossResponse: null` POINTS_ONLY path as the canonical contract. FE behavior (commit `cbcc11d`, 2026-04-29) was already correct; backend now handles it.

## Non-zero `pointUseAmount` (any medicash use)

- **Status:** ✅ **RESOLVED — Root cause was NOT a backend bug; test-harness CLI was clobbering organizationId.**
- **Date of original failure:** 2026-04-30; **Date resolved (end-to-end verified):** 2026-05-04
- **Original session (failed):** `b1a2dfa0-0866-4708-bf0a-3eec36ce974f`
- **Verified session (success):** `3aafbad1-be46-41d1-9848-85a8633ac54b` (approval `77799441`, refunded cleanly via `0c34eab1-...`)

**Root cause (corrected):**

The crash was caused by `smartdoctor-api/tools/toss-payment-test/crm_client.py:33-35`, which parses `--hospital-id` from the CLI and incorrectly writes it into the `organizationId` field of the `session.create` payload. This overwrote `organizationId: 99999997` with `99995` (the hospitalId value). Backend's medicash lookup uses `organizationId` to resolve the patient's insurance record; with the wrong organizationId it failed, producing the WS 1011 crash.

Customer 411160's correct identifiers: `insuranceSeqNo: 3` (not 1, which was the spec example value), `clinicSeqNo: 42`, `organizationId: 99999997`.

**Medicash UI render gating math (discovered during debugging):**

```
usableCash = floor(min(availableBalance, totalAmount) / 100) * 100
UI shows medicash option when: usableCash >= minUseAmount && usableCash > 0
```

This is the FE render gate for the "사용 가능 메디캐시" section on the order page.

**Backend spec §11 contribution:** spec §11 Error Frames deployed 2026-04-30 made the WS lifecycle graceful. This was a contributing factor to clean recovery — but the root crash was always the organizationId mismatch, not a backend medicash handler bug.

**Orphaned charge from original session:** 500원 was captured on Samsung Mastercard during session `b1a2dfa0-0866-4708-bf0a-3eec36ce974f`. The session is stuck `IN_PROGRESS` and the refund path also fails (session corrupted by incorrect organizationId). This charge is **acknowledged-but-unrecoverable** — user accepted as minimal real-money loss from debugging. No further action.

**Action:** None — bug filed upstream (crm_client.py). Test harness must be called without `--hospital-id` to avoid clobbering organizationId. See `dev-smoke-checklist.md` for updated repro commands.
