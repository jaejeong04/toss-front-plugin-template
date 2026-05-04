> **Status: Historical / superseded**
>
> This document captures the contract as of 2026-04-29. The deployed canonical
> spec is now `docs/superpowers/specs/toss-payment-flow.md` (updated 2026-04-30
> with §6 100%-medicash + §11 error frames + clinicSeqNo rename). Refer to that
> file for current behavior; this one is kept for context on the design journey.

# Toss Backend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `front-plugin-js` to the deployed dev Core backend (`wss://develop.api.openapi.smartdoctor.systems`), then drive the happy path, recovery, refund, and 100%-메디캐시 flows end-to-end against the live deployed Core to validate the wire contract.

**Architecture:** The FE is already ~85–90% spec-aligned (all 7 outbound + 6 inbound WS message types implemented; 20s heartbeat; `getPayment` recovery with `late:true`; 100%-메디캐시 skip). The remaining work is a wire fix (WS URL path is `/plugin?serial=...` in three call sites — must become `/ws/plugin?serial=...&token=<coreToken>` per the deployed `toss-payment-flow.md`) plus a series of smoke tests against the deployed dev Core. We're testing against deployed (not local) because `smartdoctor-api` requires Kafka + remote SQL Server + two Spring Boot apps, and 진수민 confirmed dev is the right target.

**Tech Stack:**
- FE plugin: vanilla JS (HTML pages + `sdk.js` + `config.js`), runs inside Toss Front SDK WebView
- Backend: Spring Boot Core (port 8088 locally; deployed at `develop.api.openapi.smartdoctor.systems`) + Hospital + Postgres/SQL Server, communicating via Feign internally
- Smoke harness: `tools/toss-payment-test/{plugin_client.py,crm_client.py}` in `smartdoctor-api` repo on `feature/toss-payment` branch (Python `websockets` lib)

**Dev environment constants (from backend team, 2026-04-29):**
- WS base URL: `wss://develop.api.openapi.smartdoctor.systems`
- Plugin path: `/ws/plugin?serial=<deviceSerialNumber>&token=<coreToken>`
- CRM path: `/ws/crm?token=<workstationToken>`
- `coreToken` for dev: `crm_qalmighty` (same value used by both CRM and plugin in dev — backend dev env has loose auth; production will differ)
- Test hospital: `99995` (fixed in dev)
- Test serial suggestion: `TF-DEV-<your-initials>` so we don't collide with 진수민/박민후 sessions

**Spec files (in this repo):**
- `docs/superpowers/specs/2026-04-27-frontend-plugin.md` (1129 lines) — plugin contract
- `docs/superpowers/specs/2026-04-27-backend.md` (995 lines) — backend contract
- `docs/superpowers/specs/2026-04-27-crm-integration.md` (691 lines) — CRM contract
- `docs/superpowers/specs/toss-payment-flow.md` (created in Task 1) — deployed flow doc

**Out of scope:**
- No code review or refactor of the existing FE recovery/heartbeat logic. It's audited and working — only the URL changes.
- No backend code changes. If a smoke test exposes a backend bug, file a delta in `docs/integration/findings.md` and surface it to backend; don't touch `smartdoctor-api`.
- No Toss-device-side testing. Smoke tests use the Python `plugin_client.py` mock to validate the wire; live SDK calls (`requestPayment`, `requestPaymentCancel`) require physical hardware and are out of scope here.
- No production token/auth design.

---

## File Structure

**Files that will be created:**
- `docs/superpowers/specs/toss-payment-flow.md` — canonical copy of the deployed flow doc (currently only at `~/Downloads/toss-payment-flow.md`)
- `docs/integration/dev-smoke-checklist.md` — step-by-step recipe for repeating the smoke tests
- `docs/integration/findings.md` — per-flow notes/anomalies captured during smoke tests; lives alongside checklist

**Files that will be modified:**
- `front-plugin-js/config.js` — add `CORE_TOKEN` constant + `pluginWsUrl(serialNumber)` helper (so URL/token shape lives in one place)
- `front-plugin-js/home.html:45-49` — call new helper instead of constructing path inline
- `front-plugin-js/order.html:65-69` — same
- `front-plugin-js/payment.html:385-389` — same

