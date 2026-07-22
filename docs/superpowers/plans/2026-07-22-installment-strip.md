# Strip Plugin-Owned 할부 Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the plugin-owned 할부 개월수 selection screen and every branch that stems from it, letting the Toss client-mode firmware own installment selection.

**Architecture:** Pure removal. Six edit sites in `front-plugin-js/payment.html` (all inside `runPayment`), plus corrections to two docs. The `installment` parameter is dropped from `requestPayment` entirely; the firmware prompts on its own 서명 screen above 50,000원.

**Tech Stack:** Vanilla JS in a single HTML file (`front-plugin-js/payment.html`), Toss Place plugin SDK (`sdk.payment.*`, `sdk.template.*`). No build step, no test suite — this is a device-driven kiosk plugin.

**Spec:** [`docs/superpowers/specs/2026-07-22-installment-strip-design.md`](../specs/2026-07-22-installment-strip-design.md)

## Global Constraints

- **This is a removal, not a refactor.** Do not restructure, rename, reformat, or "improve" any code you touch. If a line is not listed in this plan, it does not change.
- **Do not touch the retry/hardening machinery.** `attempt` / `attemptOnce` / `attemptInFlight`, `terminalized`, `hadRejectedAttempt`, `fatalToHome`, `giveUp` and its `getPayment` reconcile, `buildFailedResponse`, `renderFailureScreen`'s structure, and the SUCCESS-outranks-error-frame ordering in `attemptOnce` all stay byte-identical except where a step below quotes them explicitly. Three rounds of money-safety fixes live in that code.
- **`interacted = true` must remain the first statement** in `renderFailureScreen`'s cta `onClick`. It is staleness-token hardening from commit `179cc84`, not part of the 할부 work.
- **Do not touch `front-plugin-js/order.html`.** Its `session.abort(reason: "USER_BACKED_OUT")` is a different wire message at a different lifecycle stage and is unaffected.
- **Do not touch `runCancel`** or the 100%-메디캐시 (`charged === 0`) branch.
- **Do not touch `installment` references in any other doc.** The hits in `docs/superpowers/specs/*` and `docs/integration/findings.md` describe the SDK's `response.card.installment` response shape, which is unchanged.
- **Do not modify `docs/superpowers/plans/2026-07-13-installment-selection.md`.** It is the historical record of the work being removed. It currently has uncommitted Prettier reformatting in the working tree — leave that file entirely alone, staged or not.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Branch: `feature/client-mode-payment`. Forward commits only — never `git revert`.

---

## File Structure

| File | Responsibility | This plan's change |
|---|---|---|
| `front-plugin-js/payment.html` | The whole payment/cancel terminal page. 923 lines, single `<script>`. Existing codebase pattern — do not split it. | Task 1: remove 6 할부 sites from `runPayment` |
| `docs/toss-client-mode-flow.md` | Living design doc for client mode. §6.5 failure envelope, §6.6 할부, §10 edge-case table. | Task 2: correct §6.5/§6.6/§10 |
| `docs/integration/handoff-crm-backend-2026-07-13.md` | Frozen handoff artifact already delivered to BE/CRM. | Task 3: addendum + body edits so it doesn't self-contradict |

---

### Task 1: Remove the 할부 selection screen from `payment.html`

**Files:**

- Modify: `front-plugin-js/payment.html` — 6 sites inside `runPayment`

**Interfaces:**

- Removes: `INSTALLMENT_MIN_AMOUNT` (const), `installmentMonths` (let), `renderInstallmentScreen(prevResult, prevRejectErr)` (function). No other file references them (verified: the only file in `front-plugin-js/` matching `installment|할부` is `payment.html`).
- Unchanged and still relied on by everything else: `attempt()`, `attemptOnce()`, `renderFailureScreen(result, rejectErr)`, `giveUp(result, rejectErr)`, `fatalToHome(err)`, `buildFailedResponse(rejectErr)`.

