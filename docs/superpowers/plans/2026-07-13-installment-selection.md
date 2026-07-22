# 할부 Selection Screen + Envelope Truthing Implementation Plan

> ## ⛔ SUPERSEDED 2026-07-22 — do not implement the 할부 screen from this plan
>
> The premise below is **wrong**. The client-mode firmware **does** prompt for
> 할부, on its own 서명 (signature) screen, once the charged amount reaches
> 50,000원. The selection screen this plan builds was implemented (`6c0c968`,
> hardened across `56ffbe4`/`179cc84`/`ab12ba4`) and then **removed** as
> redundant (`4ff13c6`).
>
> - Current design: [`docs/toss-client-mode-flow.md`](../../toss-client-mode-flow.md) §6.6
> - Removal spec: [`2026-07-22-installment-strip-design.md`](../specs/2026-07-22-installment-strip-design.md)
> - Removal plan: [`2026-07-22-installment-strip.md`](2026-07-22-installment-strip.md)
>
> **Still valid — Task 1 only.** This plan bolted two unrelated things together.
> Task 1 (§6.5 give-up envelope truthing) shipped as `63df62f`, is live, and is
> load-bearing: it is why a resolved `CANCELED`/`TIMEOUT` give-up reaches the
> backend with its true type instead of being relabeled `FAILED`. Only Tasks 2–3
> (the 할부 screen and its docs) were withdrawn.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Toss-template 할부(installment) 개월수 selection screen to the card path (device test 2026-07-13 confirmed the firmware does NOT prompt), feed the choice into `requestPayment`'s `installment` param, and fix the give-up envelope so `TIMEOUT`/`CANCELED` give-ups reach the backend with their true type instead of being relabeled `FAILED`.

**Architecture:** A new `renderInstallmentScreen()` inside `runPayment` (sibling of `renderFailureScreen`), using `sdk.template.renderSelectPage` — live-docs contract fetched 2026-07-13: `{ title: string (req), subtitle: string (req), options: { title, subtitle?, description?, iconUrl?, onClick: () => void }[], onBack?: () => void }`; the choice is delivered by each option's own `onClick`. A closure `let installmentMonths = 0` (same pattern as `tax`/`supplyValue`) feeds `attemptOnce`'s `requestPayment` call. The screen shows only when `charged >= 50000` (카드사 5만원 할부 floor — business-confirmed 2026-07-13) and re-asks on every 다시 결제하기 (한도 초과 declines are fixed by switching to installments). Selection-screen back-arrow = give-up (terminal) — `session.abort` is invalid post-`chargeContext` (spec §8).

**Tech Stack:** Plain HTML + inline JS, Toss Front SDK. No test framework — static gate is `node --check` on the extracted inline script; behavior verification is on-device (E2E matrix below).

## Global Constraints