No test files. The plugin has no test infra (it's a vanilla browser bundle loaded by Toss Front SDK). Verification = a live WS handshake against deployed dev Core. The wire-level "test" is `wscat` or the upstream `plugin_client.py` confirming a `device.registered` ack arrives.

---

## Task 1: Capture deployed flow doc into repo

**Why:** The deployed flow doc (`toss-payment-flow.md`) currently lives only in `~/Downloads/` (sent over Slack). Without it in the repo, future engineers reading the spec docs will miss the *actually-deployed* contract (which differs from the original 2026-04-27 specs in the WS URL path and the `pointAccrualTargetAmount` → `pointContext` enrichment rule). The other three spec MDs already live in `docs/superpowers/specs/`; this fourth one belongs there too.

**Files:**
- Create: `docs/superpowers/specs/toss-payment-flow.md`

- [ ] **Step 1: Copy the doc into the repo**

```bash
cp ~/Downloads/toss-payment-flow.md \
   /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/docs/superpowers/specs/toss-payment-flow.md
```

- [ ] **Step 2: Verify file is in place and readable**

```bash
wc -l /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/docs/superpowers/specs/toss-payment-flow.md
head -3 /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/docs/superpowers/specs/toss-payment-flow.md
```
Expected: ~738 lines; first line is `# Toss Payment Backend Flow`.

- [ ] **Step 3: Commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add docs/superpowers/specs/toss-payment-flow.md
git commit -m "docs: capture deployed toss-payment-flow.md alongside other specs"
```

---

## Task 2: Add CORE_TOKEN config + pluginWsUrl helper to config.js

**Why:** Three pages today construct the WS URL inline as `/plugin?serial=<x>`. The deployed contract requires `/ws/plugin?serial=<x>&token=<token>`. Centralizing the URL+token construction in one helper means the prod-vs-dev token swap (and any future token-fetch logic, e.g. via `sdk.app.getMerchant()`) is a one-line change later, not a three-place edit.

The token is currently a hardcoded dev value. We'll add a TODO comment pointing at the production decision.

**Files:**
- Modify: `front-plugin-js/config.js`

- [ ] **Step 1: Read the current config.js to confirm the surface we're modifying**

```bash
sed -n '1,15p' /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/front-plugin-js/config.js
```
Expected: lines 1–14 show `window.smartdoctor.config = { BACKEND_HOST: ... }`, the `backendWsUrl(path)` helper, and `PENDING_KEY`.

- [ ] **Step 2: Replace the config block with the token + helper**

Edit `front-plugin-js/config.js`. Replace lines 1–11 (everything from `window.smartdoctor = ...` through the closing `};` of `backendWsUrl`) with:

```js
window.smartdoctor = window.smartdoctor || {};

window.smartdoctor.config = {
  // Dev backend host — must match the Toss test project's ACL (URL).
  // Swap for the live host before promoting to 라이브 배포.
  BACKEND_HOST: "develop.api.openapi.smartdoctor.systems",

  // Dev-only token. Backend confirmed `crm_qalmighty` is accepted on dev for
  // both CRM and plugin sockets (loose dev auth). Production token sourcing is
  // an open question — likely sdk.app.getMerchant() + a separate login HTTP
  // call, or a token issued by the Toss partner-portal device registration.
  // TODO(prod-token): replace this constant with the real token-fetch flow
  // before live deploy. See docs/superpowers/specs/toss-payment-flow.md §1.
  CORE_TOKEN: "crm_qalmighty",
};

window.smartdoctor.backendWsUrl = function (path) {
  return `wss://${window.smartdoctor.config.BACKEND_HOST}${path}`;
};

// Plugin WS B URL builder. Per docs/superpowers/specs/toss-payment-flow.md §1
// the path is `/ws/plugin` (not `/plugin`) and requires both `serial` and
// `token` query params. Centralized so the token-source change later touches
// one line.
window.smartdoctor.pluginWsUrl = function (serialNumber) {
  const path =
    "/ws/plugin?serial=" +
    encodeURIComponent(serialNumber) +
    "&token=" +
    encodeURIComponent(window.smartdoctor.config.CORE_TOKEN);
  return window.smartdoctor.backendWsUrl(path);
};
```

Keep all subsequent code (line 13 onward — `PENDING_KEY`, `runPendingPaymentRecovery`) untouched.

- [ ] **Step 3: Verify the helper builds the right URL**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
node -e '
  global.window = {};
  require("./front-plugin-js/config.js");
  console.log(window.smartdoctor.pluginWsUrl("TF-DEV-001"));
'
```
Expected output:
```
wss://develop.api.openapi.smartdoctor.systems/ws/plugin?serial=TF-DEV-001&token=crm_qalmighty
```

- [ ] **Step 4: Commit**

```bash
git add front-plugin-js/config.js
git commit -m "feat(front-plugin-js): add CORE_TOKEN + pluginWsUrl helper for /ws/plugin path"
```

---

## Task 3: Switch home.html to pluginWsUrl helper

**Why:** [home.html:45-49](../../../front-plugin-js/home.html) is the long-lived dispatcher socket. It's the first WS the plugin opens after boot. If this URL is wrong, nothing else works.

**Files:**
- Modify: `front-plugin-js/home.html:45-49`

- [ ] **Step 1: Read the current call site**

```bash
sed -n '43,50p' /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/front-plugin-js/home.html
```
Expected: shows `new WebSocket(window.smartdoctor.backendWsUrl("/plugin?serial=" + encodeURIComponent(serialNumber)))`.

