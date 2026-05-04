> **Status: Historical / superseded**
>
> This document captures the contract as of 2026-04-27. The deployed canonical
> spec is now `docs/superpowers/specs/toss-payment-flow.md` (updated 2026-04-30
> with §6 100%-medicash + §11 error frames + clinicSeqNo rename). Refer to that
> file for current behavior; this one is kept for context on the design journey.

# Toss Front Plugin — Frontend Spec

**Audience:** Plugin engineer building the HTML/JS in `front-plugin-js/`.
**Compiled:** 2026-04-27, from `2026-04-24-toss-front-integration-design.md` and `2026-04-24-backend-handoff.md` after the 2026-04-27 doc-correction pass.
**Source-of-truth Toss docs (verified 2026-04-24 and re-checked 2026-04-27):** see §11.

---

## 0. How to read this document

Every factual claim carries a source tag:

- `[docs: <url>]` — verbatim from Toss Place official documentation
- `[crm: <path>:<line>]` — direct read of the SmartDoctorCrm repository
- `[starter: <path>:<line>]` — direct read of the Toss front plugin starter (this repo)
- `[GAP]` — information we explicitly could not retrieve (403, not documented, etc.)
- `[BLOCKER]` — must be resolved (Toss support / real-device test) before that part can ship

Nothing in this document is paraphrased from memory.

---

## 1. Goal

The plugin is the HTML/JS that runs inside the Toss Place Front Android device's in-app browser. It is the **only** software in the system that calls the Toss SDK — CRM and backend never talk to the Toss device directly.

Plugin responsibilities:

- Read the device serial via `sdk.app.getSerialNumber()` and present it to the backend on WS B (no login, no token)
- Maintain a WebSocket connection to **our** backend (WS B) — plugin acts as **client**
- Render order/point/result pages via the Template API
- Call `sdk.payment.requestPayment` / `requestPaymentCancel` and report results back over WS B
- Locally persist a recovery context (`smartdoctor.pendingPayment` in `sdk.storage`) so an in-flight payment can be reconstructed across page reloads/crashes

Out of scope for the plugin: any business logic that belongs in CRM or backend (point ledger, receipt persistence, refund authorization, session state).

---

## 2. Verified Toss SDK constraints

### 2.1 `sdk.payment` — methods we use

`[docs: https://docs.tossplace.com/reference/plugin-sdk/front/payment.html]`

Verified method list on this page: `requestPayment`, `requestBarcodePayment`, `requestCashPayment`, `requestPaymentCancel`, `getPayment`, `getPaymentCancel`. **Nothing else** (no `getPaymentByKey`, no `getBackupPaymentKey`, no `resetBackupPaymentKey`, no abort-in-flight method).

#### `requestPayment` — input