- **Template API only** — the 할부 screen is `renderSelectPage`, no custom HTML. `renderSelectGridPage` was ruled out (no documented `onBack`).
- **Month options (business decision 2026-07-13):** 일시불(`installment: 0`) + 2~12개월(`installment: N`). **No 1개월 option** (1 == 일시불 in Korean card practice; `installment: 1` is undocumented).
- **5만원 gate (business decision 2026-07-13):** show the screen only when `charged >= 50000` (`INSTALLMENT_MIN_AMOUNT` const); below it, go straight to the card UI as 일시불 (today's behavior).
- **Re-ask on every retry (business decision 2026-07-13):** 다시 결제하기 → 할부 screen → card UI (when gated in).
- **Envelope truthing (§6.5):** on give-up, a resolved `CANCELED`/`TIMEOUT` result passes through **unchanged** (backend maps CANCELED→USER_CANCELED, TIMEOUT→EXPIRED); `FAILED` is synthesized **only** for the reject path (no result object).
- **Real-money invariants preserved:** never terminal-`FAILED` a charged session (getPayment reconcile in `giveUp` unchanged); `attemptInFlight` must never be held during customer think-time (selection screen is fire-and-forget, `attempt()` entered only from option `onClick`); all `backendErrorRef` guards unchanged.
- **`paymentKey === sessionId`**; 100%-메디캐시 branch and `runCancel` untouched (the medicash branch returns before the retry loop, so zero-charge sessions structurally never see the 할부 screen).
- 무이자: NOT implementable via the SDK (no param exists — confirmed against live docs 2026-07-13); issuer/merchant contract decides at authorization. Display-only labeling deferred pending business data.

## Cross-team contract addendum (NOT implemented here — for BE/CRM teams)

1. **`cancelParams.installment` (BE):** `requestPaymentCancel` documents `installment` as "원본 결제의 할부 개월" (default 0). Once non-zero installments exist, BE **must** copy the persisted `response.card.installment` into `cancelParams` — otherwise every refund goes out as 일시불. Whether a VAN rejects a mismatched cancel is undocumented → device-test item.
2. **C4 timeout budget (BE):** the selection screen adds unbounded customer think-time *before* the first attempt; the `IN_PROGRESS`→`EXPIRED` watchdog must budget for selection dwell + failure-screen dwell (extends the accepted abandoned-failure-screen shape, §6.5).
3. **CRM receipt:** `HALBU`/`InstallmentPayMonth` already maps from `response.card.installment` — no CRM change, but non-zero values will now appear.

## Gating on-device tests (additions to the existing matrix)

- **[MUST TEST — installment approval]** `requestPayment` with `installment: 3` on a credit card ≥ 5만원 → approved, receipt/`response.card.installment === 3`.
- **[MUST TEST — installment + BARCODE]** what `installment: N` does when the customer picks QR on the firmware overlay (ignored? rejected?). Undocumented.
- **[MUST TEST — renderSelectPage onBack]** `onBack` appears only in the live doc's code example, not its Params interface — confirm it fires on-device.
- **[MUST TEST — overlay transition]** option `onClick` → `requestPayment` firmware overlay: no blank WebView (same family as the retry-screen test).
- **[MUST TEST — cancel of installment payment]** refund a 3개월 approval with `cancelParams.installment` set (and, separately, defaulted to 0) — which succeeds.

---

### Task 1: §6.5 envelope truthing in `giveUp`

**Files:**
- Modify: `front-plugin-js/payment.html` — `buildFailedResponse` (~line 236) and `giveUp`'s final send (~line 336), plus the two doc comments.

**Interfaces:**
- Produces: `buildFailedResponse(rejectErr)` — **signature narrows** from `(result, rejectErr)`; both call sites are inside `giveUp` and both pass `result === null` contexts. Task 2 does not call it.

- [ ] **Step 1: Narrow `buildFailedResponse` to the reject path only.**

Replace the whole function (currently `function buildFailedResponse(result, rejectErr) { ... }`) with:

```javascript
        // Build the §6.5 FAILED envelope — reject path ONLY. A resolved
        // CANCELED/TIMEOUT result is passed through unchanged by giveUp (the
        // backend maps CANCELED→USER_CANCELED, TIMEOUT→EXPIRED); FAILED (→
        // PAYMENT_DECLINED) is synthesized only when requestPayment rejected
        // and there is no result object to forward.
        function buildFailedResponse(rejectErr) {
          const reason =
            (rejectErr && (rejectErr.code || rejectErr.message)) ||
            "PAYMENT_FAILED";
          return { type: "FAILED", response: { reason: String(reason) } };
        }
```

- [ ] **Step 2: Update `giveUp`'s two sends.**

In the inconclusive-getPayment branch (inside `if (!(e && e.code === "PAYMENT_NOT_FOUND")) {`), change `tossResponse: buildFailedResponse(result, rejectErr),` → `tossResponse: buildFailedResponse(rejectErr),` (this branch is only reachable when `result` is null).

In the final send, change `tossResponse: buildFailedResponse(result, rejectErr),` →

```javascript
              // Envelope truthing: forward the real result when we have one;
              // synthesize FAILED only for the reject path.
              tossResponse: result || buildFailedResponse(rejectErr),
```

Also update `giveUp`'s header comment: replace the sentence "Sends the FAILED session.result so the CRM can process the failure." with "Sends the terminal session.result so the CRM can process the outcome — the original CANCELED/TIMEOUT result passed through unchanged, or a synthesized FAILED for the reject path."

- [ ] **Step 3: Static check + commit.**

Extract the inline `<script>` and run `node --check` (see Verification). Expected: no syntax errors, and `grep -n "buildFailedResponse" front-plugin-js/payment.html` shows exactly: the definition + two call sites, all single-argument.

```bash
git add front-plugin-js/payment.html
git commit -m "fix(payment): give-up forwards real CANCELED/TIMEOUT; FAILED only for rejects

giveUp was relabeling every give-up as FAILED, so a timed-out give-up
reached the backend as PAYMENT_DECLINED instead of EXPIRED, contradicting
the §6.5 mapping table. Forward the resolved result unchanged; synthesize
FAILED (buildFailedResponse, now reject-path-only) when there is no result.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 할부 selection screen + `installment` wiring

**Files:**
- Modify: `front-plugin-js/payment.html` — top-of-script const, `renderFailureScreen`'s cta, new `renderInstallmentScreen`, `attemptOnce`'s `requestPayment` call, and the entry point (`await attempt();` at the end of `runPayment`'s non-zero path).

**Interfaces:**
- Consumes: `charged`, `dispatch`, `attempt`, `giveUp`, `fatalToHome`, `attemptInFlight` pattern — all in `runPayment`'s closure. Consumes Task 1's `giveUp` semantics (pass-through envelope).
- Produces: `renderInstallmentScreen(prevResult, prevRejectErr)` (local), `installmentMonths` (closure `let`), `INSTALLMENT_MIN_AMOUNT` (file-level const).

- [ ] **Step 1: Add the gate constant next to `HEARTBEAT_MS`** (top of the inline script):

```javascript
      // 할부 floor: Korean issuers decline installments under 50,000원, so the
      // 할부 selection screen only shows at/above this amount (business
      // decision 2026-07-13). Below it, payment proceeds as 일시불.
      const INSTALLMENT_MIN_AMOUNT = 50000;
```

- [ ] **Step 2: Add the closure state + screen.** Immediately BEFORE the `// Re-entrancy guard:` comment block (above `let attemptInFlight = false;`), insert:

```javascript
        // Chosen 할부 개월수 for this session's attempts. 0 = 일시불 (SDK
        // default). Overwritten on every selection; attemptOnce reads it.
        let installmentMonths = 0;

        // 할부 selection — 기획 2026-07-13. renderSelectPage (Template API;
        // live-docs shape 2026-07-13: title/subtitle required, choice delivered
        // via per-option onClick, onBack shown in the doc's code example —
        // [MUST TEST] that it fires on-device). Options: 일시불(0) + 2~12개월.
        // No 1개월 — 1 == 일시불 in Korean card practice and installment:1 is
        // undocumented. NOTE: payment method (CARD vs QR) is chosen on the
        // firmware overlay AFTER requestPayment, so this is asked first; the
        // subtitle scopes it to card payments. What installment:N does to a
        // BARCODE payment is undocumented — [MUST TEST].
        function renderInstallmentScreen(prevResult, prevRejectErr) {
          const monthOptions = [{ label: "일시불", months: 0 }];
          for (let m = 2; m <= 12; m++) {
            monthOptions.push({ label: m + "개월", months: m });
          }
          sdk.template.renderSelectPage({
            title: "할부 개월수를 선택해주세요",
            subtitle: "카드 결제 시 적용됩니다",
            options: monthOptions.map((opt) => ({
              title: opt.label,
              onClick: () => {
                installmentMonths = opt.months;
                attempt().catch(fatalToHome);
              },
            })),
            // Back arrow = give up (terminal session.result). session.abort is
            // invalid here — order.html already sent chargeContext, the session
            // is IN_PROGRESS (abort is pre-chargeContext only, spec §8). On a
            // first-prompt back-out no attempt has run, so synthesize a
            // USER_BACKED_OUT reject reason; after a failed attempt, pass the
            // real failure context through so the envelope stays truthful.
            onBack: () => {
              const err =
                !prevResult && !prevRejectErr
                  ? { code: "USER_BACKED_OUT" }
                  : prevRejectErr;
              giveUp(prevResult, err).catch(fatalToHome);
            },
          });
        }
```

- [ ] **Step 3: Wire `installment` into `requestPayment`.** In `attemptOnce`, add one line after `tip:`:

```javascript
              tip: dispatch.amount.tip ?? 0,
              installment: installmentMonths, // 0 = 일시불; set by 할부 screen
              timeoutMs: dispatch.timeoutMs ?? 60000,
```

- [ ] **Step 4: Re-ask on retry.** In `renderFailureScreen`'s cta, replace `onClick: () => { attempt().catch(fatalToHome); },` with:

```javascript
              // Re-ask 할부 on every retry (한도 초과 declines are fixed by
              // switching to installments); below the 5만원 floor there is no
              // 할부 to ask — straight back to the card UI.
              onClick: () => {
                if (charged >= INSTALLMENT_MIN_AMOUNT) {
                  renderInstallmentScreen(result, rejectErr);
                } else {
                  attempt().catch(fatalToHome);
                }
              },
```

(Keep the existing "Retry on the SAME session" comment above it.)

- [ ] **Step 5: Entry point.** Replace the final `await attempt();` of the non-zero-charge path with:

```javascript
        // Entry: ask 할부 first when the amount can carry it (5만원 floor);
        // otherwise straight to the card UI as 일시불. The selection screen is
        // fire-and-forget — attempt() is entered from its option onClick, so
        // attemptInFlight is never held during customer think-time.
        if (charged >= INSTALLMENT_MIN_AMOUNT) {
          renderInstallmentScreen(null, null);
        } else {
          await attempt();
        }
```

- [ ] **Step 6: Static checks + commit.**

`node --check` the extracted script. Then verify: `grep -n "installment" front-plugin-js/payment.html` shows the const, the closure let, the screen function, and exactly ONE `installment:` line inside `attemptOnce`'s `requestPayment`. Verify the 100%-메디캐시 branch and `runCancel` have zero diff.

```bash
git add front-plugin-js/payment.html
git commit -m "feat(payment): 할부 개월수 selection screen (renderSelectPage) + installment wiring

Device test 2026-07-13: client-mode firmware does not prompt 할부, so the
plugin owns it. renderSelectPage screen (일시불 + 2~12개월) gated at
charged >= 50,000원, re-asked on every 다시 결제하기; choice feeds
requestPayment's installment param. Back-arrow = terminal give-up
(session.abort invalid post-chargeContext); first-prompt back-out sends
USER_BACKED_OUT. 100%-메디캐시 and runCancel untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Documentation — §6.5 truthing, 할부 design, masked-card [MUST CONFIRM]

**Files:**
- Modify: `docs/toss-client-mode-flow.md`

- [ ] **Step 1: Correct the §6.5 same-session-retry bullet.** In the bullet added 2026-07-13 ("**Same-session retry (2026-07-13):** ..."), replace the sentence "A terminal `session.result` fires only on `SUCCESS` or the back-arrow give-up (`FAILED` envelope); an abandoned failure screen resolves via `EXPIRED`." with:

"A terminal `session.result` fires only on `SUCCESS` or the back-arrow give-up — the give-up envelope forwards a resolved `CANCELED`/`TIMEOUT` **unchanged** (mapping per the table above); `FAILED` is synthesized only for the reject path (no result object), incl. `USER_BACKED_OUT` for a back-out before any attempt. An abandoned failure screen resolves via `EXPIRED`."

- [ ] **Step 2: Add a 할부 subsection after the §6.5 block:**

```markdown
### 6.6 할부 (installment) selection — plugin-owned (2026-07-13)

Device test 2026-07-13: the client-mode firmware payment UI does **not** prompt for 할부 — the plugin owns selection. `payment.html` renders `sdk.template.renderSelectPage` (choice via per-option `onClick`; live-docs shape fetched 2026-07-13) before `requestPayment` when `charged >= 50,000원` (카드사 할부 floor; below it → straight to 일시불). Options: 일시불(`installment:0`) + 2~12개월 (no 1개월). Re-asked on every 다시 결제하기 (한도 초과 → switch-to-installments is the natural retry remedy). Selection back-arrow = terminal give-up (`session.abort` invalid post-`chargeContext`, §8); a first-prompt back-out sends `FAILED`/`USER_BACKED_OUT`.

- 무이자: no SDK param exists (confirmed 2026-07-13); issuer/merchant contract decides at authorization. Display labels deferred pending business data.
- **[BE, MUST DO]** `cancelParams.installment` = persisted `response.card.installment` ("원본 결제의 할부 개월") — else refunds of installment payments go out as 일시불. VAN behavior on mismatch undocumented → device-test.
- **[BE]** C4 `IN_PROGRESS`→`EXPIRED` watchdog must budget selection-screen dwell (pre-first-attempt think time), in addition to failure-screen dwell.
- **[MUST TEST]** installment approval end-to-end; `installment:N` + BARCODE/QR; `renderSelectPage.onBack` fires (example-only in docs); overlay transition (blank-WebView family); cancel of an installment approval with/without `cancelParams.installment`.
```

- [ ] **Step 3: Add the masked-card [MUST CONFIRM] to §9 (receipt printing).** Append to the receipt-printing bullet area (near the "Add receipt printing" line in §9):

```markdown
- **[MUST CONFIRM — receipt card number]** In client mode the printable card number is **Toss's `maskedCardNumber` only** — Toss's VAN never returns the full PAN, and the NICE CAT (printer-only) no longer sees the card. Reader-mode slips printed NICE's own mask format, so the number *looks different* now ("이상하게 들어감", device feedback 2026-07-13). Masked PAN on a 매출전표 is standard/PCI-required; if the *format* is wrong, normalization of `maskedCardNumber` is **CRM-side**. Owner: CRM (+ business sign-off that Toss's mask format is acceptable).
```

- [ ] **Step 4: Commit.**

```bash
git add docs/toss-client-mode-flow.md
git commit -m "docs: §6.5 envelope truthing, §6.6 할부 selection design, masked-card MUST CONFIRM

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verification