- [ ] **Step 2: Replace with helper call**

Edit `front-plugin-js/home.html`. Replace exactly:

```js
        const ws = new WebSocket(
          window.smartdoctor.backendWsUrl(
            "/plugin?serial=" + encodeURIComponent(serialNumber),
          ),
        );
```

with:

```js
        const ws = new WebSocket(window.smartdoctor.pluginWsUrl(serialNumber));
```

(Keep the surrounding comment about WS B unchanged — but if the comment is on the same line range as the replaced block, preserve it above the new line.)

- [ ] **Step 3: Verify by grep**

```bash
grep -n "pluginWsUrl\|/plugin?serial=" /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/front-plugin-js/home.html
```
Expected: one match (`pluginWsUrl(serialNumber)`); no matches for the old `/plugin?serial=` literal.

- [ ] **Step 4: Commit**

```bash
git add front-plugin-js/home.html
git commit -m "fix(front-plugin-js): home.html WS URL via pluginWsUrl (was /plugin, now /ws/plugin+token)"
```

---

## Task 4: Switch order.html to pluginWsUrl helper

**Why:** [order.html:65-69](../../../front-plugin-js/order.html) opens its own short-lived WS to send `session.claim`. Same fix as home.html.

**Files:**
- Modify: `front-plugin-js/order.html:65-69`

- [ ] **Step 1: Read the current call site**

```bash
sed -n '63,70p' /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/front-plugin-js/order.html
```

- [ ] **Step 2: Replace with helper call**

Edit `front-plugin-js/order.html`. Replace exactly:

```js
        const ws = new WebSocket(
          window.smartdoctor.backendWsUrl(
            "/plugin?serial=" + encodeURIComponent(serialNumber),
          ),
        );
```

with:

```js
        const ws = new WebSocket(window.smartdoctor.pluginWsUrl(serialNumber));
```

- [ ] **Step 3: Verify by grep**

```bash
grep -n "pluginWsUrl\|/plugin?serial=" /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/front-plugin-js/order.html
```
Expected: one match (`pluginWsUrl(serialNumber)`); no matches for the old `/plugin?serial=` literal.

- [ ] **Step 4: Commit**

```bash
git add front-plugin-js/order.html
git commit -m "fix(front-plugin-js): order.html WS URL via pluginWsUrl"
```

---

## Task 5: Switch payment.html to pluginWsUrl helper

**Why:** [payment.html:385-389](../../../front-plugin-js/payment.html) opens the WS used to send `session.chargeContext`, `session.result`, and `refund.result`. Last call site to fix.

**Files:**
- Modify: `front-plugin-js/payment.html:385-389`

- [ ] **Step 1: Read the current call site**

```bash
sed -n '383,390p' /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/front-plugin-js/payment.html
```

- [ ] **Step 2: Replace with helper call**

Edit `front-plugin-js/payment.html`. Replace exactly:

```js
        const ws = new WebSocket(
          window.smartdoctor.backendWsUrl(
            "/plugin?serial=" + encodeURIComponent(serialNumber),
          ),
        );
```

with:

```js
        const ws = new WebSocket(window.smartdoctor.pluginWsUrl(serialNumber));
```

- [ ] **Step 3: Verify all three pages converted**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
grep -rnE "/plugin\?serial=" front-plugin-js/
grep -rnE "pluginWsUrl\(" front-plugin-js/
```
Expected:
- First grep: zero hits (the legacy URL is fully gone).
- Second grep: three hits — one in each of `home.html`, `order.html`, `payment.html`.

- [ ] **Step 4: Commit**

```bash
git add front-plugin-js/payment.html
git commit -m "fix(front-plugin-js): payment.html WS URL via pluginWsUrl"
```

---

## Task 6: Verify URL handshake against deployed dev Core

**Why:** Before driving any business logic, confirm the URL change actually lands a registered WS connection on deployed Core. If `device.register` doesn't ack, no other test will work — and we'd be debugging the wrong layer.

The cleanest tool is the upstream `plugin_client.py` because it's the team's reference implementation. If it works, the dev backend is healthy. Then we cross-check our FE against the same URL.

**Files:**
- Create: `docs/integration/dev-smoke-checklist.md` (initial skeleton, expanded in later tasks)

- [ ] **Step 1: Confirm Python `websockets` lib is available, install if not**

```bash
python3 -c "import websockets; print(websockets.__version__)"
```
If `ModuleNotFoundError`, run `python3 -m pip install --user websockets` and re-check.

- [ ] **Step 2: Run reference `plugin_client.py` against deployed dev**

```bash
cd /Users/jaejeong/Documents/jnitprojects/smartdoctor-api
git fetch origin feature/toss-payment
git checkout origin/feature/toss-payment -- tools/toss-payment-test/
python3 tools/toss-payment-test/plugin_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty
```
Expected: prints `connected Plugin WS: wss://...` then no further output (sits waiting for `session.dispatch`). Stays connected for at least 60s with no close. **Ctrl-C to stop.**