| Param                 | Type           | Required | Default                                                                                                                                                                                                                          |
| --------------------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paymentKey`          | `string`       | ✓        | —                                                                                                                                                                                                                                |
| `tax`                 | `number`       | ✓        | —                                                                                                                                                                                                                                |
| `supplyValue`         | `number`       | ✓        | —                                                                                                                                                                                                                                |
| `tip`                 | `number`       | ✓        | —                                                                                                                                                                                                                                |
| `installment`         | `number`       |          | `0`                                                                                                                                                                                                                              |
| `timeoutMs`           | `number`       |          | `60000`                                                                                                                                                                                                                          |
| `localeCode`          | `'ko' \| 'en'` |          | `'ko'`                                                                                                                                                                                                                           |
| `excludePaymentTypes` | `['CASH']`     |          | Default is **not documented**. The only documented value is `['CASH']`, described as excluding cash ("제외할 결제 수단 (현재 현금만 지원)"). `[]` is not documented; do not rely on it without Toss support/device verification. |

#### `requestPaymentCancel` — input

Required: `paymentKey`, `paymentMethod` (`'CARD' | 'CASH' | 'BARCODE'`), `tax`, `supplyValue`, `tip`, `timestamp`, `approvalNumber`. Optional: `installment`, `timeoutMs`, `localeCode`, `extraData.vanTransactionManagementId`, `isSelfIssuance`, `excludePaymentTypes`.

#### `requestCashPayment` — input

Same base params as `requestPayment` **plus** `identityNumber` (string, "현금영수증 번호 (휴대폰번호 또는 사업자번호)") and `issuerType` (`'CONSUMER' | 'BUSINESS'`, "소득 구분"). The integrated `requestPayment` method does NOT take these — see §6 cash blockers.

#### `getPayment` — input/cache

`getPayment({ paymentKey: string })` returns the same shape as `requestPayment` SUCCESS response. Errors: `INVALID_PARAMS`, `PAYMENT_NOT_FOUND`.

Cache (verbatim):

> "TTL 14일, 최대 1,000건이 저장됩니다. `SUCCESS` 결과만 캐시되며, `CANCELED`, `TIMEOUT`, 승인 실패 결과는 캐시되지 않습니다."

Device scope (verbatim):

> "결제를 요청한 단말기에서만 조회할 수 있습니다. 다른 단말기나 서버에서는 조회할 수 없습니다."

**Consequence:** a payment approved on device A cannot be recovered from device B, even when both are bound to the same merchant. Backend must persist the full `tossResponse` at approval time, because it cannot fetch it later via any `sdk.*` method.

`getPaymentCancel` has the same shape and the same device-local restriction.

### 2.2 Payment response shapes

**Response envelope:** `{ type: 'SUCCESS' | 'CANCELED' | 'TIMEOUT', response: {...} }`

Fields are nested under `response.card`, `response.barcode`, or `response.cash`, **NOT** at the top of `response`.

**CARD / Samsung Pay / Apple Pay:**

```typescript
{ type: 'SUCCESS', response: { paymentMethod: 'CARD', card: { van: string, timestamp: number, approvalNumber: string, acquirerName: string, acquirerCode: string, issuerName: string, issuerCode: string, cardType: string, balance: number, installment: number, maskedCardNumber: string } } }
```

**BARCODE** (Alipay/WeChat etc.):

```typescript
{ type: 'SUCCESS', response: { paymentMethod: 'BARCODE', barcode: { van: string, timestamp: number, approvalNumber: string, acquirerName: string, acquirerCode: string, issuerName: string, issuerCode: string, cardType: string, balance: number, installment: number, shopCode: string }, extraData: { vanTransactionManagementId: string } } }
```

For barcode, `extraData` is a sibling of `barcode` INSIDE `response`. `extraData.vanTransactionManagementId` is **required when cancelling** barcode payments per the cancel API.

**CASH with receipt:**

```typescript
{ type: 'SUCCESS', response: { paymentMethod: 'CASH', cash: { isCashReceipt: true, cashReceipt: { van: string, timestamp: number, issuerType: 'CONSUMER' | 'BUSINESS', issuanceType: 'PHONE' | 'BUSINESS_NUMBER' | 'CARD', identityNumber: string, maskedIdentityNumber: string, approvalNumber: string, isSelfIssuance: boolean } } } }
```

**CASH without receipt:**

```typescript
{ type: 'SUCCESS', response: { paymentMethod: 'CASH', cash: { isCashReceipt: false } } }
```

`[GAP]` The docs do **not** specify how the device decides between the two cash outcomes, nor when/how the user is prompted for phone/biz number when `requestPayment` (integrated) is used rather than `requestCashPayment` (dedicated). Do not assume the Toss device prompts the customer. Cash is not implementable in v1 until a real device or Toss support confirms the UX and refund metadata.

`[BLOCKER]` The documented CASH-without-receipt response has no `timestamp` or `approvalNumber`, while `requestPaymentCancel` requires both. If Toss can return `isCashReceipt: false` from a flow we allow, the current full-cancel contract cannot reconstruct a Toss cancel. Either prevent that outcome, obtain a documented cancel primitive for it, or keep cash out of v1.

### 2.3 `sdk.template` — methods we use

`[docs: https://docs.tossplace.com/reference/plugin-sdk/front/template.html]`

15 `renderXxxPage` methods + 2 non-render methods (`openToast`, `startTimer`):

1. `renderIdlePage` — three `type` variants:
   - `type: "default"` — no additional params
   - `type: "oneButton"` — `button`, `description?`
   - `type: "twoButton"` — `title`, `description?`, `primaryButton`, `secondaryButton`
2. `renderUsePointPage` (params: `points[]`, `summary`, `cta: { cancel, submit }`; `onBack?` IS listed)
3. `renderOrderPage` (params block lists `order { items, discounts, summary }`, `localeCode`, `onClick`; the `renderOrderPage` params block does **not** list `onBack`, so order-page `onBack` support is `[GAP]` and must be real-device/Toss-support verified)
4. `renderOrderResultPage` (params: `type: 'paid'|'cancelled'`, `order`, `cta`)
5. `renderAgreementPage`
6. `renderOnboardingPage`
7. `renderSelectPage`, `renderSelectGridPage`, `renderMultiSelectPage`
8. `renderQRScanPage`
9. `renderResultPage` (see full shape below), `renderInputPage`, `renderSearchPage`, `renderSignPage`

**Verified `onBack` support** (re-checked 2026-04-27 against the live Template API page). `onBack` appears in the Params block of: `renderUsePointPage`, `renderSelectPage`, `renderMultiSelectPage`, `renderQRScanPage`, `renderInputPage`, `renderSignPage`. It does NOT appear in: `openToast`, `renderIdlePage`, **`renderOrderPage`**, `renderOrderResultPage`, `renderAgreementPage`, `renderOnboardingPage`, `renderSelectGridPage`, `renderResultPage`, `renderSearchPage`, `startTimer`. The page has a generic note "상단의 네비바가 있는 템플릿에서 사용할 수 있는 공통 파라미터" — but no explicit list of which templates qualify, so we treat `renderOrderPage.onBack` as `[GAP]`.

**`renderResultPage` verbatim parameter shape:**

```typescript
type Params = ImageResultPage | TextResultPage;

interface ImageResultPage {
  type: "image";
  status: "success" | "error";
  title: string; // required
  description?: string;
  onTimeout: () => void; // required
  buttons?: { label: string; onClick: () => void; closeOnClick?: boolean }[];
  timerMs?: number; // 3000–10000, default 5000
  localeCode?: "ko" | "en";
}

interface TextResultPage {
  type: "text";
  text: string; // required
  title: string;
  description?: string;
  onTimeout: () => void;
  buttons?: { label: string; onClick: () => void; closeOnClick?: boolean }[];
  timerMs?: number;
  localeCode?: "ko" | "en";
}
```

Used for **success** result (per PDF p.13): `type: "image", status: "success", title: "수납 완료"`. The failure path uses `renderOrderResultPage` instead (PDF p.12), because only that template supports the multi-line summary display the failure screen requires.

**`renderOrderPage` order object verbatim shape:**

```typescript
order: {
  items: { label: string; value: number; quantity?: number; options?: [...]; imageUrl?: string }[]
  discounts: { label: string; value: number }[]   // max 3
  summary: {
    totalAmount: number
    discountAmount?: number
    remainingPoint?: number
    paidAmount?: number
    changeAmount?: number
    earned?: { label: string, value: number, suffix: string } | { label: string, value: string }
  }
}
```

`earned` is a **discriminated union**: when `value` is a `number`, `suffix` is REQUIRED; when `value` is a `string`, no suffix.

**`renderOrderResultPage` has a DIFFERENT `summary` shape:**

```typescript
summary: {
  totalAmount: number
  items?: { label: string, value: string, theme: 'blue' | 'red' }[]
}
```

Do NOT pass `renderOrderPage`'s summary shape directly to `renderOrderResultPage` — they are incompatible.

**Points parameter verbatim:** `points: { name: string; amount: number }[]`

### 2.4 Template-only UI rule

`[docs: https://docs.tossplace.com/guide/front-integration/getting-started.html]` states, verbatim: **"네, 프론트 플러그인은 반드시 Template API를 사용해야 합니다"** ("Yes, front plugins must use Template API") for "일관된 UI" and "검수 통과" (consistent UI / passing review). Also: "디자인 검수 시 필수 요구사항".

`[GAP]` The docs do **not** state that `settings.html` or any other page is exempt. The starter's [settings.html](front-plugin-js/settings.html) uses freeform HTML and custom CSS (lines 25–108), which _appears_ to contradict the public rule. We are **not** relying on freeform UI outside settings for v1, and we should confirm the settings exception with Toss before shipping.

### 2.5 `sdk.app`

`[docs: https://docs.tossplace.com/reference/plugin-sdk/front/app.html]`

- `getSerialNumber(): Promise<{ serialNumber: string }>` — **returns an object with a `serialNumber` property, not a bare string**. The plugin destructures this at [home.html:41](front-plugin-js/home.html:41): `const { serialNumber } = await sdk.app.getSerialNumber();`
- `getMerchant(): Promise<{ id, name, businessNumber }>`
- `openSetting(): Promise<void>`
- `setIdle(): Promise<void>` — "첫화면으로 이동합니다"
- `restartOnboarding(): Promise<void>` — "단말기를 로그아웃하고 온보딩 화면으로 이동합니다"
- `isDebugMode(): Promise<Boolean>`

### 2.6 `sdk.storage`

`[docs: https://docs.tossplace.com/reference/plugin-sdk/front/storage.html]`

- `get({ key: string })` → `{ value }` (value is `null` or `string` per the docs example: `// null 또는 string`)
- `set({ key: string, value: string })` → `{ value }`
- `remove({ key: string })`
- `clear()`

`[GAP]` Storage quota, persistence across reinstall, and scope are not documented.

### 2.7 `sdk.webSocket` — NOT what we need

`[docs: https://docs.tossplace.com/reference/plugin-sdk/front/websocket.html]`

This namespace is a **server** (plugin hosts a listening WebSocket server for external clients on a configurable port). Verbatim from the page: "토스 프론트에서 WebSocket 서버를 생성하고 클라이언트와 양방향 통신을 하기 위한 API입니다" — the plugin is the SERVER, not the client.

It is **NOT** the right primitive for plugin → partner-backend communication. For our WS B (plugin ↔ our backend), we use a **standard browser `WebSocket`** to `wss://our-backend/...`, not `sdk.webSocket`.

### 2.8 `sdk.navigation`

`[GAP]` Public docs page returned 403 on repeated fetches (re-confirmed 2026-04-27). Navigation between plugin HTML files is done via plain browser `location.href = ...` — e.g. [index.html:29](front-plugin-js/index.html:29) redirects to `./home.html`, and [home.html:128](front-plugin-js/home.html:128) navigates to `./order.html#<sessionId>`. We use plain browser navigation; no SDK navigation primitive is required.

### 2.9 Undocumented APIs the starter uses (we do NOT use these)

The starter at [payment.html](front-plugin-js/payment.html) uses three methods that are **not** in the current public docs (re-confirmed 2026-04-27 — only `requestPayment, requestBarcodePayment, requestCashPayment, requestPaymentCancel, getPayment, getPaymentCancel` are listed):

- `sdk.payment.getPaymentByKey(paymentKey)` — used at [payment.html:108](front-plugin-js/payment.html:108), [:142](front-plugin-js/payment.html:142). Public docs list only `sdk.payment.getPayment({ paymentKey })`.
- `sdk.payment.getBackupPaymentKey()` — [payment.html:136](front-plugin-js/payment.html:136)
- `sdk.payment.resetBackupPaymentKey()` — [payment.html:117](front-plugin-js/payment.html:117), [:122](front-plugin-js/payment.html:122), [:127](front-plugin-js/payment.html:127), [:151](front-plugin-js/payment.html:151)

Also at [payment.html:108](front-plugin-js/payment.html:108), the starter passes a **bare string** (`getPaymentByKey(paymentKey)`) where the documented `getPayment` takes **`{ paymentKey }`**.

**Our position:** use only documented primitives. See §5 (recovery) for how we replicate the "backup key" semantics with `sdk.storage.set('smartdoctor.pendingPayment', json)` + `getPayment({paymentKey})`.

### 2.10 Other gaps flagged in the docs

- Minimum/maximum amount: `[GAP]` not documented
- Currency: `[GAP]` never stated (assumed KRW)
- Idempotency rules: `[GAP]` not documented for plugin SDK (Toss Payments product docs describe a 15-day idempotency window, but that is a different product)
- Offline behavior on device: `[GAP]` not documented
- Partner integration transports (polling / WebSocket / SSE): `[GAP]` — the test guide at `/guide/front-integration/plugin/test.html` returned 403 on repeated attempts (re-confirmed 2026-04-27)
- Partner-owned data boundaries (order history, cancel history, point balances, customer identity): `[GAP]` no public doc explicitly states these are partner-owned, but they are not part of any SDK API surface we verified, so we treat them as partner-owned.

### 2.11 Deployment & review

`[docs: https://docs.tossplace.com/guide/front-integration/getting-started.html]` states: **"라이브 배포 검수 통과 필수"** ("Live deployment review approval is required"). Per user: deployment & review handling is out of team scope for this spec.

---

## 3. Page architecture

### 3.1 Page inventory

| File            | Role                                                                                                                                                                                                                                                                                                                                                                                                                                           | Key SDK calls                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`    | entry redirect — `location.href = "./home.html"`                                                                                                                                                                                                                                                                                                                                                                                               | (none — plain browser navigation)                                                                                                                               |
| `home.html`     | idle state + WS B connection + dispatcher                                                                                                                                                                                                                                                                                                                                                                                                      | `sdk.template.renderIdlePage`, new `WebSocket(wss://...)`                                                                                                       |
| `order.html`    | order display → points → payment; accepts `sessionId` via URL hash                                                                                                                                                                                                                                                                                                                                                                             | `sdk.template.renderOrderPage`, `sdk.template.renderUsePointPage`, `sdk.payment.requestPayment`, `sdk.payment.getPayment`, `sdk.template.renderOrderResultPage` |
| `payment.html`  | terminal page for both flows — for payment, reached from `order.html` ([order.html:193](front-plugin-js/order.html:193)) via `./payment.html#<sessionId>` and calls `sdk.payment.requestPayment`; for cancel, reached from `home.html` ([home.html:131](front-plugin-js/home.html:131)) via `./payment.html#<refundId>` and calls `sdk.payment.requestPaymentCancel`. Reports `session.result` (payment) or `refund.result` (cancel) over WS B | `sdk.payment.requestPayment`, `sdk.payment.requestPaymentCancel`, `sdk.template.renderResultPage`, `sdk.template.renderOrderResultPage`                         |
| `settings.html` | operator config (baud, store-name toggle, re-auth) — **remains freeform per starter** `[starter: front-plugin-js/settings.html]` but see §2.4 gap                                                                                                                                                                                                                                                                                              |

---

## 4. WebSocket B — Plugin ↔ Backend

This is **our** WebSocket, not Toss's. Plugin connects as a **client** using the standard browser `WebSocket` constructor. (See §2.7 for why we don't use `sdk.webSocket`.)

### 4.1 Connection

**URL:** `wss://<backend>/plugin?serial=<deviceSerialNumber>`

- `<deviceSerialNumber>` is read by the plugin from `sdk.app.getSerialNumber()` and URL-encoded ([home.html:41](front-plugin-js/home.html:41), [home.html:45-49](front-plugin-js/home.html:45)). There is no plugin-side token; see Backend Spec §5 for the trust-model open question.
- **Heartbeat:** Application-level heartbeat (NOT WS protocol ping, which browsers cannot send from JS): client sends `{"type":"ping"}` every 20s. Server responds `{"type":"pong"}`. Three missed pings → backend drops connection.
- On a serial that fails the backend's trust check: backend closes with code `4403`.

### 4.2 Inbound (Backend → Plugin)

#### `device.registered`

Ack for `device.register`.

```json
{ "type": "device.registered", "payload": {} }
```

#### `session.dispatch` (payment)

Tells the plugin to start a payment flow.

```json
{
  "type": "session.dispatch",
  "payload": {
    "kind": "payment",
    "sessionId": "ses_01HXX...",
    "paymentKey": "ses_01HXX...",
    "amount": { "supplyValue": 27273, "tax": 2727, "tip": 0 },
    "orderSnapshot": {
      /* see §2.3 renderOrderPage shape */
    },
    "pointContext": {
      /* see §4.4 */
    },
    "timeoutMs": 60000,
    "excludePaymentTypes": ["CASH"]
  }
}
```

`paymentKey === sessionId` for v1. `excludePaymentTypes: ["CASH"]` is the safe integrated v1 setting because it is the only documented `excludePaymentTypes` value.

#### `session.dispatch` (cancel)

Tells the plugin to run a refund.

```json
{
  "type": "session.dispatch",
  "payload": {
    "kind": "cancel",
    "refundId": "rfd_01HXY...",
    "originalSessionId": "ses_01HXX...",
    "cancelParams": {
      "paymentKey": "ses_01HXX...",
      "paymentMethod": "CARD",
      "tax": 2727,
      "supplyValue": 27273,
      "tip": 0,
      "timestamp": 1761284938000,
      "approvalNumber": "30021105",
      "installment": 0,
      "timeoutMs": 60000,
      "localeCode": "ko"
    }
  }
}
```

For `BARCODE` cancels, `cancelParams` adds `extraData: { vanTransactionManagementId: string }`. For `CASH` cancels with a self-issued receipt add `isSelfIssuance: true`. **Backend will not dispatch a CASH cancel when the original response had `cash.isCashReceipt: false`** — that response lacks `timestamp` and `approvalNumber`, so the cancel cannot be constructed.

#### `session.reconcile`

Triggered when backend suspects an EXPIRED session may actually have succeeded on the device.

```json
{
  "type": "session.reconcile",
  "payload": {
    "sessionId": "ses_01HXX...",
    "paymentKey": "ses_01HXX..."
  }
}
```

**Plugin action:** call `sdk.payment.getPayment({ paymentKey })`. If found, send back via `session.result` with `"late": true` plus `pointUseAmount`, `chargedSupplyValue`, and `chargedTax` from `smartdoctor.pendingPayment` or from the already-persisted backend `session.chargeContext`. If `PAYMENT_NOT_FOUND`, send nothing — backend keeps the session in EXPIRED.

#### `session.abort`

Sent when CRM aborts a DISPATCHED session before the plugin has called `requestPayment`.

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "ses_01HXX...",
    "reason": "ABORTED_BY_CRM"
  }
}
```

**Plugin action:** stop rendering the order/point page and return to idle via `sdk.app.setIdle()`. Do NOT call `requestPayment` even if the user had already clicked through.

#### `error`

```json
{
  "type": "error",
  "payload": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "session.claim on a CANCELED session is not allowed",
    "sessionId": "ses_01HXX..."
  }
}
```

### 4.3 Outbound (Plugin → Backend)

#### `device.register`

First message after connect.

```json
{
  "type": "device.register",
  "payload": {
    "serialNumber": "TF-000123456",
    "sdkVersion": "v0"
  }
}
```

#### `session.claim`

Plugin acknowledges it's about to show the order page.

```json
{
  "type": "session.claim",
  "payload": { "sessionId": "ses_01HXX..." }
}
```

#### `session.chargeContext`

Plugin reports the exact post-point amount context immediately before calling `sdk.payment.requestPayment`. Backend persists this before the Toss UI begins so late recovery still has the fields required by future cancel/refund dispatch.

```json
{
  "type": "session.chargeContext",
  "payload": {
    "sessionId": "ses_01HXX...",
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636
  }
}
```

#### `session.result`

Plugin reports the Toss SDK outcome for a payment session.

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "ses_01HXX...",
    "pointUseAmount": 0,
    "chargedSupplyValue": 27273,
    "chargedTax": 2727,
    "tossResponse": {
      "type": "SUCCESS",
      "response": {
        /* one of the three shapes in §2.2 */
      }
    }
  }
}
```

