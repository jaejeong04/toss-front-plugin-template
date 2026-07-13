# Payment-Failure Same-Session Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a card payment failure (insufficient funds / hard decline), render the Toss-template itemized failure screen with a **다시 결제하기** button that retries on the same session, and emit a terminal `session.result` when the customer gives up so the CRM can process the failure — fixing the two reported bugs (no retry screen, no socket event on failure).

**Architecture:** Refactor `runPayment`'s failure handling in `front-plugin-js/payment.html` into a **same-session retry loop**. Each `attempt()` is one `sdk.payment.requestPayment` call on the **same `sessionId`**. On any non-success outcome (a rejected Promise OR a resolved `CANCELED`/`TIMEOUT`) the plugin sends **nothing terminal** — the backend session stays `IN_PROGRESS`, so a re-attempt is valid — and renders the itemized failure screen via **`sdk.template.renderOrderResultPage` (`type:"cancelled"`)** with a single **`다시 결제하기`** cta whose `onClick` re-runs `attempt()`. Give-up is the screen's **back arrow** (`onBack`), which sends the terminal `session.result` (new `FAILED` envelope). Give-up after a *rejected* attempt reconciles via `getPayment` first so a real-but-bridge-dropped charge is reported as `SUCCESS`, never overwritten with `FAILED`.

**Tech Stack:** Plain HTML + inline JS, Toss Front SDK (`window.TossFrontSDK`), browser `WebSocket`. No bundler, no test framework — deployed via `pnpm zip` → S3/CloudFront. Verification is **on-device / manual** (documented E2E matrix in the Verification section); there is no automated runtime harness for SDK/DOM code.

## Global Constraints

- **Customer payment screens must use the Toss Template API only — no custom HTML/DOM.** The failure screen uses `sdk.template.renderOrderResultPage` (`type:"cancelled"`, itemized summary), matching the 기획 mockup; its single `cta` and `onBack` are JS callbacks we control. (`settings.html` is exempt but is not touched here.)
- **The failure screen has ONE button (`다시 결제하기`) + a back arrow** — matching the 기획 mockup. `다시 결제하기` = retry (re-run `requestPayment` on the same session). Back arrow (`onBack`) = give up (send terminal `FAILED`, go home). There is no separate 취소 button.
- **Real-money-critical.** Never send a terminal `FAILED` for a session whose card was actually charged. A rejected `requestPayment` MAY have charged on-device (bridge dropped after approval) — reconcile via `getPayment` before declaring failure.
- **`paymentKey === sessionId`** everywhere (backend `getPayment(paymentKey)`, `session.result` correlation, recovery all depend on this). Do **not** introduce a per-attempt payment key.
- **Failure envelope = new `FAILED` type:** `tossResponse: { type: "FAILED", response: { reason } }`. (Product decision 2026-07-13.)
- **WS B stays open across retries** (needed to send the eventual terminal `session.result`); the heartbeat keeps pinging until a terminal outcome. Only `closeWs` on success, give-up, or a backend-error bail.
- Preserve every existing `backendErrorRef` guard and the `renderBackendErrorPage` bail behavior — re-check backend error **before and after** each attempt.
- Match the existing terminal-render pattern: every render passes `localeCode` where supported and an `onBack` that navigates/terminalizes (blank-WebView bug guard). (`renderOrderResultPage` takes `type`, `order`, `cta`, `onBack`; no `timerMs`/`localeCode`/`buttons[]` — do not pass unsupported params.)

---

## Cross-team contract addendum (NOT implemented in this repo — for BE/CRM teams)

This repo is frontend-only. The following must be coordinated with the backend/CRM teams; call them out in the PR description:

1. **Accept the `FAILED` `tossResponse.type`.** §6.5's mapping table ([docs/toss-client-mode-flow.md:324](../../toss-client-mode-flow.md)) currently has only `CANCELED`/`TIMEOUT` rows. Backend must add a `FAILED` → terminal `STATUS` + `failureReason` mapping (suggested: `STATUS=CANCELED` or a new `FAILED`, `failureReason=PAYMENT_DECLINED`, carrying `tossResponse.response.reason`). **No medicash deduction** on `FAILED`.
2. **`IN_PROGRESS` timeout must accommodate retries.** Multiple attempts (each up to `timeoutMs`, default 60s) plus think-time on the failure screen can exceed the backend's `IN_PROGRESS`→`EXPIRED` watchdog. Either widen it, or accept that an abandoned failure screen resolves via `EXPIRED` (the plugin sends `FAILED` only on explicit back-arrow give-up) — see (3).
3. **Handle `FAILED` → late `SUCCESS`.** If give-up sends `FAILED` and a later `session.reconcile`/recovery posts a late `SUCCESS` (transient `getPayment` failure at give-up, then success surfaces), backend/CRM must prefer `SUCCESS` (idempotent receipt, or refund the orphan). Extends §6.4's idempotency rule.

## Gating on-device tests (run these FIRST — they decide if this design ships)

- **[MUST TEST — paymentKey reuse]** Does `sdk.payment.requestPayment` accept a **second** call with the **same `paymentKey`** after a decline? If it always rejects a duplicate key, same-session retry is impossible and we must fall back to "immediate `FAILED` + start-over-to-home" (a fresh CRM `session.create` per attempt). This is the pivotal unknown. Ties to [MUST TEST T2].
- **[MUST TEST — getPayment on device / T3]** Does `getPayment({paymentKey})` work on-device (returns cached `SUCCESS`, throws `PAYMENT_NOT_FOUND` otherwise)? The give-up-after-reject safety net depends on it.
- **[MUST TEST — 취소 사유 reason codes]** The 기획 lists five reasons — 승인 거절 / 잔액 부족 / 한도 초과 / 통신 오류 / 시간 초과. Toss's actual failure-reason codes/strings are undocumented (existing `mapTossFailureToKorean` TODO). Capture the real `result.response.reason` / reject `err.code` on-device and finalize the mapping.
- **[MUST TEST — renderOrderResultPage onBack]** `onBack` on `renderOrderResultPage` is an undocumented `[GAP]` the codebase already relies on (`runCancel`). Confirm the back arrow fires `onBack` (so give-up sends `FAILED`); if not, give-up falls back to backend `EXPIRED`.
- **[MUST TEST — negative-value render]** The mockup shows `메디캐시 사용 -1,000` (flagged "상품에 음수 가격 적용 가능 여부 확인 필요"). Confirm `renderOrderResultPage` renders the negative medicash `summary.items` value correctly (it is display text in `summary.items`, not an `order.items` price).
- **[MUST TEST — blank WebView]** Confirm `다시 결제하기` → subsequent `requestPayment` firmware overlay does not leave a blank WebView.

---

## File Structure

- **Modify:** `front-plugin-js/payment.html` — (a) extend `mapTossFailureToKorean` (reason-code mapping) and null-guard `mapPaymentMethodToKorean`; (b) replace the failure/success handling inside `runPayment` (current lines ~205–371) with the retry-loop structure below. No other file changes required for the code fix.
- **Modify (docs, Task 2):** `docs/toss-client-mode-flow.md` §6.5 — document the `FAILED` envelope and same-session retry semantics, superseding the "session is terminal; retry requires a fresh CRM session.create" line.

---

### Task 1: Same-session retry loop in `runPayment`

**Files:**
- Modify: `front-plugin-js/payment.html` — the two helpers (`payment.html:44-60`) and the `runPayment` non-zero-charge path (`payment.html:205-371`)

**Interfaces:**
- Consumes (already in scope inside `runPayment`): `ws`, `dispatch`, `backendErrorRef`, `pointUse`, `treatmentTotal`, `charged`, `tax`, `supplyValue`, and helpers `sendWs`, `closeWs`, `isBackendErrorForSession`, `renderBackendErrorPage`, `mapTossFailureToKorean`, `mapPaymentMethodToKorean`, `window.smartdoctor.PENDING_KEY`.
- Produces: no new module exports — new functions (`buildFailedResponse`, `finishSuccess`, `giveUp`, `renderFailureScreen`, `attempt`) are locals inside `runPayment`.

**What stays unchanged (do NOT touch):**
- Steps 1–4 of `runPayment`: `pointUse`/`treatmentTotal`/`charged`/`tax`/`supplyValue` computation, the **100%-메디캐시 branch** (`charged === 0 && tip === 0`), the `pendingPayment` `sdk.storage.set`, and the **pre-attempt** backend-error guard.
- `runCancel` (the refund flow) — untouched (it also calls `mapTossFailureToKorean`/`mapPaymentMethodToKorean`; the edits below stay backward-compatible).
- `home.html`, `order.html`, `config.js` — untouched.