If WS handshake fails (e.g. HTTP 401, 403, or instant close), the dev backend is rejecting our token — stop and re-confirm with backend team. Don't proceed.

- [ ] **Step 3: Open the FE plugin in a browser pointed at the same dev backend**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
python3 -m http.server 8080 --directory front-plugin-js
```

In a browser (Chrome/Edge), open: `http://localhost:8080/home.html`

The plugin will fail to load `sdk.js` because we're not inside the Toss Front SDK WebView. **That's expected.** What we're checking: does the WS connection at least *attempt* to open against the right URL?

Open DevTools → Network → WS tab → reload the page. Find the WS row.

Expected:
- URL column: `wss://develop.api.openapi.smartdoctor.systems/ws/plugin?serial=...&token=crm_qalmighty`
- Status: 101 (switching protocols) — though it may immediately fail because `sdk.app.getSerialNumber()` throws outside SDK; the URL we constructed is what matters.

If URL is missing `/ws/` prefix or `token=`, go back and fix.

- [ ] **Step 4: Initialize the smoke-test checklist doc**

Create `docs/integration/dev-smoke-checklist.md`:

```markdown
# Dev Smoke-Test Checklist — Toss Front Plugin ↔ Core

Backend dev URL: `wss://develop.api.openapi.smartdoctor.systems`
Token (dev): `crm_qalmighty`
Hospital (dev fixed): `99995`

Reference Python harness lives in `smartdoctor-api` repo, `feature/toss-payment` branch, `tools/toss-payment-test/`.

## 0. Pre-flight: WS handshake

- [ ] `plugin_client.py` connects to deployed dev with `--token crm_qalmighty`, prints `connected Plugin WS: ...`, stays open ≥60s.
- [ ] FE plugin's WS URL in DevTools → Network → WS tab matches `wss://develop.api.openapi.smartdoctor.systems/ws/plugin?serial=...&token=crm_qalmighty`.

(Sections 1–4 added in later tasks.)
```

- [ ] **Step 5: Commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add docs/integration/dev-smoke-checklist.md
git commit -m "docs(integration): dev smoke-test checklist scaffold + URL handshake verified"
```

---

## Task 7: Smoke-test happy path (CRM creates session, plugin completes)

**Why:** This is the load-bearing scenario. CRM-side `session.create` → backend dispatch → plugin claim → chargeContext → result → backend forwards to CRM. If this works frame-for-frame against deployed Core, the wire contract is solid.

We use both Python clients (the reference plugin and CRM mocks) before introducing the real FE — that way any deviation later isolates to "FE differs from reference," not "backend behavior is wrong."

**Files:**
- Modify: `docs/integration/dev-smoke-checklist.md` — append Section 1
- Modify: `docs/integration/findings.md` (create on first anomaly)

- [ ] **Step 1: Run the reference plugin client in one terminal**

```bash
cd /Users/jaejeong/Documents/jnitprojects/smartdoctor-api
python3 tools/toss-payment-test/plugin_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty \
  --use-points
```

Leave running. Expected: `connected Plugin WS: ...` and silence (waiting for dispatch).

- [ ] **Step 2: In a second terminal, run the CRM client to create a session**

```bash
cd /Users/jaejeong/Documents/jnitprojects/smartdoctor-api
python3 tools/toss-payment-test/crm_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty \
  --workstation-id ws-dev-jj-001 \
  --hospital-id 99995 \
  --customer-number CUST000123
```

- [ ] **Step 3: Confirm the expected message sequence on both terminals**

Per `tools/toss-payment-test/README.md`:

CRM terminal should print (in order):
1. `sent session.create`
2. `session.ack`
3. `session.status DISPATCHED`
4. `session.status IN_PROGRESS`
5. `session.result` with `status=SUCCEEDED`

Plugin terminal should print (in order):
1. `session.dispatch` (kind=payment) with `pointContext` populated by Core
2. `claimed session ses_...`
3. `sent chargeContext session=ses_... pointUseAmount=<n>`
4. `sent session.result session=ses_... type=SUCCESS`

If any frame is missing or shaped differently from the reference: write a finding (next step).

- [ ] **Step 4: For each anomaly, append to findings.md**

Create `docs/integration/findings.md` if missing:

```markdown
# Toss Backend Integration Findings

Captured during dev smoke testing on YYYY-MM-DD against `wss://develop.api.openapi.smartdoctor.systems` with token `crm_qalmighty`.

## Happy Path
- Status: ✅ pass / ❌ fail / ⚠️ partial
- Observed: <what actually happened, frame-by-frame>
- Expected: <what spec/reference said>
- Delta: <difference>
- Action: <file backend issue / FE fix / N/A>
```

Fill in the Happy Path section based on what you saw.

- [ ] **Step 5: Append Section 1 to the checklist**

Append to `docs/integration/dev-smoke-checklist.md`:

```markdown
## 1. Happy path (CRM creates session, plugin completes)