For late recovery via `session.reconcile`, add `"late": true` to the payload.

#### `refund.result`

```json
{
  "type": "refund.result",
  "payload": {
    "refundId": "rfd_01HXY...",
    "tossResponse": {
      "type": "SUCCESS",
      "response": {
        /* Toss cancel response */
      }
    }
  }
}
```

#### `session.abort` (from plugin side — rare)

Plugin reports that the user backed out of the order/points page **before** `requestPayment` was called.

```json
{
  "type": "session.abort",
  "payload": { "sessionId": "ses_01HXX...", "reason": "USER_BACKED_OUT" }
}
```

#### `heartbeat`

```json
{ "type": "ping", "payload": {} }
```

Every 20s; backend drops stale connections after 3 misses.

### 4.4 `pointContext` shape

Per the 메디캐시 PDF, point _selection_ happens on the Toss device via `renderUsePointPage`. The plugin computes the usable amount and renders the page; backend provides the raw data via `session.dispatch.pointContext`:

```ts
pointContext: {
  availableBalance: number,      // customer's 메디캐시 balance (unit: 캐시)
  minUseAmount: number,          // hospital's min-use threshold (from 캐시닥 for hospital config)
  earnAmount: number,            // amount earned by this payment (for display on renderOrderPage)
  earnLabel: string,             // label for earned display (e.g., "이번 결제 적립")
  earnSuffix: string             // unit suffix (e.g., "캐시")
}
```