- [ ] **Step 1: Extend `mapTossFailureToKorean` (reason-code mapping) and null-guard `mapPaymentMethodToKorean`.**

Replace the two helpers (`payment.html:44-60`) with:

```javascript
      // Helper: spec §6.2 mapTossFailureToKorean — maps a Toss non-success
      // result (or a synthesized FAILED envelope) to the 기획 취소 사유 labels:
      // 승인 거절 / 잔액 부족 / 한도 초과 / 통신 오류 / 시간 초과.
      function mapTossFailureToKorean(result) {
        if (!result) return "통신 오류";
        // Reason-string mapping. [MUST TEST]: real Toss reason codes are
        // undocumented — verify the actual strings on-device and adjust.
        const reason = (result.response && result.response.reason) || "";
        if (/INSUFFICIENT|BALANCE|잔액/i.test(reason)) return "잔액 부족";
        if (/LIMIT|EXCEED|한도/i.test(reason)) return "한도 초과";
        if (/DECLIN|REJECT|승인/i.test(reason)) return "승인 거절";
        if (/TIMEOUT|시간/i.test(reason)) return "시간 초과";
        if (result.type === "TIMEOUT") return "시간 초과";
        if (result.type === "CANCELED") return "승인 거절";
        if (result.type === "FAILED") return "승인 거절";
        return "통신 오류";
      }

      // Helper: spec §6.2 mapPaymentMethodToKorean. Null-safe: the reject path
      // has no result object, so return "—" rather than throwing.
      function mapPaymentMethodToKorean(result) {
        const m = result && result.response && result.response.paymentMethod;
        if (m === "CARD") return "카드";
        if (m === "BARCODE") return "QR/바코드";
        if (m === "CASH") return "현금";
        return "—";
      }
```

- [ ] **Step 2: Replace the requestPayment call + all downstream failure/success rendering (current `payment.html:218-371`) with the retry-loop code below.**

Delete the block from `const result = await sdk.payment.requestPayment({` (line ~218) through the end of the `else` branch that renders `renderOrderResultPage` (line ~371), **keeping** the pre-attempt backend-error guard above it (lines ~208-216). Insert in its place:

```javascript
        // 5. Same-session retry loop. Each attempt() is ONE requestPayment on
        //    the SAME sessionId (paymentKey === sessionId). On any non-success
        //    we send NOTHING terminal (session stays IN_PROGRESS) and render the
        //    itemized failure screen with a 다시 결제하기 retry cta; the terminal
        //    session.result (SUCCESS or FAILED) is sent only on success or the
        //    back-arrow give-up. Spec §6.5 (FAILED envelope); 기획 결제 실패 화면.

        // Build the §6.5 FAILED failure envelope for give-up. Prefer a resolved
        // result's reason, else the rejected error's code/message, else the
        // result type, else a generic marker.
        function buildFailedResponse(result, rejectErr) {
          let reason;
          if (result && result.response && result.response.reason) {
            reason = result.response.reason;
          } else if (rejectErr && (rejectErr.code || rejectErr.message)) {
            reason = rejectErr.code || rejectErr.message;
          } else if (result && result.type) {
            reason = result.type; // CANCELED / TIMEOUT
          } else {
            reason = "PAYMENT_FAILED";
          }
          return { type: "FAILED", response: { reason: String(reason) } };
        }

        // Terminal SUCCESS — shared by a live SUCCESS and a give-up that
        // discovers a real charge via getPayment. Sends session.result(SUCCESS),
        // drops pending only if the frame went out, renders the success screen.
        async function finishSuccess(result) {
          const resultSent = sendWs(ws, {
            type: "session.result",
            payload: {
              sessionId: dispatch.sessionId,
              pointUseAmount: pointUse,
              chargedSupplyValue: supplyValue,
              chargedTax: tax,
              tossResponse: result,
            },
          });
          if (resultSent) {
            await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
          }
          sessionStorage.removeItem("smartdoctor.dispatch");
          sessionStorage.removeItem("smartdoctor.dispatch.pointUse");
          const { name: hospitalName } = await sdk.app.getMerchant();
          closeWs(ws);
          sdk.template.renderResultPage({
            type: "image",
            status: "success",
            title: "수납 완료",
            description: `${hospitalName}에\n 방문해주셔서 감사합니다`,
            timerMs: 5000,
            onTimeout: () => { location.href = "./home.html"; },
            buttons: [
              {
                label: "확인",
                onClick: () => { location.href = "./home.html"; },
                closeOnClick: true,
              },
            ],
            onBack: () => { location.href = "./home.html"; },
            localeCode: "ko",
          });
        }

        // Terminal give-up — customer tapped the back arrow on the failure
        // screen. Sends the FAILED session.result so the CRM can process the
        // failure. SAFETY: a REJECTED attempt may have charged on-device (bridge
        // dropped after approval), so reconcile via getPayment first — a real
        // charge is reported as SUCCESS, never overwritten with FAILED. A
        // resolved CANCELED/TIMEOUT means no charge, so skip the lookup.
        async function giveUp(result, rejectErr) {
          const rejected = !result; // reject path vs resolved non-success
          if (rejected) {
            try {
              const recovered = await sdk.payment.getPayment({
                paymentKey: dispatch.sessionId,
              });
              if (recovered && recovered.type === "SUCCESS") {
                await finishSuccess(recovered);
                return;
              }
              // Not found / non-success → nothing was charged; fall through.
            } catch (e) {
              // PAYMENT_NOT_FOUND is the documented "nothing charged" outcome.
              // Any OTHER error (getPayment unavailable/transient): be
              // conservative — send FAILED but KEEP pending so home.html
              // recovery can still reconcile a late success (contract §3).
              if (!(e && e.code === "PAYMENT_NOT_FOUND")) {
                console.warn("[smartdoctor] give-up getPayment error", e);
                sendWs(ws, {
                  type: "session.result",
                  payload: {
                    sessionId: dispatch.sessionId,
                    pointUseAmount: 0,
                    chargedSupplyValue: supplyValue,
                    chargedTax: tax,
                    tossResponse: buildFailedResponse(result, rejectErr),
                  },
                });
                sessionStorage.removeItem("smartdoctor.dispatch");
                sessionStorage.removeItem("smartdoctor.dispatch.pointUse");
                closeWs(ws);
                location.href = "./home.html";
                return;
              }
            }
          }

          const sent = sendWs(ws, {
            type: "session.result",
            payload: {
              sessionId: dispatch.sessionId,
              pointUseAmount: 0,
              chargedSupplyValue: supplyValue,
              chargedTax: tax,
              tossResponse: buildFailedResponse(result, rejectErr),
            },
          });
          if (sent) {
            await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
          }
          sessionStorage.removeItem("smartdoctor.dispatch");
          sessionStorage.removeItem("smartdoctor.dispatch.pointUse");
          closeWs(ws);
          location.href = "./home.html";
        }

        // Failure screen — 기획 결제 실패 화면. renderOrderResultPage(type:cancelled)
        // itemized summary; single cta 다시 결제하기 → retry (same session);
        // back arrow (onBack) → give up. Reuses the pre-Task-18 itemized layout.
        function renderFailureScreen(result, rejectErr) {
          sdk.template.renderOrderResultPage({
            type: "cancelled",
            order: {
              items: (dispatch.orderSnapshot && dispatch.orderSnapshot.items) || [],
              summary: {
                totalAmount: treatmentTotal,
                items: [
                  {
                    label: "진료 금액",
                    value: `${treatmentTotal.toLocaleString()}원`,
                    theme: "blue",
                  },
                  ...(pointUse > 0
                    ? [
                        {
                          label: "메디캐시 사용",
                          value: `-${pointUse.toLocaleString()}캐시`,
                          theme: "blue",
                        },
                      ]
                    : []),
                  {
                    label: "취소 사유",
                    value: mapTossFailureToKorean(result),
                    theme: "red",
                  },
                  {
                    label: "결제 수단",
                    value: mapPaymentMethodToKorean(result),
                    theme: "blue",
                  },
                  {
                    label: "결제 취소",
                    value: `${charged.toLocaleString()}원`,
                    theme: "red",
                  },
                ],
              },
            },
            cta: {
              text: "다시 결제하기",
              // Retry on the SAME session — no terminal result was sent, so the
              // backend session is still IN_PROGRESS and this re-attempt is valid.
              onClick: () => { attempt(); },
            },
            // Back arrow = give up: terminalize with FAILED so the CRM can
            // process it. onBack support on renderOrderResultPage is [GAP] —
            // [MUST TEST]; if it does not fire, give-up falls back to EXPIRED.
            onBack: () => { giveUp(result, rejectErr); },
          });
        }

        // One payment attempt on the same session.
        async function attempt() {
          // Re-check backend error each attempt: a frame may have arrived while
          // the failure screen was up. Bail to the terminal error page if so.
          if (isBackendErrorForSession(backendErrorRef, dispatch.sessionId)) {
            await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
            closeWs(ws);
            await renderBackendErrorPage(backendErrorRef.current);
            return;
          }

          let result = null;
          let rejectErr = null;
          try {
            result = await sdk.payment.requestPayment({
              paymentKey: dispatch.sessionId,
              tax,
              supplyValue,
              tip: dispatch.amount.tip ?? 0,
              timeoutMs: dispatch.timeoutMs ?? 60000,
              localeCode: "ko",
              excludePaymentTypes: ["CASH"],
            });
          } catch (err) {
            rejectErr = err;
            console.error("[smartdoctor] requestPayment failed", err);
          }

          // Post-await re-check: an error frame that arrived DURING the (up to
          // 60s) requestPayment call is now in backendErrorRef.
          if (isBackendErrorForSession(backendErrorRef, dispatch.sessionId)) {
            await sdk.storage.remove({ key: window.smartdoctor.PENDING_KEY });
            closeWs(ws);
            await renderBackendErrorPage(backendErrorRef.current);
            return;
          }

          if (result && result.type === "SUCCESS") {
            await finishSuccess(result);
            return;
          }

          // Non-success (reject OR CANCELED/TIMEOUT): show the failure screen.
          // No terminal send — session stays IN_PROGRESS so 다시 결제하기 is valid.
          renderFailureScreen(result, rejectErr);
        }

        await attempt();
```