- [ ] `plugin_client.py --use-points` running on terminal A
- [ ] `crm_client.py --hospital-id 99995 --customer-number <X>` triggered on terminal B
- [ ] CRM observes `session.ack` → `session.status DISPATCHED` → `session.status IN_PROGRESS` → `session.result SUCCEEDED`
- [ ] Plugin observes `session.dispatch (kind=payment)` with `pointContext` populated → sends `session.claim`, `session.chargeContext`, `session.result`
- [ ] Validation `pointUseAmount + chargedSupply + chargedTax + tip == original sum` passes (no `error` frame from Core)
- [ ] Anomalies recorded in `findings.md`
```

- [ ] **Step 6: Commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add docs/integration/dev-smoke-checklist.md docs/integration/findings.md
git commit -m "docs(integration): smoke-test happy path against deployed dev"
```

---

## Task 8: Smoke-test session.reconcile recovery with `late:true`

**Why:** Spec §9 (`toss-payment-flow.md`) says when a session expires (`IN_PROGRESS > timeoutMs + 30s`), backend transitions it to `EXPIRED`, then on plugin reconnect sends `session.reconcile`. Plugin calls `sdk.payment.getPayment()` and replies with `session.result` carrying `late:true`. Our [config.js:56-72](../../../front-plugin-js/config.js) implements this. We need to verify backend actually sends `session.reconcile` after the expected delay.

**Files:**
- Modify: `docs/integration/dev-smoke-checklist.md` — append Section 2
- Modify: `docs/integration/findings.md`

- [ ] **Step 1: Start plugin in `--no-result` mode (claims session, then stalls)**

```bash
cd /Users/jaejeong/Documents/jnitprojects/smartdoctor-api
python3 tools/toss-payment-test/plugin_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty \
  --no-result
```

- [ ] **Step 2: In a second terminal, drive a session via CRM client (same as Task 7)**

```bash
python3 tools/toss-payment-test/crm_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty \
  --workstation-id ws-dev-jj-001 \
  --hospital-id 99995 \
  --customer-number CUST000123
```

Plugin terminal should print: `session.dispatch`, `claimed`, `sent chargeContext`, then "no-result mode enabled; leaving session IN_PROGRESS for watchdog/reconcile test".

- [ ] **Step 3: Wait for backend watchdog to expire the session**

Wait 90+ seconds (`timeoutMs=60000` + 30s grace per spec §9). CRM terminal should print:
```
session.result EXPIRED / EXPIRED
```

Capture the wall-clock time observed. If it differs significantly from 90s, note in findings.

- [ ] **Step 4: Stop plugin (Ctrl-C), then restart in `--reconcile-success` mode**

```bash
python3 tools/toss-payment-test/plugin_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty \
  --reconcile-success
```

Expected:
- Plugin reconnects, sends `device.register`.
- Backend immediately sends `session.reconcile` with the EXPIRED session's id.
- Plugin replies with `session.result` containing `late: true` (the mock fakes a SUCCESS).
- CRM terminal (still running) prints: `session.result SUCCEEDED late=true`.

- [ ] **Step 5: Append Section 2 to checklist**

```markdown
## 2. Reconcile recovery (`late: true`)

- [ ] Plugin in `--no-result` mode + CRM creates session → backend lands EXPIRED after ~90s
- [ ] Plugin reconnects in `--reconcile-success` mode
- [ ] Backend sends `session.reconcile` to plugin
- [ ] Plugin replies `session.result` with `late: true`
- [ ] CRM observes `session.result SUCCEEDED late=true`
- [ ] Wall-clock to expiry recorded in findings.md
```

- [ ] **Step 6: Update findings.md with reconcile section**

Append to `docs/integration/findings.md`:

```markdown
## Reconcile (`late: true`)
- Status: ✅ / ❌ / ⚠️
- Wall-clock to expiry: <Xs> (spec says ~90s)
- Observed reconcile payload: <paste>
- Delta vs spec: <if any>
```