**Plugin-side computation** (per PDF p.9): `usableCash = floor(min(availableBalance, treatmentTotal) / 100) * 100`. If `usableCash < minUseAmount`, plugin SKIPS `renderUsePointPage` entirely and goes directly to `renderOrderPage` with zero point use.

---

## 5. Recovery (crash / page reload)

On every plugin page load, the plugin runs:

```js
// absent-key behavior is documented as value=null; treat falsy/missing as "no pending".
const { value: pendingJson } = await sdk.storage.get({
  key: "smartdoctor.pendingPayment",
});
if (pendingJson) {
  const pending = JSON.parse(pendingJson);
  try {
    const result = await sdk.payment.getPayment({
      paymentKey: pending.paymentKey,
    }); // documented API §2.1
    ws.send(
      JSON.stringify({
        type: "session.result",
        payload: {
          sessionId: pending.sessionId,
          pointUseAmount: pending.pointUseAmount,
          chargedSupplyValue: pending.chargedSupplyValue,
          chargedTax: pending.chargedTax,
          tossResponse: result,
          late: true,
        },
      }),
    );
    await sdk.storage.remove({ key: "smartdoctor.pendingPayment" });
  } catch (e) {
    if (e.code === "PAYMENT_NOT_FOUND") {
      // nothing to recover — user aborted or device never approved
      await sdk.storage.remove({ key: "smartdoctor.pendingPayment" });
    }
  }
}
```