**Note on the working tree:** `payment.html` has one uncommitted edit — the 할부 subtitle string `"신용카드 결제만 적용됩니다"` at line 511. It sits inside the block being deleted, so it disappears with it. That is intended; do not try to preserve it.

- [ ] **Step 1: Record the baseline**

Run:

```bash
grep -c 'installment\|할부\|INSTALLMENT' front-plugin-js/payment.html
```

Expected: `17` (verified 2026-07-22 against the current working tree)

- [ ] **Step 2: Site 1 — delete the `INSTALLMENT_MIN_AMOUNT` const**

Delete these four lines (currently at ~line 44) **and the blank line that follows them**:

```javascript
      // 할부 floor: Korean issuers decline installments under 50,000원, so the
      // 할부 selection screen only shows at/above this amount (business
      // decision 2026-07-13). Below it, payment proceeds as 일시불.
      const INSTALLMENT_MIN_AMOUNT = 50000;
```

The `HEARTBEAT_MS` const above and the `mapTossFailureToKorean` comment block below must end up separated by exactly one blank line, matching the file's existing spacing.

- [ ] **Step 3: Site 2 — reword the staleness comment in `renderFailureScreen`**

This comment (currently at ~line 401) cross-references the function being deleted. Replace:

```javascript
          // Same staleness token as renderInstallmentScreen: a pre-interaction
          // render rejection routes home; a post-interaction settle is a stale
          // dismissal from this screen's own replacement — swallow it.
```

with:

```javascript
          // Staleness token: a pre-interaction render rejection routes home; a
          // post-interaction settle is a stale dismissal from this screen's own
          // replacement — swallow it.
```

Only the comment text changes. The `let interacted = false;` line below it and every use of `interacted` stay exactly as they are.

- [ ] **Step 4: Site 3 — unconditional retry in the failure screen's cta**

Replace this block (currently at ~line 447):

```javascript
            cta: {
              text: "다시 결제하기",
              // Retry on the SAME session — no terminal result was sent, so the
              // backend session is still IN_PROGRESS and this re-attempt is valid.
              // Re-ask 할부 on every retry (한도 초과 declines are fixed by
              // switching to installments); below the 5만원 floor there is no
              // 할부 to ask — straight back to the card UI.
              onClick: () => {
                interacted = true;
                if (charged >= INSTALLMENT_MIN_AMOUNT) {
                  renderInstallmentScreen(result, rejectErr);
                } else {
                  attempt().catch(fatalToHome);
                }
              },
            },
```

with:

```javascript
            cta: {
              text: "다시 결제하기",
              // Retry on the SAME session — no terminal result was sent, so the
              // backend session is still IN_PROGRESS and this re-attempt is valid.
              // 할부 is re-offered by the firmware itself on every fresh
              // requestPayment (서명 screen, ≥5만원), so a 한도 초과 decline is
              // still remediable by switching to installments on retry.
              onClick: () => {
                interacted = true;
                attempt().catch(fatalToHome);
              },
            },
```

`interacted = true;` stays the first statement. The `onBack` handler directly below this block is **not** part of this edit — leave it untouched.

- [ ] **Step 5: Site 4 — delete `installmentMonths` and `renderInstallmentScreen`**

Delete the entire run from the `installmentMonths` comment (currently ~line 482) through the closing brace of `renderInstallmentScreen` (currently ~line 550), **plus the blank line that follows it**. That is this whole region:

```javascript
        // Chosen 할부 개월수 for this session's attempts. 0 = 일시불 (SDK
        // default). Overwritten on every selection; attemptOnce reads it.
        let installmentMonths = 0;
```

…through…

```javascript
          })).catch((err) => {
            // A render rejection BEFORE any interaction means the screen never
            // engaged — without routing home the kiosk is stranded on a dead
            // screen (panel fix 2026-07-13). Once interacted, any settle of
            // this promise is a stale dismissal (the screen was legitimately
            // replaced via its own callbacks) — swallow it, never yank the
            // customer off a live retry flow.
            if (!interacted && !terminalized) {
              fatalToHome(err);
            } else {
              console.warn(
                "[smartdoctor] renderSelectPage stale rejection (ignored)",
                err,
              );
            }
          });
        }
```