- [ ] **Step 7: Commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add docs/integration/dev-smoke-checklist.md docs/integration/findings.md
git commit -m "docs(integration): smoke-test reconcile recovery"
```

---

## Task 9: Smoke-test refund flow (kind=cancel dispatch)

**Why:** After a successful payment lands, CRM can issue `refund.create`. Backend builds `cancelParams` from the persisted Toss response and dispatches `session.dispatch (kind=cancel)` to plugin. Plugin calls `sdk.payment.requestPaymentCancel` and replies `refund.result`. Our [payment.html:286-297](../../../front-plugin-js/payment.html) implements this. The reference `plugin_client.py:102-117` also implements it. We verify deployed Core accepts the round trip.

**Files:**
- Modify: `docs/integration/dev-smoke-checklist.md` — append Section 3
- Modify: `docs/integration/findings.md`

- [ ] **Step 1: Run a full happy-path session first to get a SUCCEEDED `sessionId`**

Repeat Task 7 steps 1–3. **Note the `sessionId`** from the `session.dispatch` payload (printed by `plugin_client.py`).

- [ ] **Step 2: With plugin still connected, drive a refund via CRM**

In a third terminal:

```bash
cd /Users/jaejeong/Documents/jnitprojects/smartdoctor-api
python3 -c '
import asyncio, json, websockets
async def main():
    uri = "wss://develop.api.openapi.smartdoctor.systems/ws/crm?token=crm_qalmighty"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({
            "type": "refund.create",
            "payload": {
                "originalSessionId": "<PASTE_SESSION_ID>",
                "clientRequestId": "c1r-refund-test-001"
            }
        }))
        async for raw in ws:
            print(raw)
asyncio.run(main())
'
```

Replace `<PASTE_SESSION_ID>` with the SUCCEEDED session's id from Step 1.

- [ ] **Step 3: Confirm the refund frame sequence**

Plugin terminal:
- Receives `session.dispatch` with `kind: "cancel"` and `cancelParams` containing `paymentMethod`, `tax`, `supplyValue`, `timestamp`, `approvalNumber` from the original session.
- Sends `refund.result` with mock `tossResponse` SUCCESS.

CRM terminal (the one-off Python above):
- Receives `refund.result` with `status: "SUCCEEDED"`.

- [ ] **Step 4: Append Section 3 to checklist + findings**

```markdown
## 3. Refund flow

- [ ] Successful payment session captured (`sessionId` recorded)
- [ ] CRM `refund.create` triggered with that `originalSessionId`
- [ ] Plugin receives `session.dispatch` with `kind: "cancel"` and well-formed `cancelParams`
- [ ] Plugin replies `refund.result`
- [ ] CRM observes `refund.result SUCCEEDED`
```

- [ ] **Step 5: Commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add docs/integration/dev-smoke-checklist.md docs/integration/findings.md
git commit -m "docs(integration): smoke-test refund flow"
```

---

## Task 10: Smoke-test 100% 메디캐시 path (charged=0, `tossResponse: null`)

**Why:** Recent FE commit `cbcc11d` added the 100%-coverage skip path: when treatment total ≤ usable medicash, plugin skips `requestPayment` and sends `session.result` with `tossResponse: null`. The deployed flow doc §6 example shows `tossResponse` always populated; our FE sends `null`. Backend may or may not tolerate this — worth verifying explicitly because it's the one spec-vs-impl gap I flagged earlier.

We can't drive this with the existing `plugin_client.py` (it always sends a card SUCCESS). We have to either fork the script or use a one-off Python.

**Files:**
- Create: `tools/100pct-medicash-test.py` (local helper script in this repo)
- Modify: `docs/integration/dev-smoke-checklist.md` — append Section 4
- Modify: `docs/integration/findings.md`

- [ ] **Step 1: Create the test helper**

Create `/Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/tools/100pct-medicash-test.py`:

```python
#!/usr/bin/env python3
"""
Drives a 100%-medicash payment session: plugin claims, sends chargeContext
with full pointUseAmount, then sends session.result with tossResponse: null.
Verifies backend accepts the null-tossResponse shape produced by FE
front-plugin-js/payment.html when charged === 0.

Usage:
  python3 tools/100pct-medicash-test.py \\
    --base-url wss://develop.api.openapi.smartdoctor.systems \\
    --serial TF-DEV-JJ-001 \\
    --token crm_qalmighty
"""
import argparse
import asyncio
import json

import websockets


async def heartbeat(ws):
    while True:
        await asyncio.sleep(20)
        await ws.send(json.dumps({"type": "ping", "payload": {}}))


async def main(args):
    uri = (
        f"{args.base_url.rstrip('/')}/ws/plugin"
        f"?serial={args.serial}&token={args.token}"
    )
    async with websockets.connect(uri) as ws:
        print(f"connected {uri}")
        await ws.send(
            json.dumps(
                {
                    "type": "device.register",
                    "payload": {"serialNumber": args.serial, "sdkVersion": "v0"},
                }
            )
        )
        asyncio.create_task(heartbeat(ws))

        async for raw in ws:
            msg = json.loads(raw)
            print(json.dumps(msg, ensure_ascii=False, indent=2))
            if msg.get("type") != "session.dispatch":
                continue
            payload = msg["payload"]
            if payload.get("kind") != "payment":
                continue

            session_id = payload["sessionId"]
            amount = payload["amount"]
            treatment_total = (
                int(amount["supplyValue"]) + int(amount["tax"]) + int(amount["tip"])
            )
            # Force 100% point coverage: pointUseAmount == treatment_total.
            # Validation: pointUseAmount + 0 + 0 + 0 == supplyValue + tax + tip → passes.
            await ws.send(
                json.dumps({"type": "session.claim", "payload": {"sessionId": session_id}})
            )
            await asyncio.sleep(0.3)
            await ws.send(
                json.dumps(
                    {
                        "type": "session.chargeContext",
                        "payload": {
                            "sessionId": session_id,
                            "pointUseAmount": treatment_total,
                            "chargedSupplyValue": 0,
                            "chargedTax": 0,
                        },
                    }
                )
            )
            await asyncio.sleep(0.3)
            await ws.send(
                json.dumps(
                    {
                        "type": "session.result",
                        "payload": {
                            "sessionId": session_id,
                            "pointUseAmount": treatment_total,
                            "chargedSupplyValue": 0,
                            "chargedTax": 0,
                            "tossResponse": None,
                        },
                    }
                )
            )
            print(f"sent 100%-medicash session.result for {session_id}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="wss://develop.api.openapi.smartdoctor.systems")
    ap.add_argument("--serial", default="TF-DEV-JJ-001")
    ap.add_argument("--token", required=True)
    asyncio.run(main(ap.parse_args()))
```