Static (each task): extract the inline script and `node --check`:

```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("front-plugin-js/payment.html","utf8");const m=h.match(/<script>\n([\s\S]*?)<\/script>/);fs.writeFileSync("/tmp/pp.js",m[1]);' && node --check /tmp/pp.js
```

On-device E2E additions (beyond the existing retry matrix):
1. 60,000원 card payment → 할부 screen shows → pick 3개월 → approve → `response.card.installment === 3` reaches BE/CRM (HALBU).
2. 16,400원 card payment → NO 할부 screen (straight to card UI, `installment: 0`).
3. Decline at 6만원 → failure screen → 다시 결제하기 → 할부 screen re-asks → pick different months → approve.
4. 할부 screen back-arrow (first prompt) → terminal `session.result` `FAILED`/`USER_BACKED_OUT`, kiosk home.
5. Give-up after a resolved TIMEOUT → backend receives `tossResponse.type === "TIMEOUT"` (→ `EXPIRED`), NOT `FAILED`. **← Task 1's fix.**
6. Regressions: 100%-메디캐시; refund (`runCancel`); happy path below and above the gate.

## Self-review notes

- Spec coverage: 할부 screen (Task 2 Steps 2/5), installment wiring (Step 3), re-ask on retry (Step 4), 5만원 gate (Steps 1/4/5), envelope fix (Task 1), docs incl. masked-card note (Task 3). All four 2026-07-13 decisions reflected.
- Type consistency: `buildFailedResponse(rejectErr)` single-arg everywhere after Task 1; `renderInstallmentScreen(prevResult, prevRejectErr)` mirrors `renderFailureScreen(result, rejectErr)`; `installmentMonths` read only in `attemptOnce`.
- Known unknowns gated, not guessed: five new [MUST TEST]s listed; BE contract items (cancelParams.installment, C4 budget) explicitly out of repo scope.
