# Custom 메디캐시 Page + Flow Restructuring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Toss template `renderUsePointPage` with a custom HTML 메디캐시 page, move `session.chargeContext` from payment.html to order.html, and add a waiting screen that listens for `session.proceed` before navigating to payment.

**Architecture:** All changes are in `front-plugin-js/`. order.html gets a custom 메디캐시 page (rendered via `innerHTML` into `#app`), sends `session.chargeContext` after user choice, and shows a waiting screen until backend sends `session.proceed` over WS B. payment.html loses its chargeContext send but is otherwise unchanged. No new HTML files — order.html handles both the custom page and waiting screen as re-renders of `#app`.

**Tech Stack:** Vanilla JS, HTML, CSS. Toss FRONT SDK v0. Toss Design System CSS (`tds.min.css`, `tps/main.css`, `tps/others.css`). No build step, no test runner.

**Note:** This project has no automated test infrastructure. Verification is manual (visual inspection on device or browser). TDD steps are replaced with implementation + commit steps.

**Spec:** `docs/superpowers/specs/2026-05-11-medicash-page-flow-restructure.md`

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `front-plugin-js/global.css` | Modify | Add styles for custom 메디캐시 page + waiting screen |
| `front-plugin-js/order.html` | Modify (major rewrite of `<script>` block) | Custom 메디캐시 page, `handlePointChoice`, chargeContext send, waiting screen, `session.proceed` handler |
| `front-plugin-js/payment.html` | Modify (minor — delete 11 lines) | Remove chargeContext send from `runPayment` |

---

### Task 1: Add CSS styles for custom 메디캐시 page and waiting screen

**Files:**
- Modify: `front-plugin-js/global.css`

**Context:** The custom 메디캐시 page replaces `sdk.template.renderUsePointPage` which was a Toss-provided template. The custom page must visually match the Toss design system. The `#app` container is 400×640px. Toss Design System colors: primary blue `#3182F6`, text dark `#191F28`, text secondary `#4E5968`, text tertiary `#8B95A1`, surface gray `#F2F4F6`.

- [ ] **Step 1: Add medicash page and waiting screen CSS to global.css**

Append the following CSS after the existing `#app` rule in `front-plugin-js/global.css`:

```css
/* ── Custom 메디캐시 page ─────────────────────────────── */

.medicash-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
}

.medicash-header {
  padding: 16px;
}

.medicash-back {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
}

.medicash-body {
  padding: 0 24px;
}

.medicash-title {
  font-size: 22px;
  font-weight: 700;
  color: #191F28;
  margin: 8px 0 32px;
  text-align: center;
}

.medicash-balance {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
}

.medicash-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #3182F6;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  flex-shrink: 0;
}

.medicash-balance-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.medicash-balance-label {
  font-size: 13px;
  color: #8B95A1;
}

.medicash-balance-amount {
  font-size: 20px;
  font-weight: 700;
  color: #191F28;
}

.medicash-summary {
  border-top: 1px solid #F2F4F6;
  padding: 16px 24px;
  margin-top: auto;
}

.medicash-summary-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
}

.medicash-summary-label {
  font-size: 15px;
  color: #4E5968;
}

.medicash-summary-value {
  font-size: 15px;
  font-weight: 600;
  color: #3182F6;
}

.medicash-summary-total {
  font-size: 15px;
  font-weight: 600;
  color: #191F28;
}

.medicash-actions {
  display: flex;
  gap: 8px;
  padding: 12px 24px 24px;
}

.medicash-btn {
  flex: 1;
  height: 48px;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  border: none;
  cursor: pointer;
}

.medicash-btn-cancel {
  background: #F2F4F6;
  color: #4E5968;
}

.medicash-btn-submit {
  background: #3182F6;
  color: #fff;
}

/* ── Waiting screen ───────────────────────────────────── */

.waiting-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;
}

.waiting-header {
  padding: 16px;
}

.waiting-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
}

.waiting-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #F2F4F6;
  border-top-color: #3182F6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.waiting-message {
  font-size: 18px;
  font-weight: 600;
  color: #191F28;
  text-align: center;
  line-height: 1.5;
  margin: 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add front-plugin-js/global.css
git commit -m "style: add CSS for custom 메디캐시 page and waiting screen"
```

---

### Task 2: Rewrite order.html with custom 메디캐시 page and flow restructuring

**Files:**
- Modify: `front-plugin-js/order.html` (rewrite the entire `<script>` block, lines 28–334)

**Context:** This is the main task. The `<head>` section (lines 1–27) and the `<body>` tag with `<div id="app">` are unchanged. The entire `<script>` block is rewritten. Key changes vs. the current code:

1. **Removed:** `buildOrderSnapshotWithPoints()` function (was for `renderOrderPage`, no longer used)
2. **Removed:** `showOrderPage()` function (was the `renderOrderPage` call + onClick → payment.html navigation)
3. **Removed:** `sdk.template.renderUsePointPage(...)` call (replaced by custom HTML)
4. **Added:** `renderMedicashPage()` — renders custom 메디캐시 HTML into `#app`, binds click handlers
5. **Added:** `handlePointChoice(pointUse)` — computes charged amounts, sends `session.chargeContext` over WS B, stores pointUse in sessionStorage, then either navigates to payment.html (100%-메디캐시) or renders waiting screen
6. **Added:** `renderWaitingScreen()` — renders waiting UI into `#app`, binds back-arrow handler
7. **Added:** `session.proceed` case in WS B onmessage handler — when received and in waiting state, navigates to payment.html
8. **Added:** `sendAbortAndGoHome()` helper — consolidates the abort+cleanup+navigate pattern used by back arrows
9. **Unchanged:** WS B setup, `device.register`, `session.claim`, heartbeat, `computeUsableCash()`, `session.abort`/`error` handlers

- [ ] **Step 1: Replace the `<script>` block in order.html**

Replace everything between `<script>` (line 28) and `</script>` (line 334) with:

```javascript
      const HEARTBEAT_MS = 20000;

      function closeWs(ws) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }

      async function main() {
        const sessionId = location.hash.slice(1);

        const dispatchJson = sessionStorage.getItem("smartdoctor.dispatch");
        const dispatch = dispatchJson ? JSON.parse(dispatchJson) : null;
        if (
          !dispatch ||
          dispatch.kind !== "payment" ||
          dispatch.sessionId !== sessionId
        ) {
          location.href = "./home.html";
          return;
        }

        const { serialNumber } = await sdk.app.getSerialNumber();

        const ws = new WebSocket(window.smartdoctor.pluginWsUrl(serialNumber));
        let heartbeatTimer = null;
        let waitingForProceed = false;

        function sendAbortAndGoHome() {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "session.abort",
                payload: { sessionId, reason: "USER_BACKED_OUT" },
              }),
            );
          }
          closeWs(ws);
          sessionStorage.removeItem("smartdoctor.dispatch");
          sessionStorage.removeItem("smartdoctor.dispatch.pointUse");
          location.href = "./home.html";
        }

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "device.register",
              payload: { serialNumber, sdkVersion: "v0" },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "session.claim",
              payload: { sessionId },
            }),
          );
          heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping", payload: {} }));
            }
          }, HEARTBEAT_MS);
        };

        ws.onclose = () => {
          if (heartbeatTimer != null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        ws.onerror = (ev) => {
          console.warn("[smartdoctor] order.html ws error", ev);
        };

        ws.onmessage = async (ev) => {
          try {
            const msg = JSON.parse(ev.data);

            switch (msg.type) {
              case "pong":
                return;

              case "session.proceed": {
                if (waitingForProceed && msg.payload?.sessionId === sessionId) {
                  closeWs(ws);
                  location.href = "./payment.html#" + sessionId;
                }
                return;
              }

              case "session.abort": {
                ws.onmessage = null;
                console.log(
                  "[smartdoctor] order.html session.abort",
                  msg.payload,
                );
                await sdk.template.openToast({
                  message: "세션이 종료되었어요",
                  icon: "error",
                });
                closeWs(ws);
                location.href = "./home.html";
                return;
              }

              case "error": {
                ws.onmessage = null;
                const p = msg.payload || {};
                console.warn(
                  "[smartdoctor] order.html backend error",
                  p.code,
                  p.message,
                  p.sessionId,
                );
                const reason = p.message || p.code || "알 수 없는 오류";
                await sdk.template.openToast({
                  message: `오류가 발생했어요: ${reason}`,
                  icon: "error",
                });
                closeWs(ws);
                location.href = "./home.html";
                return;
              }

              default:
                console.warn(
                  "[smartdoctor] order.html unknown ws message",
                  msg.type,
                  msg,
                );
                return;
            }
          } catch (e) {
            console.warn(
              "[smartdoctor] order.html ws message handler failed",
              e,
            );
          }
        };

        function computeUsableCash(dispatch) {
          const treatmentTotal =
            dispatch.amount.supplyValue + dispatch.amount.tax;
          const balance = dispatch.pointContext?.availableBalance ?? 0;
          const rawUsable = Math.min(balance, treatmentTotal);
          return Math.floor(rawUsable / 100) * 100;
        }

        const usableCash = computeUsableCash(dispatch);
        const treatmentTotal =
          dispatch.amount.supplyValue + dispatch.amount.tax;
        const minUse = dispatch.pointContext?.minUseAmount ?? 0;

        function handlePointChoice(pointUse) {
          const charged = treatmentTotal - pointUse;
          const tax = Math.floor(charged / 11);
          const supplyValue = charged - tax;

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "session.chargeContext",
                payload: {
                  sessionId,
                  pointUseAmount: pointUse,
                  chargedSupplyValue: supplyValue,
                  chargedTax: tax,
                },
              }),
            );
          }

          sessionStorage.setItem(
            "smartdoctor.dispatch.pointUse",
            String(pointUse),
          );

          if (charged === 0) {
            closeWs(ws);
            location.href = "./payment.html#" + sessionId;
            return;
          }

          waitingForProceed = true;
          renderWaitingScreen();
        }

        function renderMedicashPage() {
          document.getElementById("app").innerHTML = `
            <div class="medicash-page">
              <div class="medicash-header">
                <button class="medicash-back" id="medicashBack">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path d="M15 18l-6-6 6-6" stroke="#191F28" stroke-width="2"
                          stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
              <div class="medicash-body">
                <h1 class="medicash-title">메디캐시를 쓸까요?</h1>
                <div class="medicash-balance">
                  <div class="medicash-icon">P</div>
                  <div class="medicash-balance-info">
                    <span class="medicash-balance-label">사용 가능한 메디캐시</span>
                    <span class="medicash-balance-amount">${usableCash.toLocaleString()}캐시</span>
                  </div>
                </div>
              </div>
              <div class="medicash-summary">
                <div class="medicash-summary-row">
                  <span class="medicash-summary-label">메디캐시 사용</span>
                  <span class="medicash-summary-value">${usableCash.toLocaleString()}캐시</span>
                </div>
                <div class="medicash-summary-row">
                  <span class="medicash-summary-label">총 결제 금액</span>
                  <span class="medicash-summary-total">${(treatmentTotal - usableCash).toLocaleString()}원</span>
                </div>
              </div>
              <div class="medicash-actions">
                <button class="medicash-btn medicash-btn-cancel" id="medicashSkip">사용 안 함</button>
                <button class="medicash-btn medicash-btn-submit" id="medicashUse">전액 사용</button>
              </div>
            </div>
          `;

          document.getElementById("medicashBack").addEventListener(
            "click",
            sendAbortAndGoHome,
          );
          document.getElementById("medicashSkip").addEventListener(
            "click",
            () => handlePointChoice(0),
          );
          document.getElementById("medicashUse").addEventListener(
            "click",
            () => handlePointChoice(usableCash),
          );
        }

        function renderWaitingScreen() {
          document.getElementById("app").innerHTML = `
            <div class="waiting-page">
              <div class="waiting-header">
                <button class="medicash-back" id="waitingBack">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path d="M15 18l-6-6 6-6" stroke="#191F28" stroke-width="2"
                          stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
              <div class="waiting-body">
                <div class="waiting-spinner"></div>
                <p class="waiting-message">카드 단말기에서<br>결제를 진행해주세요</p>
              </div>
            </div>
          `;

          document.getElementById("waitingBack").addEventListener(
            "click",
            sendAbortAndGoHome,
          );
        }

        if (usableCash >= minUse && usableCash > 0) {
          renderMedicashPage();
        } else {
          handlePointChoice(0);
        }
      }

      main().catch((err) => {
        console.error("[smartdoctor] order.html fatal", err);
        location.href = "./home.html";
      });
```