- [ ] **Step 2: Run the helper, then trigger a CRM session with availableBalance ≥ treatment total**

Terminal A:
```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
python3 tools/100pct-medicash-test.py --token crm_qalmighty
```

Terminal B — drive a CRM session whose `pointAccrualTargetAmount` and customer's medicash leave 100% coverage. The cleanest way is to let backend's auto-enrichment populate `pointContext` (which fetches real customer data from hospital DB) — this requires a customer with high medicash balance.

Easier alternative: use the modified CRM client with explicit `pointContext`. Edit a copy of `tools/toss-payment-test/session_create_request.json` so `pointContext.availableBalance` exceeds `amount.supplyValue + amount.tax`, then:

```bash
cd /Users/jaejeong/Documents/jnitprojects/smartdoctor-api
python3 tools/toss-payment-test/crm_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-JJ-001 \
  --token crm_qalmighty \
  --workstation-id ws-dev-jj-001 \
  --hospital-id 99995 \
  --customer-number CUST000123 \
  --request-body /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template/tools/100pct-medicash-request.json
```

(Create the `100pct-medicash-request.json` file by copying `session_create_request.json` and overriding `pointContext.availableBalance` to e.g. `999999`.)

- [ ] **Step 3: Confirm backend accepts `tossResponse: null` and forwards SUCCEEDED to CRM**

Plugin terminal:
- Receives `session.dispatch`, sends claim/chargeContext/result with `tossResponse: null`.
- Receives nothing further (no `error` frame).

CRM terminal:
- Receives `session.result` with `status: "SUCCEEDED"`, `pointUseAmount` matching, `tossResponse` either echo'd as `null` or omitted.

If backend rejects with `error`/`INVALID_REQUEST`/`VALIDATION_FAILED`, capture the exact error code and add it to findings.md as a backend-side ask: "Spec §6 examples show populated `tossResponse`; FE sends `null` for 100%-medicash; backend should either accept null or document the expected shape (e.g. `{ type: 'POINTS_ONLY', response: null }`)."

- [ ] **Step 4: Append Section 4 to checklist + findings**

```markdown
## 4. 100% 메디캐시 (charged=0, tossResponse: null)

- [ ] CRM session.create with `pointContext.availableBalance ≥ amount sum`
- [ ] Plugin sends `session.chargeContext` with zero charged amounts and full point use
- [ ] Plugin sends `session.result` with `tossResponse: null`
- [ ] Backend accepts (no `error` frame); CRM observes SUCCEEDED
- [ ] Findings recorded if backend rejects null
```

- [ ] **Step 5: Commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add tools/100pct-medicash-test.py tools/100pct-medicash-request.json docs/integration/
git commit -m "test(integration): 100%-medicash null-tossResponse smoke test against dev"
```

---

## Task 11: Final write-up + hand-off

**Why:** Capture what we proved (or didn't), what backend needs to fix (if anything), and what the FE-side production-token TODO looks like. This becomes the artifact 진수민/박민후 review.

**Files:**
- Modify: `docs/integration/findings.md` — final summary section
- Modify: `docs/integration/dev-smoke-checklist.md` — final reproduction-recipe section

- [ ] **Step 1: Add a summary at the top of `findings.md`**

Insert at the top (after the H1 if present):

```markdown
## Summary (2026-04-29)

**Wire contract:** ✅ verified against deployed dev `wss://develop.api.openapi.smartdoctor.systems` with token `crm_qalmighty`, hospital `99995`.

**Flows verified:**
- Happy path (payment): <pass/fail/notes>
- Reconcile recovery (`late: true`): <pass/fail/notes>
- Refund (kind=cancel): <pass/fail/notes>
- 100% 메디캐시 (`tossResponse: null`): <pass/fail/notes>