**Delete only that region.** The comment block immediately after it — the one beginning `// Re-entrancy guard: a double-tap on 다시 결제하기…` and its `let attemptInFlight = false;` — is retry hardening and must survive verbatim. So must `terminalized` and `hadRejectedAttempt` below it. After the deletion, `renderFailureScreen`'s closing `}` should be followed by one blank line and then the `// Re-entrancy guard:` comment.

- [ ] **Step 6: Site 5 — drop the `installment` param**

In `attemptOnce`'s `sdk.payment.requestPayment({...})` call (currently ~line 603), delete this single line:

```javascript
              installment: installmentMonths, // 0 = 일시불; set by 할부 screen
```

Every other property in that object — `paymentKey`, `tax`, `supplyValue`, `tip`, `timeoutMs`, `localeCode`, `excludePaymentTypes` — stays. The SDK documents `installment` as optional with default `0`, so omitting it is the documented no-op; we omit rather than pin `0` so the firmware sees no merchant pre-set.

- [ ] **Step 7: Site 6 — unconditional entry point**

At the end of `runPayment` (currently ~line 644), replace:

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

with:

```javascript
        await attempt();
```

This restores the pre-할부 shape exactly — verify with `git show 63df62f:front-plugin-js/payment.html | sed -n '490,494p'`, which shows `await attempt();` as the last statement of `runPayment` followed by the function's closing `}`.

- [ ] **Step 8: Verify the removal is complete**

Run:

```bash
grep -n 'installment\|할부\|INSTALLMENT' front-plugin-js/payment.html
```

Expected: **exactly two lines** — the explanatory comment lines inside `renderFailureScreen`'s cta added by Step 4:

```
// 할부 is re-offered by the firmware itself on every fresh
// still remediable by switching to installments on retry.
```

Those two are intentional: they document *why* retry no longer re-asks, which is the single most likely thing for a future reader to get wrong. **Any other match means a site was missed** — in particular there must be no match for `INSTALLMENT_MIN_AMOUNT`, `installmentMonths`, or `renderInstallmentScreen`. Verify that separately:

```bash
grep -n 'INSTALLMENT_MIN_AMOUNT\|installmentMonths\|renderInstallmentScreen\|renderSelectPage' front-plugin-js/payment.html
```

Expected: no output (exit status 1).

- [ ] **Step 9: Verify the file still parses**

Run:

```bash
node --input-type=module -e "
const fs = await import('node:fs');
const html = fs.readFileSync('front-plugin-js/payment.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
for (const [i, src] of scripts.entries()) new Function(src);
console.log('OK — ' + scripts.length + ' script block(s) parsed');
"
```

Expected: `OK — N script block(s) parsed` with no `SyntaxError`. This catches an unbalanced brace from the Step 5 block deletion, which is the most likely mistake in this task.

- [ ] **Step 10: Verify nothing but 할부 lines moved**

Run:

```bash
git diff --stat front-plugin-js/payment.html
git diff front-plugin-js/payment.html | grep '^[+-]' | grep -v '^[+-][+-]' | wc -l
```

Then read the full diff (`git diff front-plugin-js/payment.html`) and confirm every removed line is either 할부 machinery or a comment referencing it, and every added line is one of the three replacement blocks above. Report the diff stat in your report file.

- [ ] **Step 11: Commit**