- [ ] **Step 2: Commit**

```bash
git add front-plugin-js/order.html
git commit -m "feat: custom 메디캐시 page + chargeContext in order.html + waiting screen

Replace renderUsePointPage template with custom HTML matching the
메디캐시 branding. Move session.chargeContext send from payment.html
to order.html. Add waiting screen that listens for session.proceed
over WS B before navigating to payment.html."
```

---

### Task 3: Remove chargeContext send from payment.html

**Files:**
- Modify: `front-plugin-js/payment.html` (delete lines 124–134 inside `runPayment`)

**Context:** `session.chargeContext` is now sent from order.html (Task 2). payment.html must stop sending it to avoid a double-send. The computation of `pointUse`, `charged`, `tax`, `supplyValue` on lines 112–122 **stays** — those values are still needed for `requestPayment`, `pendingPayment`, and `session.result`. Only the `sendWs(ws, { type: "session.chargeContext", ... })` call and its comment are removed.

- [ ] **Step 1: Remove the chargeContext send block**

In `front-plugin-js/payment.html`, delete these lines (current lines 124–134):

```javascript
        // 3. session.chargeContext BEFORE requestPayment so backend can
        //    recover even if the plugin reloads mid-Toss-UI. Spec §4.3.
        sendWs(ws, {
          type: "session.chargeContext",
          payload: {
            sessionId: dispatch.sessionId,
            pointUseAmount: pointUse,
            chargedSupplyValue: supplyValue,
            chargedTax: tax,
          },
        });
```

The line immediately after the deletion (`// 3a. 100% 메디캐시 coverage...`) can have its comment number updated from `3a` to `3`, but this is optional.

- [ ] **Step 2: Commit**

```bash
git add front-plugin-js/payment.html
git commit -m "refactor: remove chargeContext send from payment.html

session.chargeContext is now sent from order.html at the end of
phase 1. payment.html only handles phase 2 (requestPayment)."
```
