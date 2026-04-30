# Toss Front Plugin Backend Integration — Handoff Snapshot

> **Last updated:** 2026-04-30 (mid-session, Task 19 pending real-device verification)
>
> If you're a new Claude agent picking this up, read this file end-to-end first, then `findings.md`, then the plan doc. Don't propose code changes until you've confirmed understanding with the user.

## What this project is

`toss-front-plugin-template` — a vanilla-JS web app that runs inside a Toss Front SDK WebView on a payment terminal at Korean dental clinics. Replaces a legacy device payment flow. Connects to our backend (`smartdoctor-api`, Spring Boot core module) over WebSocket; the backend mediates between this plugin, CRM workstations, and Toss SDK card processing. Includes 메디캐시 (medicash) point integration.

## Repo + branch

- Path: `/Users/jaejeong/Documents/jnitprojects/toss-front-plugin-template`
- Branch: `develop` (NOT main — recent work has shipped here)
- Don't push without explicit user consent

## Sibling repo (for the Python smoke harness)

- `/Users/jaejeong/Documents/jnitprojects/smartdoctor-api` (currently on `main`, but the test harness lives on `feature/toss-payment` branch)
- Test files were extracted into the working tree via `git -C ~/Documents/jnitprojects/smartdoctor-api checkout origin/feature/toss-payment -- tools/toss-payment-test/` — they show as `A` in that repo's status, **don't commit them there**
- Relevant scripts: `tools/toss-payment-test/{plugin_client,crm_client}.py` + `session_create_request.json`

## Operational constants (dev environment)

| Thing | Value |
|---|---|
| WS host | `wss://develop.api.core.smartdoctor.systems` |
| Plugin WS path | `/ws/plugin?serial=<deviceSerialNumber>&token=<coreToken>` |
| CRM WS path | `/ws/crm?token=<workstationToken>` |
| Dev token (loose auth, both endpoints) | `crm_qalmighty` |
| Test hospital (fixed in dev) | `99995` |
| Test customer | `411160` ("테스트" — has zero medicash balance in dev DB) |
| Real device serial | `258F2010SLR0040` (Samsung Mastercard tied; small-amount tests with this card OK) |
| Test workstation ID | `ws-dev-jj-001` |
| FE config: BACKEND_HOST | already set in [front-plugin-js/config.js:6](../../front-plugin-js/config.js) |
| FE config: CORE_TOKEN | already set in [front-plugin-js/config.js:14](../../front-plugin-js/config.js) (TODO for prod) |

## What's been done

**Phase A — wire fix + dev smoke tests (Tasks 1–10):**

- WS URL path corrected from `/plugin?serial=...` to `/ws/plugin?serial=...&token=...`
- BACKEND_HOST corrected from `openapi` to `core` module (backend confirmed)
- All 4 spec'd flows verified ✅: happy path, reconcile (`late: true`), refund, WS handshake
- 1 backend bug found ❌: 100%-medicash with `tossResponse: null` → backend WS 1011 crash, session poisoned IN_PROGRESS. **NOT fixed.** Plan to file with backend in Task 11.

**Phase B — real-device testing + lifecycle fixes (Tasks 12–18):**

- Task 12: Added `onBack` to all 6 SDK render calls in `order.html` and `payment.html` (back-arrow no longer bricks)
- Task 14: Real-card test on device (1,000원, Samsung Mastercard, approval `06903313`) — payment + refund both succeeded **but** exposed a new bug: tapping 확인 on success screens left a blank WebView, dropping WS to backend (DEVICE_OFFLINE)
- Task 15: Audited the lifecycle/navigation state machine — 12 problems found
- Tasks 16, 18: Replaced all `sdk.app.setIdle()` calls in `order.html` + `payment.html` with `location.href = "./home.html"` (re-mounts dispatcher); removed broken "다시 결제하기" retry CTA; only `home.html`'s own `setIdle` retained (it's the only place it's correct)
- Task 17: Added WS auto-reconnect with exponential backoff (1s → 30s cap) to `home.html`; persists `recoveredSessions` Set across reconnects

## What's open (in priority order)

1. **Task 19 (active):** Re-deploy the plugin with the 7 lifecycle-fix commits and re-test on device. Verification ladder:
   - Sanity: device boots, idle screen, back-arrow on order page returns to idle (not blank)
   - Reconnect: yank network briefly, auto-reconnect should kick in
   - Real card 1,000원 + immediate refund: payment success → 확인 → idle (no blank), refund success → 확인 → idle