```bash
git add front-plugin-js/payment.html
git commit -m "$(cat <<'EOF'
feat(payment): remove plugin-owned 할부 screen — firmware owns selection

The 2026-07-13 finding that the client-mode firmware does not prompt for
할부 was wrong: it prompts on the 서명 screen once the charged amount
exceeds 50,000원. Removes renderInstallmentScreen, INSTALLMENT_MIN_AMOUNT,
installmentMonths, and the retry-path branch on the 5만원 floor.

requestPayment now omits `installment` entirely (SDK default 0) rather
than pinning it, so the firmware sees no merchant pre-set.

Retires the payment-side FAILED/USER_BACKED_OUT envelope — the 할부
screen's back-arrow was its only producer. order.html's
session.abort(USER_BACKED_OUT) on the 메디캐시 page is unaffected.

Retry/hardening machinery (staleness tokens, terminal latch,
hadRejectedAttempt, giveUp reconcile, SUCCESS-outranks-error-frame
ordering) is untouched.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Correct `docs/toss-client-mode-flow.md`

**Files:**

- Modify: `docs/toss-client-mode-flow.md` — §6.5 mapping table row, §6.5 retry bullet, §6.6 (full rewrite), §10 edge-case table row

**Interfaces:**

- Consumes: the code state after Task 1 (no plugin 할부 screen, no `installment` param).
- Produces: §6.6 is the canonical reference the Task 3 addendum points at. Its heading text must read exactly `### 6.6 할부 (installment) selection — firmware-owned (corrected 2026-07-22)`.

- [ ] **Step 1: §6.5 — mark the `USER_BACKED_OUT` row retired**

In the mapping table under §6.5 (currently ~line 328), replace this row:

```markdown
| `FAILED`, `response.reason === "USER_BACKED_OUT"` (back-out before any attempt — 할부 screen back-arrow, §6.6) | `CANCELED` | `USER_CANCELED` — **not** a card decline |
```

with:

```markdown
| ~~`FAILED`, `response.reason === "USER_BACKED_OUT"`~~ — **RETIRED 2026-07-22.** Its only producer was the plugin 할부 screen's back-arrow; with that screen removed (§6.6) no plugin-owned screen sits between `chargeContext` and `requestPayment`, so the payment page never emits this. `order.html`'s `session.abort(USER_BACKED_OUT)` on the 메디캐시 page is a **different** message at a **different** stage and is unaffected. | ~~`CANCELED`~~ | ~~`USER_CANCELED`~~ |
```

The row is kept rather than deleted so a BE engineer reading the already-delivered handoff can find out what happened to it.

- [ ] **Step 2: §6.5 — drop `USER_BACKED_OUT` from the retry bullet**

In the **Same-session retry (2026-07-13)** bullet (currently ~line 333), find this fragment:

```
`FAILED` is synthesized only for the reject path (no result object), incl. `USER_BACKED_OUT` for a back-out before any attempt.
```

and replace it with:

```
`FAILED` is synthesized only for the reject path (no result object).
```

Nothing else in that bullet changes — the `getPayment` reconcile sentence, the `[MUST TEST]` dependency list, and the "Supersedes" sentence all stay.

- [ ] **Step 3: §6.6 — replace the section**

Replace the entire §6.6 section (heading at ~line 336 through the last `[MUST TEST]` bullet at ~line 343, stopping **before** the `---` separator) with:

```markdown
### 6.6 할부 (installment) selection — firmware-owned (corrected 2026-07-22)

**Correction.** The 2026-07-13 entry here recorded that the client-mode firmware payment UI does **not** prompt for 할부, and the plugin grew its own `sdk.template.renderSelectPage` 개월수 screen on that basis. **That finding was wrong.** Device observation 2026-07-22: the firmware prompts on the **서명 (signature)** screen — a `할부 … 일시불 >` row that opens the module's own 개월수 picker — and the row appears automatically once the charged amount exceeds 50,000원. The plugin screen asked the same question one screen earlier and the firmware asked again regardless, so it has been **removed**. `payment.html` now calls `requestPayment` with **no `installment` param** (SDK default `0`) and the module owns selection end to end.

Consequences of the removal:

- The plugin no longer has any screen between `chargeContext` and `requestPayment`. The `FAILED`/`USER_BACKED_OUT` envelope had no other producer and is **retired** (§6.5).
- Retry (`다시 결제하기`) goes straight back to `requestPayment`; the firmware re-prompts for 할부 on each fresh call, so switching to installments remains the natural remedy for a 한도 초과 decline.

Unchanged obligations — firmware-owned selection makes non-zero `response.card.installment` values **more** likely, not less:

- 무이자: no SDK param exists (confirmed 2026-07-13); the issuer/merchant contract decides at authorization.
- **[BE, MUST DO]** `cancelParams.installment` = persisted `response.card.installment` ("원본 결제의 할부 개월") — else refunds of installment payments go out as 일시불. VAN behavior on mismatch undocumented → device-test.
- **[CRM]** `HALBU`/`InstallmentPayMonth` ← `response.card.installment`.
- **[BE]** C4 `IN_PROGRESS`→`EXPIRED` watchdog: 할부 dwell is now **inside** the firmware's own `timeoutMs` window rather than separate pre-attempt plugin think-time. Failure-screen dwell and N retries still apply.
- **[MUST TEST]** (1) omitting `installment` still shows the firmware 할부 row at ≥5만원 and not below; (2) a 3개월 selection echoes back as `response.card.installment === 3`; (3) installment approval end-to-end; (4) cancel of an installment approval with vs. without `cancelParams.installment`; (5) overlay transition (blank-WebView family).
```