- [ ] **Step 3: Verify the 100%-메디캐시 branch and `runCancel` are unchanged.**

Read `payment.html` and confirm: the `if (charged === 0 && (dispatch.amount.tip ?? 0) === 0)` block is byte-for-byte unchanged; `runCancel` is unchanged; the pre-attempt backend-error guard still sits immediately before `await attempt();`. Confirm `runCancel` still calls `mapTossFailureToKorean`/`mapPaymentMethodToKorean` and that the extended helpers remain backward-compatible for its resolved-result callers.

- [ ] **Step 4: Static sanity check.**

Run: `grep -n "renderResultPage\|renderOrderResultPage\|attempt()\|giveUp\|finishSuccess" front-plugin-js/payment.html`
Expected: `renderOrderResultPage` appears in `renderFailureScreen` (runPayment) AND in `runCancel`; `renderResultPage` appears in `finishSuccess`, the 100%-메디캐시 branch, and `renderBackendErrorPage`; `attempt()` is called from `renderFailureScreen`'s cta and once at the end of the non-zero-charge path. Visually confirm `runPayment`'s braces balance and `await attempt();` is the last statement of the non-zero path.

- [ ] **Step 5: Commit.**

```bash
git add front-plugin-js/payment.html
git commit -m "fix(payment): same-session retry + FAILED envelope on card decline

On requestPayment non-success (reject or CANCELED/TIMEOUT), render the
itemized failure screen (renderOrderResultPage, cta 다시 결제하기) instead
of a dead-end error page, and defer the terminal session.result until
success or back-arrow give-up so the backend session stays IN_PROGRESS
and the re-attempt is valid. Give-up sends a FAILED envelope so the CRM
can process the failure; give-up after a rejected attempt reconciles via
getPayment first so a real-but-bridge-dropped charge is never overwritten
with FAILED. Extends mapTossFailureToKorean (잔액 부족/한도 초과) and
null-guards mapPaymentMethodToKorean for the reject path.

Fixes: no retry screen on insufficient funds; no socket event on failure.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Document the `FAILED` envelope + retry semantics in §6.5

**Files:**
- Modify: `docs/toss-client-mode-flow.md` (§6.5, around lines 305-332)

- [ ] **Step 1: Update the §6.5 envelope + mapping table.**

Add a `FAILED` row to the mapping table:

```markdown
| `FAILED` (hard decline / insufficient funds / requestPayment reject) | `CANCELED` (or new `FAILED`) | `PAYMENT_DECLINED` |
```

Replace the "The session is **terminal**; a retry requires a **fresh CRM `session.create`**." bullet with:

```markdown
- **Same-session retry (2026-07-13):** on a non-success attempt the plugin sends **nothing terminal** and renders the itemized failure screen (`renderOrderResultPage type:"cancelled"`, cta `다시 결제하기`). The session stays `IN_PROGRESS`; `[다시 결제하기]` re-calls `requestPayment` on the **same `sessionId`**. A terminal `session.result` fires only on `SUCCESS` or the back-arrow give-up (`FAILED` envelope); an abandoned failure screen resolves via `EXPIRED`. Give-up after a *rejected* attempt reconciles via `getPayment` first (a real charge is reported `SUCCESS`, never overwritten with `FAILED`). **Depends on:** paymentKey-reuse [MUST TEST], `getPayment` on-device [MUST TEST T3], `renderOrderResultPage.onBack` [GAP], and BE handling `FAILED`→late-`SUCCESS` (§6.4 idempotency). Supersedes the prior "retry requires a fresh CRM session.create."
```

- [ ] **Step 2: Commit.**

```bash
git add docs/toss-client-mode-flow.md
git commit -m "docs: §6.5 FAILED envelope + same-session retry semantics

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verification (on-device / manual — no automated harness)