2. **Task 11:** Send Slack message to backend team (channel `C099YT4CL75`) about the 100%-medicash bug. Draft is in conversation history; key points: `tossResponse: null` → WS 1011 → session poisoned. Reproducer: `python3 tools/100pct-medicash-test.py --token crm_qalmighty`.
3. **Deferred audit items** (in `findings.md` for tracking, not blocking): #3 zero-WS-coverage during nav, #5 stale pendingPayment cleanup, #6 recovery-without-WS, #7 unknown-kind dispatch, #9 heartbeat timer race, #10 100%-medicash close-before-flush, #11 order.html-skips-recovery, #12 home.html dispatch/recovery race.

## Operational guardrails

- **Real money flows through this.** If you do a payment test, cancel immediately. Use [tools/device-test-request.json](../../tools/device-test-request.json) (1,000원) — never the default `session_create_request.json` (30,000원).
- **Don't test 100%-medicash on the device** until backend ships the null-tossResponse fix. Customer 411160 has zero medicash so accidental triggers are unlikely, but don't manually inject `pointContext.availableBalance` to force coverage.
- **Don't push to `origin/develop`** without explicit user consent. There's a pile of unpushed commits.
- **Don't touch the spec doc** at `docs/superpowers/specs/toss-payment-flow.md` — that's the backend's deployed contract, mirrored from Slack.
- **`smartdoctor-api/tools/toss-payment-test/` is staged but unwanted** on that repo's main branch. Cleanup at end: `git -C ~/Documents/jnitprojects/smartdoctor-api restore --staged tools/ && rm -rf ~/Documents/jnitprojects/smartdoctor-api/tools`.

## Conventions

- **Commits:** `feat(front-plugin-js): …` / `fix(front-plugin-js): …` / `docs(integration): …` style, with multi-line bodies via HEREDOC. Always end with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- **Per-file commits** for batched HTML edits (e.g., the URL-fix landed as 3 separate commits — one per HTML file — for bisect).
- **Subagent-driven-development** for non-trivial code edits (implementer → spec compliance review → code quality review). Inline edits OK for trivial things like file copies or single-line config tweaks.
- **No tests in this codebase** — verification is by running `node` syntax-parse + on-device behavior. Don't add Jest/Mocha; out of scope.
- **TodoWrite** is used heavily to track tasks across the long session.

## Key files to read for deeper context

In order of importance:

1. `docs/integration/findings.md` — what's verified ✅ and what's broken ❌ on dev, with concrete frame logs
2. `docs/superpowers/plans/2026-04-29-toss-backend-integration.md` — full task list (Tasks 1–18 + open items)
3. `docs/integration/dev-smoke-checklist.md` — repro recipes for happy path, reconcile, refund, 100%-medicash
4. `docs/superpowers/specs/toss-payment-flow.md` — backend's deployed contract (738 lines, the source of truth for wire shapes)
5. `docs/superpowers/specs/2026-04-27-frontend-plugin.md` — FE plugin spec
6. `front-plugin-js/{home,order,payment,settings}.html`, `front-plugin-js/{config,sdk}.js` — the actual plugin code

## Reference: backend Slack thread

- Channel: `C099YT4CL75` ("[toss 메디캐시 q&a]")
- Parent ts: `1777006893.787169`
- Key participants: 진재헌 (CTO), 진수민 (BE deploy owner), 박민후 (team lead)
- Use `mcp__79df41ab-d391-4e61-8129-78615ad39c87__slack_*` tools to read/send

## Deploy pipeline

- `pnpm zip` → produces `front-plugin-js.zip` at repo root
- Upload to Toss partner-portal (tossplace.com), then click deploy in the partner UI
- Device pulls new plugin on next load
- `pnpm deploy` exists too ([deploy/index.ts](../../deploy/index.ts)) — uploads zip to S3 + invalidates CloudFront — needs `TOSSPLACE_BUCKET` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars; user does the partner-portal step manually after this

---

**For a new Claude agent:** after reading this file, run `git log --oneline -15` and `git status --short` in the repo to see exactly where things stand, then summarize back to the user what you understand before proposing actions.