Before calling `sdk.payment.requestPayment(...)`, plugin persists the full pending context:

```js
await sdk.storage.set({
  key: "smartdoctor.pendingPayment",
  value: JSON.stringify({
    sessionId,
    paymentKey,
    pointUseAmount,
    chargedSupplyValue,
    chargedTax,
  }),
});
```

It also sends the same charged context to backend (via `session.chargeContext`) before entering the Toss UI, so backend can recover late approvals even if the plugin reloads before posting `session.result`. On successful send of `session.result`, plugin clears the storage entry. This re-implements the "backup payment key" semantics using only documented primitives, with the extra amount fields required for future refunds.

---

## 6. Page implementations

### 6.1 home.html — dispatcher loop

```js
// Per PDF p.8: store name on the device idle screen must equal the hospital name.
// renderIdlePage type "default" does not accept a title param; instead the Toss device displays
// sdk.app.getMerchant().name. The merchant record bound to the device on Toss's partner-portal
// side must match the clinic name; the plugin does not verify it.
sdk.template.renderIdlePage({ type: "default" });
const { serialNumber } = await sdk.app.getSerialNumber();
const ws = new WebSocket(
  `wss://${backend}/plugin?serial=${encodeURIComponent(serialNumber)}`,
);
ws.onopen = () =>
  ws.send(
    JSON.stringify({ type: "device.register", payload: { serialNumber } }),
  );
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "session.dispatch") {
    // Stash the full dispatch payload so order.html can read it without a separate backend fetch
    sessionStorage.setItem("smartdoctor.dispatch", JSON.stringify(msg.payload));
    window.location.href = `./order.html#${msg.payload.sessionId}`;
  }
};
```

### 6.2 order.html — use-point + order-confirm path

`order.html` renders the use-point and order-confirm screens (PDF slides 3 & 4). The actual `requestPayment` call lives in `payment.html` (§6.3); `order.html` only chooses the `pointUse` and hands off via `sessionStorage` + `location.href`.

```js
// 1. sessionId from URL hash. home.html sets `./order.html#<sessionId>` on session.dispatch.
const sessionId = location.hash.slice(1);

// 2. Dispatch payload stashed by home.html (§6.1). Validate kind + sessionId match.
const dispatchJson = sessionStorage.getItem("smartdoctor.dispatch");
const dispatch = dispatchJson ? JSON.parse(dispatchJson) : null;
if (
  !dispatch ||
  dispatch.kind !== "payment" ||
  dispatch.sessionId !== sessionId
) {
  sdk.app.setIdle();
  return;
}

// 3. Open a fresh WS B for session.claim/abort. payment.html will open its own.
const { serialNumber } = await sdk.app.getSerialNumber();
const ws = new WebSocket(
  `wss://${backend}/plugin?serial=${encodeURIComponent(serialNumber)}`,
);
ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: "device.register",
      payload: { serialNumber, sdkVersion: "v0" },
    }),
  );
  // Spec §4.3: plugin acknowledges it's about to show the order page.
  ws.send(JSON.stringify({ type: "session.claim", payload: { sessionId } }));
  // §4.1 heartbeat: 20s ping; backend drops after 3 misses.
};

// 4. Compute usable cash. Spec §4.4 / PDF p.9:
//      usableCash = floor(min(balance, treatmentTotal) / 100) * 100
//    Math.floor (NOT round) — round-down ensures we never offer more than holds after the floor-to-100.
function computeUsableCash(dispatch) {
  const treatmentTotal = dispatch.amount.supplyValue + dispatch.amount.tax;
  const balance = dispatch.pointContext?.availableBalance ?? 0;
  return Math.floor(Math.min(balance, treatmentTotal) / 100) * 100;
}

// 5. Build the renderOrderPage snapshot for a chosen pointUse. Spec §3.4 + PDF slide 4.
//    - pointUse > 0: append "메디캐시 사용" to discounts; bump summary.discountAmount.
//    - Always: set summary.paidAmount = totalAmount − discountAmount.
//    - earned: only set when ALL three pointContext earn fields are present (the discriminated-union
//      shape `value: number requires suffix: string` per §3.4 — partial fields would violate the contract).
function buildOrderSnapshotWithPoints(snapshot, pointUse, pointContext) {
  const baseDiscounts = snapshot.discounts ?? [];
  const baseSummary = snapshot.summary ?? {};
  const baseDiscountAmount = baseSummary.discountAmount ?? 0;
  const discounts =
    pointUse > 0
      ? [...baseDiscounts, { label: "메디캐시 사용", value: pointUse }]
      : baseDiscounts;
  const discountAmount =
    pointUse > 0 ? baseDiscountAmount + pointUse : baseDiscountAmount;
  const hasEarn =
    pointContext &&
    pointContext.earnLabel != null &&
    pointContext.earnAmount != null &&
    pointContext.earnSuffix != null;
  const earned = hasEarn
    ? {
        label: pointContext.earnLabel,
        value: pointContext.earnAmount,
        suffix: pointContext.earnSuffix,
      }
    : baseSummary.earned;
  return {
    ...snapshot,
    discounts,
    summary: {
      ...baseSummary,
      discountAmount,
      paidAmount: baseSummary.totalAmount - discountAmount,
      ...(earned !== undefined ? { earned } : {}),
    },
  };
}