There is no JS test framework in this repo; SDK/DOM behavior can only be verified on the Toss kiosk. Run the gating tests (top of plan) first, then this E2E matrix:

1. **Insufficient funds → 다시 결제하기 → success:** trigger a decline; confirm the itemized failure screen appears (진료 금액 / 메디캐시 사용 / 취소 사유=잔액 부족 / 결제 수단 / 결제 취소) with a single `다시 결제하기` button; tap it with a good card; confirm success screen AND backend receives exactly one `session.result(SUCCESS)`. **← the core reported bug.**
2. **Insufficient funds → back arrow (give up):** confirm backend receives `session.result` with `tossResponse.type === "FAILED"` (reason carried) and CRM can process it; kiosk returns home. **← the second reported bug.**
3. **paymentKey reuse:** confirm a second `requestPayment` on the same key is accepted (else escalate — fall back to start-over).
4. **Reject-after-charge (if reproducible):** force a bridge drop after on-device approval, then back arrow; confirm `getPayment` finds the charge and a `SUCCESS` (not `FAILED`) is sent.
5. **취소 사유 mapping:** trigger 잔액 부족 and 한도 초과 declines; confirm the labels render correctly (finalize the reason-code mapping from real device output).
6. **Regressions:** happy-path card success; 100%-메디캐시 success; refund (`runCancel`); crash-recovery (`session.reconcile`) — all unchanged.

## Self-review notes

- **Spec coverage:** both reported symptoms map to Task 1 (retry screen = `renderFailureScreen` via `renderOrderResultPage`; socket event on failure = `giveUp` sending `FAILED`). Screen template (`renderOrderResultPage`, single `다시 결제하기`) matches the 2026-07-13 기획 mockup; envelope (`FAILED`) and mechanic (same-session) reflect the 2026-07-13 product decisions.
- **Type consistency:** new locals inside `runPayment` — `buildFailedResponse`, `finishSuccess`, `giveUp`, `renderFailureScreen`, `attempt`. `pointUse`/`treatmentTotal`/`charged`/`supplyValue`/`tax` captured from the enclosing scope. `mapTossFailureToKorean`/`mapPaymentMethodToKorean` edits are additive/backward-compatible so `runCancel`'s resolved-result callers still work.
- **Known unknowns are gated, not guessed:** paymentKey reuse, on-device `getPayment`, reason-code mapping, `renderOrderResultPage.onBack`, negative-value render, and blank-WebView are all flagged as [MUST TEST] rather than assumed.
