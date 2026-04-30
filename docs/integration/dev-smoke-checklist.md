# Dev Smoke-Test Checklist — Toss Front Plugin ↔ Core

Backend dev URL: `wss://develop.api.core.smartdoctor.systems`
Token (dev): `crm_qalmighty`
Hospital (dev fixed): `99995`
Test customer: `411160` (이름: "테스트")

Reference Python harness: `smartdoctor-api/tools/toss-payment-test/` on `feature/toss-payment` branch (extract via `git checkout origin/feature/toss-payment -- tools/toss-payment-test/`).

## 0. Pre-flight: WS handshake

- [x] `plugin_client.py` connects to deployed dev with `--token crm_qalmighty` against `develop.api.core.smartdoctor.systems`, prints `connected Plugin WS: ...` + `device.registered`. (2026-04-30; initially 401 against `openapi` host — backend pointed us at `core` module.)
- [x] FE's `pluginWsUrl(...)` constructs the same URL shape (verified via Node-shim run of `config.js`).

## 1. Happy path (CRM creates session, plugin completes)

- [x] `plugin_client.py --use-points` running on terminal A
- [x] `crm_client.py --hospital-id 99995 --customer-number 411160` triggered on terminal B
- [x] CRM observes `session.ack` → `session.status DISPATCHED` → `session.status IN_PROGRESS` → `session.result SUCCEEDED`
- [x] Plugin observes `session.dispatch (kind=payment)` with `pointContext` populated → sends `session.claim`, `session.chargeContext`, `session.result`
- [x] Validation `pointUseAmount + chargedSupply + chargedTax + tip == original sum` passes (no `error` frame from Core)
- [x] Anomalies recorded in `findings.md`

## 2. Reconcile recovery (`late: true`)

- [x] Plugin in `--no-result` mode + CRM creates session → backend lands EXPIRED after ~90s
- [x] Plugin reconnects in `--reconcile-success` mode
- [x] Backend sends `session.reconcile` to plugin
- [x] Plugin replies `session.result` with `late: true`
- [x] CRM observes `session.result SUCCEEDED late=true` (after a prior `EXPIRED late=false` frame)
- [x] Wall-clock to expiry recorded in findings.md (~90s)

## 3. Refund flow (`kind: cancel`)

- [x] Successful payment session captured (`sessionId` recorded)
- [x] CRM `refund.create` triggered with that `originalSessionId`
- [x] Plugin receives `session.dispatch` with `kind: "cancel"` and well-formed `cancelParams` (paymentMethod, tax, supplyValue, timestamp, approvalNumber populated from original)
- [x] Plugin replies `refund.result`
- [x] CRM observes `refund.result SUCCEEDED` with full Toss cancel response

(Section 4 added in Task 10.)

## Quick repro (anyone)

```bash
# Terminal A: plugin mock — leave running for Tasks 7–10
python3 ~/Documents/jnitprojects/smartdoctor-api/tools/toss-payment-test/plugin_client.py \
  --base-url wss://develop.api.core.smartdoctor.systems \
  --serial TF-DEV-<initials>-001 --token crm_qalmighty --use-points

# Terminal B: CRM mock — sends one session.create then idles
python3 ~/Documents/jnitprojects/smartdoctor-api/tools/toss-payment-test/crm_client.py \
  --base-url wss://develop.api.core.smartdoctor.systems \
  --serial TF-DEV-<initials>-001 --token crm_qalmighty \
  --workstation-id ws-dev-<initials>-001 --hospital-id 99995 --customer-number 411160
```