- [ ] **Step 4: §10 — drop the 할부 re-ask parenthetical**

In the §10 edge-case table (currently ~line 423), in the row beginning `| Card declined / \`requestPayment\` \`CANCELED\`/\`TIMEOUT\`/reject |`, find:

```
session stays `IN_PROGRESS` for same-session retry (할부 re-asked per §6.6);
```

and replace with:

```
session stays `IN_PROGRESS` for same-session retry;
```

The row's trailing `| §6.5, §6.6 |` source cell stays — §6.6 still exists and is still relevant.

- [ ] **Step 5: Verify the doc is self-consistent**

Run:

```bash
grep -n '할부\|installment\|USER_BACKED_OUT' docs/toss-client-mode-flow.md
```

Read every hit and confirm: no surviving line claims the plugin owns 할부 selection, no line claims the firmware does not prompt, and the only `USER_BACKED_OUT` hits are (a) the retired §6.5 row and (b) the 메디캐시 `session.abort` rows in §10 and elsewhere, which are correct as-is. Record the hit list in your report file.

- [ ] **Step 6: Commit**

```bash
git add docs/toss-client-mode-flow.md
git commit -m "$(cat <<'EOF'
docs: §6.6 할부 is firmware-owned — correct the 2026-07-13 finding

The firmware does prompt for 할부, on the 서명 screen above 50,000원.
Rewrites §6.6 as firmware-owned (keeping the record of the wrong finding
so nobody re-derives the plugin screen from it), retires the §6.5
FAILED/USER_BACKED_OUT row, and drops the 할부 re-ask note from §10.

BE cancelParams.installment and CRM HALBU obligations are unchanged —
firmware-owned selection makes non-zero installments more likely.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Addendum to the CRM/backend handoff

**Files:**

- Modify: `docs/integration/handoff-crm-backend-2026-07-13.md` — new addendum section plus 6 body edits

**Interfaces:**

- Consumes: §6.6 of `docs/toss-client-mode-flow.md` as rewritten in Task 2 (the addendum links to it).

**Context:** This document was already delivered to the BE and CRM teams, who were explicitly told to implement the `USER_BACKED_OUT` row. It keeps its 2026-07-13 date and identity; the addendum supersedes parts of it in place. The body edits exist so the document does not contradict its own addendum — a reader who skips the addendum must not be misled.

- [ ] **Step 1: Insert the addendum**

Insert this section immediately after the `---` that follows the `**Design doc:**` line near the top of the file (i.e. before `## 1. What the plugin now does`):