**Outstanding for production:**
- `CORE_TOKEN` is hardcoded in [front-plugin-js/config.js](../../front-plugin-js/config.js). Backend team to specify production token-fetch flow (likely `sdk.app.getMerchant()` + login HTTP, or partner-portal-issued token in `device.register`).
- Open questions from spec §15 not addressed by this work: trust model for unknown serials, `merchant.id` wire path.

**Backend-side asks (if any):** <list, with exact error codes / observed-vs-expected payloads>
```

Fill in concrete pass/fail markers from your testing.

- [ ] **Step 2: Append a one-line repro recipe to checklist**

```markdown
## Quick repro (next dev to test)

```bash
# Terminal A: plugin mock
cd ~/Documents/jnitprojects/smartdoctor-api
python3 tools/toss-payment-test/plugin_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-<initials>-001 --token crm_qalmighty --use-points

# Terminal B: CRM mock
python3 tools/toss-payment-test/crm_client.py \
  --base-url wss://develop.api.openapi.smartdoctor.systems \
  --serial TF-DEV-<initials>-001 --token crm_qalmighty \
  --workstation-id ws-dev-<initials>-001 --hospital-id 99995 \
  --customer-number CUST000123
```
```

- [ ] **Step 3: Surface findings to backend if any**

If `findings.md` lists a backend-side ask:
- Post a short summary to the Slack thread (`C099YT4CL75`, `1777006893.787169`) referencing `findings.md`.
- Tag 진수민 + 정재헌.

If no backend-side asks: post "smoke test passed end-to-end on dev — wire contract aligned" with link to checklist.

- [ ] **Step 4: Final commit**

```bash
cd /Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template
git add docs/integration/
git commit -m "docs(integration): final findings summary + quick-repro recipe"
```

---

## Self-Review Notes

**Spec coverage:** Tasks 1–5 cover the only gap I found (WS URL path + token). Tasks 6–10 cover the four flow categories described in spec §1–§10 (register, dispatch, chargeContext+result, reconcile, abort, refund) — note that Task 7 happy-path inherently exercises register and dispatch, and `session.abort` (USER_BACKED_OUT) is not separately tested because the existing FE [order.html:201-206](../../../front-plugin-js/order.html) is unchanged by this work; if smoke tests surface concerns, an addendum task can be added.

**No subagent tests required:** This work is wire fixes + manual smoke testing. There's no automated test suite for `front-plugin-js` to extend, and adding one is out of scope. Verification runs through DevTools + Python harness frame inspection.

**Frequent commits:** Every task ends in a commit. Tasks 3–5 are intentionally one-file-each so a regression can be bisected to a single page.

---

## Tasks 16–18 — Lifecycle fixes (added 2026-04-30 after device test)

Real-card device test (Task 14) exposed a critical bug: tapping 확인 on the success terminal left the device on a blank/white screen (WS dropped, backend saw DEVICE_OFFLINE). Audit revealed 12 lifecycle/navigation problems. User picked Option A: fix Critical (#1, #2) + Important #4 + #8.

### Task 16: Replace `sdk.app.setIdle()` with `location.href = "./home.html"` in payment.html + order.html

**Why:** `setIdle()` only commands the SDK shell to dismiss its overlay; the underlying plugin document stays mounted with its WS already closed. Navigating to `home.html` re-mounts the dispatcher (renders idle template, opens fresh WS, sends `device.register`, runs recovery). **`home.html` itself is the only place bare `setIdle()` is correct** — leave that file alone.

**Files:** `front-plugin-js/order.html`, `front-plugin-js/payment.html`. Two commits, one per file.

### Task 17: Add WS auto-reconnect with backoff to home.html

**Why:** A network blip, backend restart, or 3-missed-heartbeats currently leaves home.html "looking idle" but unreachable until reboot. Add exponential backoff reconnect (1s → 30s cap), re-issue `device.register` + `runPendingPaymentRecovery` on each reconnect. Skip reconnect on close code 4403 (unrecoverable trust failure).

**Files:** `front-plugin-js/home.html`. One commit.

### Task 18: Remove "다시 결제하기" retry CTA on failure page

**Why:** When SDK returns CANCELED/TIMEOUT, plugin sends `session.result` to backend (which terminalizes the session), THEN renders a retry CTA that re-runs `runPayment` against the same sessionId. Backend should reject the second `chargeContext` with `INVALID_STATE_TRANSITION`. Replace CTA with 확인 → `location.href = "./home.html"`. CRM must initiate a new session.create for retries — spec-correct.

**Files:** `front-plugin-js/payment.html` (one change in the failure render block). One commit.

Tasks 16 and 18 bundle into one implementer (both touch payment.html with disjoint sites). Task 17 dispatches separately.