// 6. Hand off to payment.html. Stash chosen pointUse separately so payment.html can read both.
//    Close our WS first — payment.html opens its own.
function showOrderPage(pointUse) {
  const orderForDisplay = buildOrderSnapshotWithPoints(
    dispatch.orderSnapshot,
    pointUse,
    dispatch.pointContext,
  );
  sdk.template.renderOrderPage({
    order: orderForDisplay,
    localeCode: "ko",
    onClick: () => {
      sessionStorage.setItem("smartdoctor.dispatch.pointUse", String(pointUse));
      ws.close();
      location.href = "./payment.html#" + sessionId;
    },
    // Spec §2.3: renderOrderPage's `onBack` is [GAP] — not in the documented Params block.
    // Wire it but abort correctness must NOT depend solely on this callback firing.
    onBack: () => {
      ws.send(
        JSON.stringify({
          type: "session.abort",
          payload: { sessionId, reason: "USER_BACKED_OUT" },
        }),
      );
      ws.close();
      sessionStorage.removeItem("smartdoctor.dispatch");
      sessionStorage.removeItem("smartdoctor.dispatch.pointUse");
      sdk.app.setIdle();
    },
  });
}

// 7. Decide between use-point page and direct order page. Spec §4.4 / PDF p.9:
//    "If 사용 가능 캐시 < minUseAmount, skip renderUsePointPage entirely."
const usableCash = computeUsableCash(dispatch);
const treatmentTotal = dispatch.amount.supplyValue + dispatch.amount.tax;
const minUse = dispatch.pointContext?.minUseAmount ?? 0;

if (usableCash >= minUse && usableCash > 0) {
  sdk.template.renderUsePointPage({
    points: [{ name: "사용 가능한 메디캐시", amount: usableCash }],
    summary: {
      pointUsedAmount: usableCash,
      paymentAmount: treatmentTotal - usableCash,
    },
    cta: {
      // Per PDF slide 3: binary choice, not a slider.
      submit: { onClick: () => showOrderPage(usableCash) }, // 전액 사용
      cancel: { onClick: () => showOrderPage(0) }, // 사용 안 함
    },
  });
} else {
  showOrderPage(0);
}
```

PDF p.10 → renderOrderPage mapping (verified against PDF slide 4):

- 진료 금액 → `order.summary.totalAmount` (treatment total, pre-point)
- 이번 결제 적립 → `order.summary.earned { label, value, suffix }` (from `pointContext.earn*`)
- 메디캐시 사용 → `order.discounts[]` entry, shown as negative value (omitted when `pointUse === 0`)
- 결제할 금액 → `order.summary.paidAmount = totalAmount − pointUse`

The point use itself is NOT part of the Toss transaction's tax math — it is recorded as a separate `PayType=Point` row in the CRM ledger (matching legacy `SimpleReceiptPayType.Point` behavior at [SimpleReceiptContentViewModel.cs:408-414](../../SmartDoctorCrm/SmartDoctorCrm/PresentationLayer/ViewModel/Receipt/SubControls/SimpleReceipt/SimpleReceiptContentViewModel.cs:408)).

### 6.3 payment.html — terminal page (payment + cancel/refund)

`payment.html` is reached two ways: from `order.html` after the [결제하기] click (`./payment.html#<sessionId>` with `kind:"payment"` dispatch), or from `home.html` when backend dispatches a cancel (`./payment.html#<refundId>` with `kind:"cancel"` dispatch — §6.1). It opens its own fresh WS B (the order.html WS was closed before navigation; the home.html dispatcher WS lives in a separate page context), sends `device.register`, and dispatches by `dispatch.kind` to either `runPayment` (PDF slides 5 + 6/7) or `runCancel`.

`payment.html` does NOT send `session.claim` — `order.html` already claimed before the handoff, so the session is `IN_PROGRESS` by the time payment.html runs. Backend treats the new connection as a connection replacement (backend §7.2 routing).