```markdown
## ⚠️ Addendum 2026-07-22 — the plugin 할부 screen was withdrawn

The 2026-07-13 device finding behind §1's 할부 bullet was **wrong**: the client-mode firmware **does** prompt for 할부, on the **서명 (signature)** screen, automatically once the charged amount exceeds 50,000원. The plugin's own 개월수 selection screen was therefore redundant and **has been removed**. The plugin now calls `requestPayment` with **no `installment` param** and the module owns selection end to end.

| Item | Status |
|---|---|
| `FAILED` / reason `USER_BACKED_OUT` (§2.1 table) | **RETIRED.** The 할부 screen's back-arrow was its only producer; the payment page will never emit it. Handling you have already built is harmless — a branch that never fires. |
| C4 watchdog budget (§2.2) | **Narrows.** 할부 dwell is now inside the firmware's own `timeoutMs` window, not separate pre-attempt plugin think-time. Failure-screen dwell + N retries still apply. |
| Device test 4 (할부-screen back-arrow) | **Struck** — the screen no longer exists. |
| Device test 6 (`installment: N` + QR/BARCODE) | **Struck** — the plugin no longer sends `installment`. |
| Device test 2 (6만원 + 3개월 end-to-end) | **Still required, re-owned:** the 3개월 is now chosen on the firmware 서명 screen. Must still echo `response.card.installment === 3`. |
| §2.4 `cancelParams.installment` ← MUST DO | **Unchanged and still required.** |
| §3 `HALBU` / `InstallmentPayMonth` | **Unchanged and still required.** |

**New device test (FE + device):** confirm that omitting `installment` still shows the firmware 할부 row at ≥5만원 and not below.

> **Not affected:** `order.html`'s `session.abort(reason: "USER_BACKED_OUT")` during the 메디캐시 selection UI. That is a **different wire message** at a **different lifecycle stage** (pre-`chargeContext`) and keeps working exactly as specified. "`USER_BACKED_OUT` retired" applies **only** to the `session.result` `FAILED` envelope on the payment page.

Everything else in this document — the failure envelope, same-session retry semantics, `FAILED`→late-`SUCCESS` idempotency, and the receipt mask item — is unchanged.

---
```

- [ ] **Step 2: Body edit — plugin-side status line**

Replace this line (currently line 5):

```markdown
**Plugin-side status:** implemented on `feature/client-mode-payment` (retry screen, failure envelope, 할부 선택). One hardening fix-round in progress; **the wire contract below is final and unaffected by it.**
```

with:

```markdown
**Plugin-side status:** implemented on `feature/client-mode-payment` (retry screen, failure envelope). **The 할부 선택 screen was withdrawn 2026-07-22 — see the addendum below.** The wire contract below is otherwise final.
```

- [ ] **Step 3: Body edit — §1 할부 bullet**

Replace this bullet (currently line 14):

```markdown
- For `charged >= 50,000원`, a **할부 개월수 selection screen** (일시불 + 2~12개월) shows before payment; the choice goes into `requestPayment.installment`. Below 5만원: always 일시불 (`installment: 0`).
```

with:

```markdown
- **할부 (superseded 2026-07-22 — see addendum):** the plugin sends no `installment` and shows no selection screen. The **firmware** prompts for 할부 on its 서명 screen above 50,000원, and the chosen 개월수 comes back on `response.card.installment` as before.
```

- [ ] **Step 4: Body edit — §2.1 `USER_BACKED_OUT` row**

Replace this table row (currently line 41):

```markdown
| `FAILED`, reason = `USER_BACKED_OUT` | customer backed out **before any attempt** (할부 screen back-arrow) | `CANCELED` | `USER_CANCELED` — **not** a card decline |
```

with:

```markdown
| ~~`FAILED`, reason = `USER_BACKED_OUT`~~ | **RETIRED 2026-07-22** (see addendum) — its only producer was the withdrawn 할부 screen's back-arrow. Not emitted by the payment page. Unrelated to `order.html`'s `session.abort(USER_BACKED_OUT)`, which still fires. | ~~`CANCELED`~~ | ~~`USER_CANCELED`~~ |
```

- [ ] **Step 5: Body edit — §2.2 C4 watchdog bullet**

Replace this bullet (currently line 51):

```markdown
- **C4 watchdog budget:** think-time now includes 할부-selection dwell + failure-screen dwell + N retries (each up to `timeoutMs`, default 60s). Size the `IN_PROGRESS`→`EXPIRED` timer accordingly (or accept more `EXPIRED`-then-late-SUCCESS reconciles).
```

