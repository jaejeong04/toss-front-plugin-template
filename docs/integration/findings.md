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

(Pending Task 8.)

## Refund (`kind: cancel`)

(Pending Task 9.)

## 100% 메디캐시 (`tossResponse: null`)

(Pending Task 10.)