```js
// ── helpers (PDF slide 6 failure summary labels) ────────────────────
function mapTossFailureToKorean(result) {
  if (result.type === "TIMEOUT") return "시간 초과";
  if (result.type === "CANCELED") return "승인 거절";
  // Toss failure-code → Korean mapping is [GAP] — extend after real-device verification.
  return "통신 오류";
}
function mapPaymentMethodToKorean(result) {
  const m = result.response?.paymentMethod;
  if (m === "CARD") return "카드";
  if (m === "BARCODE") return "QR/바코드";
  if (m === "CASH") return "현금";
  return "—";
}

// ── payment flow (dispatch.kind === "payment") ──────────────────────
async function runPayment(ws, dispatch) {
  // 1. pointUse from order.html. Falsy/NaN → 0.
  const pointUse =
    Number(sessionStorage.getItem("smartdoctor.dispatch.pointUse")) || 0;

  // 2. Charged amounts. Spec: tax = floor(charged/11), supplyValue = charged − tax.
  const treatmentTotal = dispatch.amount.supplyValue + dispatch.amount.tax;
  const charged = treatmentTotal - pointUse;
  const tax = Math.floor(charged / 11);
  const supplyValue = charged - tax;

  // 3. session.chargeContext BEFORE requestPayment so backend can recover even if
  //    the plugin reloads mid-Toss-UI. Spec §4.3.
  ws.send(
    JSON.stringify({
      type: "session.chargeContext",
      payload: {
        sessionId: dispatch.sessionId,
        pointUseAmount: pointUse,
        chargedSupplyValue: supplyValue,
        chargedTax: tax,
      },
    }),
  );

  // 4. 100% 메디캐시 coverage branch — when charged === 0, skip requestPayment entirely.
  //    Toss docs only describe non-zero requestPayment examples; behavior at tax=0/supplyValue=0
  //    is undocumented. Plugin sends `session.result` with `tossResponse: null` to signal
  //    a points-only payment (no Toss transaction occurred). [GAP] — two contract impacts,
  //    both tracked as a separate task:
  //      (a) Backend §7.2 currently validates `tossResponse.response.paymentMethod` ∈
  //          {CARD, CASH, BARCODE} and would reject null. Validator must add a points-only
  //          branch.
  //      (b) Frontend §4.3 `session.result` envelope types `tossResponse` as
  //          {type:'SUCCESS'|'CANCELED'|'TIMEOUT', ...} — must widen to `... | null`.
  //    Backend §4.1 schema is already permissive: toss_response_json, toss_payment_method,
  //    toss_approval_number, toss_timestamp are all Nullable: YES, so a points-only row
  //    is storable today — only the validator and envelope schema need to widen.
  if (charged === 0) {
    ws.send(
      JSON.stringify({
        type: "session.result",
        payload: {
          sessionId: dispatch.sessionId,
          pointUseAmount: pointUse,
          chargedSupplyValue: 0,
          chargedTax: 0,
          tossResponse: null,
        },
      }),
    );
    sessionStorage.removeItem("smartdoctor.dispatch");
    sessionStorage.removeItem("smartdoctor.dispatch.pointUse");
    const { name: hospitalName } = await sdk.app.getMerchant();
    ws.close();
    sdk.template.renderResultPage({
      type: "image",
      status: "success",
      title: "수납 완료",
      description: `${hospitalName}에\n 방문해주셔서 감사합니다`,
      timerMs: 5000,
      onTimeout: () => sdk.app.setIdle(),
      buttons: [
        { label: "확인", onClick: () => sdk.app.setIdle(), closeOnClick: true },
      ],
      localeCode: "ko",
    });
    return;
  }

  // 5. Persist pendingPayment BEFORE requestPayment. Spec §5 recovery.
  await sdk.storage.set({
    key: "smartdoctor.pendingPayment",
    value: JSON.stringify({
      sessionId: dispatch.sessionId,
      paymentKey: dispatch.sessionId,
      pointUseAmount: pointUse,
      chargedSupplyValue: supplyValue,
      chargedTax: tax,
    }),
  });

  // 6. Request payment. Cash excluded literally per §7. The SDK returns
  //    {type: "SUCCESS"|"CANCELED"|"TIMEOUT"} — failure is a value, not a throw.
  const result = await sdk.payment.requestPayment({
    paymentKey: dispatch.sessionId,
    tax,
    supplyValue,
    tip: dispatch.amount.tip,
    timeoutMs: dispatch.timeoutMs ?? 60000,
    localeCode: "ko",
    excludePaymentTypes: ["CASH"],
  });

  // 7. Remove pendingPayment AFTER requestPayment resolves; we now have the live result.
  await sdk.storage.remove({ key: "smartdoctor.pendingPayment" });

  // 8. session.result on the live path (no `late: true`).
  ws.send(
    JSON.stringify({
      type: "session.result",
      payload: {
        sessionId: dispatch.sessionId,
        pointUseAmount: pointUse,
        chargedSupplyValue: supplyValue, // post-point; backend persists as toss_charged_supply_value
        chargedTax: tax, // post-point; backend persists as toss_charged_tax
        tossResponse: result,
      },
    }),
  );

  // 9. sessionStorage hygiene.
  sessionStorage.removeItem("smartdoctor.dispatch");
  sessionStorage.removeItem("smartdoctor.dispatch.pointUse");

  // 10. Render terminal screen (PDF slide 6 or 7).
  if (result.type === "SUCCESS") {
    // PDF slide 7: renderResultPage with image+success, hospital-name substitution.
    const { name: hospitalName } = await sdk.app.getMerchant();
    ws.close();
    sdk.template.renderResultPage({
      type: "image",
      status: "success",
      title: "수납 완료",
      description: `${hospitalName}에\n 방문해주셔서 감사합니다`,
      timerMs: 5000,
      onTimeout: () => sdk.app.setIdle(),
      buttons: [
        { label: "확인", onClick: () => sdk.app.setIdle(), closeOnClick: true },
      ],
      localeCode: "ko",
    });
  } else {
    // PDF slide 6: renderOrderResultPage cancelled.
    // [다시 결제하기] re-stashes sessionStorage and re-enters runFreshFlow with a fresh WS.
    ws.close();
    sdk.template.renderOrderResultPage({
      type: "cancelled",
      order: {
        items: dispatch.orderSnapshot.items,
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
        onClick: () => {
          // Re-stash before retry — runFreshFlow reads sessionStorage on boot.
          sessionStorage.setItem(
            "smartdoctor.dispatch",
            JSON.stringify(dispatch),
          );
          sessionStorage.setItem(
            "smartdoctor.dispatch.pointUse",
            String(pointUse),
          );
          runFreshFlow();
        },
      },
    });
  }
}

// ── cancel/refund flow (dispatch.kind === "cancel") ─────────────────
async function runCancel(ws, dispatch) {
  // 1. cancelParams already constructed by backend (§4.2 cancel dispatch). Pass through.
  const result = await sdk.payment.requestPaymentCancel(dispatch.cancelParams);

  // 2. refund.result over WS. Spec §4.3.
  ws.send(
    JSON.stringify({
      type: "refund.result",
      payload: { refundId: dispatch.refundId, tossResponse: result },
    }),
  );

  // 3. Hygiene — clear any stale dispatch state.
  sessionStorage.removeItem("smartdoctor.dispatch");
  sessionStorage.removeItem("smartdoctor.dispatch.pointUse");

  // 4. Render terminal screen.
  if (result.type === "SUCCESS") {
    const { name: hospitalName } = await sdk.app.getMerchant();
    ws.close();
    sdk.template.renderResultPage({
      type: "image",
      status: "success",
      title: "환불 완료",
      description: `${hospitalName}에\n 방문해주셔서 감사합니다`,
      timerMs: 5000,
      onTimeout: () => sdk.app.setIdle(),
      buttons: [
        { label: "확인", onClick: () => sdk.app.setIdle(), closeOnClick: true },
      ],
      localeCode: "ko",
    });
  } else {
    // Failure: cancel-specific labels, NO retry CTA — refund retry is backend-driven.
    const refundAmount =
      (dispatch.cancelParams?.supplyValue ?? 0) +
      (dispatch.cancelParams?.tax ?? 0);
    ws.close();
    sdk.template.renderOrderResultPage({
      type: "cancelled",
      order: {
        items: [], // no order snapshot on the cancel branch
        summary: {
          totalAmount: refundAmount,
          items: [
            {
              label: "환불 사유",
              value: mapTossFailureToKorean(result),
              theme: "red",
            },
            {
              label: "결제 수단",
              value: mapPaymentMethodToKorean(result),
              theme: "blue",
            },
            {
              label: "환불 금액",
              value: `${refundAmount.toLocaleString()}원`,
              theme: "red",
            },
          ],
        },
      },
      cta: { text: "확인", onClick: () => sdk.app.setIdle() },
    });
  }
}
```