with:

```markdown
- **C4 watchdog budget:** think-time now includes failure-screen dwell + N retries (each up to `timeoutMs`, default 60s). Firmware 할부 dwell sits **inside** each attempt's `timeoutMs` window, so it needs no separate budget (revised 2026-07-22 — see addendum). Size the `IN_PROGRESS`→`EXPIRED` timer accordingly (or accept more `EXPIRED`-then-late-SUCCESS reconciles).
```

- [ ] **Step 6: Body edit — strike device-test rows 4 and 6**

Replace this row (currently line 79):

```markdown
| 4 | 할부-screen back-arrow (first prompt) → `FAILED`/`USER_BACKED_OUT` → CRM records user-cancel, not decline | BE + CRM |
```

with:

```markdown
| 4 | ~~할부-screen back-arrow → `FAILED`/`USER_BACKED_OUT`~~ **STRUCK 2026-07-22** — screen withdrawn. Replaced by: firmware 할부 row appears ≥5만원 and not below, with no `installment` sent | FE + device |
```

And replace this row (currently line 81):

```markdown
| 6 | `installment: N` when customer pays by QR/BARCODE on the firmware overlay (ignored? rejected?) | FE + device |
```

with:

```markdown
| 6 | ~~`installment: N` when customer pays by QR/BARCODE~~ **STRUCK 2026-07-22** — the plugin no longer sends `installment` | — |
```

- [ ] **Step 7: Verify no surviving contradiction**

Run:

```bash
grep -n '할부\|installment\|USER_BACKED_OUT' docs/integration/handoff-crm-backend-2026-07-13.md
```

Read every hit. Confirm no surviving line tells BE/CRM that the plugin shows a 할부 screen or sends an `installment` value, and that §2.4 (`cancelParams.installment`) and §3 (`HALBU`) are still present and intact. The `"installment": 3` inside the §5 example JSON response is correct and must stay — it is the SDK's response shape. Record the hit list in your report file.

- [ ] **Step 8: Commit**

```bash
git add docs/integration/handoff-crm-backend-2026-07-13.md
git commit -m "$(cat <<'EOF'
docs: handoff addendum — plugin 할부 screen withdrawn

Tells BE/CRM that the firmware owns 할부 (서명 screen, >50,000원), that
the payment-side FAILED/USER_BACKED_OUT envelope is retired, and that
device tests 4 and 6 are struck. Calls out explicitly that order.html's
session.abort(USER_BACKED_OUT) is a different message and still fires.

cancelParams.installment and HALBU bookkeeping are unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Plan self-review

**Spec coverage:**

| Spec item | Task |
|---|---|
| Code sites 1–6 | Task 1, Steps 2–7 |
| D1 omit `installment` | Task 1, Step 6 |
| D2 retire `USER_BACKED_OUT` (code) | Task 1, Step 5 (deleted with the screen) |
| D2 retire `USER_BACKED_OUT` (docs) | Task 2 Step 1; Task 3 Steps 1, 4 |
| D2 `order.html` asymmetry stated explicitly | Task 2 Step 1; Task 3 Step 1 |
| D3 retry re-asks nothing | Task 1, Step 4 |
| D4 §6.6 corrected in place | Task 2, Step 3 |
| D4 BE/CRM obligations survive | Task 2 Step 3; Task 3 Step 7 verification |
| D5 forward commits | Global Constraints |
| Post-condition grep | Task 1, Step 8 |
| Syntax check | Task 1, Step 9 |
| Diff read-through vs `63df62f` | Task 1, Steps 7, 10 |
| Test matrix changes | Task 2 Step 3; Task 3 Steps 1, 6 |

No gaps.

**Placeholders:** none — every step quotes the exact before/after text.

**Type consistency:** the only cross-task identifier is the §6.6 heading string, pinned in Task 2's Interfaces block and referenced by Task 3's addendum.
