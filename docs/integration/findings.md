# Toss Backend Integration Findings

Captured during dev smoke testing on 2026-04-30 against `wss://develop.api.core.smartdoctor.systems` with token `crm_qalmighty`, hospital `99995`, test customer `411160` (테스트).

Reference harness: `smartdoctor-api/tools/toss-payment-test/{plugin,crm}_client.py` (feature/toss-payment branch).

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

## 100% 메디캐시 (`tossResponse: null`)

- **Status:** ❌ **FAIL — backend crashes on `tossResponse: null`**
- **Test:** Drove a session with explicit `pointContext.availableBalance: 999999` (so backend skips auto-enrichment), plugin replied with `session.result {pointUseAmount: 30000, chargedSupplyValue: 0, chargedTax: 0, tossResponse: null}`.
- **Observed sequence (plugin side):**
  1. `device.registered` ✅
  2. `session.dispatch` with our explicit `pointContext` passed through verbatim (good — backend honored "CRM이 명시적으로 넘긴 pointContext는 그대로 저장하고 plugin에 전달한다") ✅
  3. Plugin sent claim → chargeContext → result with `tossResponse: null` ✅
  4. Backend: `session.status IN_PROGRESS` (acknowledged claim) ✅
  5. Backend sent **WS close 1011 ("internal error")** immediately after receiving `session.result {tossResponse: null}` ❌
- **Diagnosis:** WS 1011 is a server-side unhandled exception, not a validation rejection. Backend's `session.result` handler does not handle `tossResponse: null`.
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