All `sdk.*` calls in §6.2 and §6.3 are verified in §2. `location.hash` passing of sessionId / refundId is standard browser navigation (matches the plugin's plain-browser navigation pattern, e.g. [index.html:29](front-plugin-js/index.html:29)).

---

## 7. Cash is verification-gated

Current official docs only document `excludePaymentTypes: ["CASH"]` as the cash-exclusion value. They do **not** document an empty array as "allow cash", and they do **not** document the default. Therefore the safe v1 integrated flow explicitly excludes cash and supports documented non-cash methods only.

Cash can be added only after Toss support or real-device testing answers all of these:

- How does integrated `requestPayment` include cash if `excludePaymentTypes` is omitted or set differently?
- Does integrated cash prompt for phone/business number, or must we collect it and call `requestCashPayment`?
- Can no-receipt cash be cancelled when the documented response omits `timestamp` and `approvalNumber`?

If those answers are not favorable, the cash design must split the flow explicitly: non-cash via `requestPayment({ excludePaymentTypes: ["CASH"] })`, cash via a dedicated verified cash path.

---

## 8. Failure modes (plugin-relevant subset)

| Failure                                                  | Response                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin crashes mid-payment                               | On restart, `sdk.storage` check → `getPayment({paymentKey})` → post `session.result` with `late: true` if cached; else clear storage entry and let backend expire session after `timeoutMs + grace`                                                         |
| Toss returns TIMEOUT                                     | Send `session.result: TIMEOUT` to backend → CRM sees TIMEOUT → no DB write                                                                                                                                                                                  |
| Toss returns CANCELED                                    | Same as TIMEOUT                                                                                                                                                                                                                                             |
| Toss SUCCESS but plugin can't reach backend              | Persist `smartdoctor.pendingPayment`; next connection triggers recovery with charged amount fields (§5)                                                                                                                                                     |
| Operator cancels a session that was mid-flight on device | Not supported in v1 — Toss SDK has no "abort in-flight" API documented `[GAP]`. Backend forwards `session.abort` only for DISPATCHED state (before `requestPayment`); for IN_PROGRESS the abort is rejected server-side and CRM UI must disable the button. |

---

## 9. Testing

- **Integration** (plugin-side): the plugin against the real Toss Front device in a test store. Cover: card success, card cancel, timeout, barcode success (verify `vanTransactionManagementId` is captured), plugin restart mid-flight. Cash-with-receipt and cash-without-receipt are verification-gated blockers, not normal v1 acceptance cases, until §10 cash questions are answered.
- **Mock limitation:** cash-receipt behavior on the device is unknown `[GAP §2.2]` — real-device/Toss-support verification is required before shipping any cash path.

---

## 10. Open questions owned by plugin team

These items are not blockers for this spec but must be resolved during implementation:

1. `[BLOCKER]` **Cash enablement inside `requestPayment`**: docs do not state that `[]` allows cash and do not state the default. Until Toss confirms the supported cash-inclusion parameter, integrated v1 must exclude cash with `excludePaymentTypes: ["CASH"]`. — **Owner: plugin team, verify with Toss support / real device before cash implementation**
2. `[BLOCKER]` **Cash-receipt UX inside `requestPayment`**: does the device prompt for phone/biz number? If no, we cannot use integrated `requestPayment` for cash-with-receipt. — **Owner: plugin team, verify on real device before cash implementation**
3. `[BLOCKER]` **Cash-without-receipt cancellation**: documented `isCashReceipt: false` response lacks `timestamp` and `approvalNumber`, both required by `requestPaymentCancel`. We must either prevent that outcome or get a documented cancel path from Toss. — **Owner: plugin + backend team** (also tracked in CRM and Backend specs)
4. `[GAP]` **Storage quota on Toss device**: undocumented. We rely on `sdk.storage` for one pending-payment context string. Low risk but should be measured. — **Owner: plugin team**
5. `[GAP]` **settings.html freeform exception**: docs say Template API is mandatory; starter uses freeform for settings. Verify with Toss support so we don't fail review. — **Owner: plugin team**
6. `[GAP]` **Undocumented backup-key APIs**: if Toss support confirms `getPaymentByKey`/`getBackupPaymentKey`/`resetBackupPaymentKey` remain supported and preferred, we can simplify §5 recovery. — **Owner: plugin team**
7. `[GAP]` **`renderOrderPage.onBack` support**: docs show `onBack?` on some templates but not in `renderOrderPage`'s Params block. Abort correctness must not depend on this callback firing. — **Owner: plugin team, verify on device**
8. `[GAP]` **`sdk.navigation`**: Public docs page returned 403 on repeated fetches. We rely on plain browser navigation in the meantime. — **Owner: plugin team, retry with Toss partner credentials**
9. `[GAP]` **`merchant.id` wire path**: With the plugin's HTTP onboarding endpoint removed, no message envelope today carries `sdk.app.getMerchant()` to the backend. Natural fit is extending Backend Spec §7.2 `device.register.payload` with `merchant: { id, name, businessNumber }` — the plugin already calls `sdk.app.getMerchant()` for the success result page (§6.3). Coordinate with the trust-model decision (Backend Spec §15 OQ #2). — **Owner: plugin + backend team** (also tracked in Backend and CRM specs)

---

## 11. References

**Toss official docs (all verified 2026-04-24, re-checked 2026-04-27):**

- Payment API: https://docs.tossplace.com/reference/plugin-sdk/front/payment.html
- Template API: https://docs.tossplace.com/reference/plugin-sdk/front/template.html
- App namespace: https://docs.tossplace.com/reference/plugin-sdk/front/app.html
- Storage namespace: https://docs.tossplace.com/reference/plugin-sdk/front/storage.html
- WebSocket namespace: https://docs.tossplace.com/reference/plugin-sdk/front/websocket.html
- Getting Started: https://docs.tossplace.com/guide/front-integration/getting-started.html
- Plugin Intro: https://docs.tossplace.com/guide/front-integration/plugin/intro.html

**Pages that returned 403 and could not be verified (re-confirmed 2026-04-27):**

- https://docs.tossplace.com/reference/plugin-sdk/front/navigation.html
- https://docs.tossplace.com/guide/front-integration/plugin/test.html

**Plugin source files:**

- `front-plugin-js/index.html`, `home.html`, `order.html`, `payment.html`, `settings.html`, `config.js`, `sdk.js` (no `onboarding.html` — the plugin has no login flow)

**Companion specs:**

- [`2026-04-27-crm-integration.md`](2026-04-27-crm-integration.md) — CRM (legacy C#) responsibilities
- [`2026-04-27-backend.md`](2026-04-27-backend.md) — Backend (WS A + WS B server) responsibilities

_End of frontend spec._
