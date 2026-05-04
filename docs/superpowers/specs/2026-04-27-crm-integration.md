> **Status: Historical / superseded**
>
> This document captures the contract as of 2026-04-27. The deployed canonical
> spec is now `docs/superpowers/specs/toss-payment-flow.md` (updated 2026-04-30
> with §6 100%-medicash + §11 error frames + clinicSeqNo rename). Refer to that
> file for current behavior; this one is kept for context on the design journey.

# SmartDoctorCrm — Toss Front Integration Spec

**Audience:** CRM team (WPF/C#, EF Core + legacy `SQLcrud`).
**Compiled:** 2026-04-27, from `2026-04-24-toss-front-integration-design.md` and `2026-04-24-backend-handoff.md` after the 2026-04-27 doc-correction pass.
**Sister specs:** [`2026-04-27-frontend-plugin.md`](2026-04-27-frontend-plugin.md), [`2026-04-27-backend.md`](2026-04-27-backend.md).

---

## 0. How to read this document

Every factual claim carries a source tag:

- `[docs: <url>]` — verbatim from Toss Place official documentation
- `[crm: <path>:<line>]` — direct read of the SmartDoctorCrm repository
- `[GAP]` — information we explicitly could not retrieve (403, not documented, etc.)
- `[BLOCKER]` — must be resolved before that part can ship

All `[crm:]` line numbers were directly re-read on 2026-04-24. Nothing in §3 below is paraphrased from a subagent report.

---

## 1. Goal

Replace the current **synchronous local VAN/PG device flow** in the SmartDoctorCrm 수납 (payment) pipeline with an **asynchronous, backend-mediated Toss Front plugin flow** — for the 간편수납 (simple receipt) path in v1, preserving today's point-calculation semantics and adding support for the documented Toss non-cash payment methods (card, Samsung Pay, Apple Pay, barcode/Alipay/WeChat). Cash/현금영수증 is **verification-gated** until Toss support or a real-device test proves the required cash-receipt and refund behavior.

The plugin never talks to CRM directly, and CRM never talks to the Toss device directly. Backend is the broker.

---

## 2. Scope

### In scope for v1

- New `TossPaymentSessionService` that opens **WebSocket A** to backend
- New `DoReceiptViaToss()` branch on the 간편수납 commit pipeline
- Writing receipt/`CARDVAN_PAY`/detail-content rows **after** backend confirms `SUCCEEDED`
- Cancel/refund UI triggers — flows through backend, plugin executes, CRM writes mirror negative rows
- Bookkeeping-only retry queue when backend confirms success but CRM write fails
- Schema additions on `RECEIPT_DETAIL_CONTENT` (additive only — see §6)
- New config keys (`TossDeviceSerialNumber`, `UseTossFront`, `TossBackendUrl`)
- UI gating: disable abort while session is `IN_PROGRESS`

### Out of scope for v1

- 일반수납 (common receipt) path — v2
- Partial cancel — `[GAP]` Toss docs do not document partial cancel support
- Retiring NICE/KOCES/Dll32 bridge — kept as fallback toggle (see §10 master switch)
- Migrating CRM off `PaymentHandler` / legacy `SQLcrud` point writes
- Fixing legacy `_approveNumber = "1"` placeholder on the non-integrated path `[crm: ...ReceiptWithSimpleReceiptDataRow.cs:355]`
- Changing `SimpleReceiptPayType` enum
- Changing or unifying the existing `PaymentTerminalBridgeService` / `Dll32Client` machinery
- Adding EF `Database.BeginTransaction()` to the legacy (non-Toss) path
- Unifying 간편수납 and 일반수납 code paths

---

## 3. Verified state of the legacy CRM

All line numbers were directly re-read on 2026-04-24.

### 3.1 Entry point

`ReceiptFormLinker.OpenPopupMenuRcptDtalCntnAmt(custNo, insrSeqno, mdclSeqno, rsvSeqno, …)` `[crm: PresentationLayer/Old/FormLinker/ReceiptFormLinker.cs:81]`. Uses `_receiptWindowPool` (line 94) — **up to 5 `ReceiptView` instances are pooled and reused**; this means UI-instance-based correlation of a pending payment is unsafe.

### 3.2 간편 vs 일반 receipt split

`ReceiptViewModel` chooses between `SimpleReceiptViewModel` and `CommonReceiptViewModel` based on the `UseSimpleReceipt` config key `[crm: BusinessLogicLayer/Config/ConfigUtilKeys.cs:77]`.

### 3.3 간편수납 commit pipeline

`SimpleReceiptContentViewModel.DoReceipt(SimpleReceiptDataRow row)` at `[crm: PresentationLayer/ViewModel/Receipt/SubControls/SimpleReceipt/SimpleReceiptContentViewModel.cs:931]`:

- Splits amount across Insurance/NonInsTax/NonInsNonTax buckets (lines 937–981)
- Optionally prompts for receipt-ID (lines 983–1003)
- Instantiates `new ReceiptWithSimpleReceiptDataRow(context, ...)` at line 1005 and calls `DoReceipt()` on it.

`ReceiptWithSimpleReceiptDataRow.DoReceipt()` at `[crm: PresentationLayer/Old/Receipt/ReceiptWithSimpleReceiptDataRow.cs:76-108]`. Exact sequence:

```
Line 80: InsertReceiptInfo()                    // adds ReceiptInfoEntity to EF context (NOT saved)
Line 81: InsertReceiptDetailInfo()              // adds ReceiptDetailInfoEntity (NOT saved)
Line 83: DoReceiptCard()                        // BLOCKING modal + named-pipe device call
Line 84: await DoReceiptCashReceipt()           // cash receipt device call
Line 86: InsertReceiptDetailContent()           // adds detail-content rows (NOT saved)
Line 87: UpdatePrescriptionReservationContent() // calls facadeContext.Save() --- MID-PIPELINE COMMIT (separate FacadeContext)
Line 89: TryUsePoint()                          // writes POINT_* tables via legacy SQLcrud (separate connection)
Line 93/99: RejectChanges() on catch
Line 102: _context.SaveChanges()                // SINGLE SaveChanges — the ONLY EF transaction commit point
Line 104-107: TrySavePoint, SaveTicket, SendTobecon, BoostreePayments  // post-save, NOT transactional
```

**No `Database.BeginTransaction()` is opened anywhere in this flow.** The only atomicity is the implicit single-`SaveChanges` transaction.

### 3.4 The modal card step

`DoReceiptCard()` at `[crm: PresentationLayer/Old/Receipt/ReceiptWithSimpleReceiptDataRow.cs:292-342]`. Opens `PopupCardApproveView` via `form.ShowDialog()` at line 319 — synchronous WPF modal — passing a shared `CardServiceContext(_context)` so that inner writes (like `CARDVAN_PAY` rows) ride on the same EF context as the outer `SaveChanges`.

On `cardResponse == null` (line 322) it throws `CardApproveFailException`. On success it captures:

- `_payCode = cardResponse.CardAcquireCode` (line 328)
- `_cardName = cardResponse.CardAcquireName` (line 329)
- `_approveNumber = cardResponse.ApproveNumber` (line 330)
- `_cardNumber = cardResponse.CardNumber` (line 331)

Then fires `AutoSendService.Instance.SendPayReceipt(...)` (lines 333–340).

### 3.5 The "비연동" placeholder

`SetCustomCardApproveInfo()` at `[crm: PresentationLayer/Old/Receipt/ReceiptWithSimpleReceiptDataRow.cs:344-357]` runs when `PayType` is Card-family but `!IsCardVan` (i.e., non-integrated / manual card entry). It hardcodes `_approveNumber = "1"` (line 355) and `_cardNumber = string.Empty` (line 356). A sibling exists in the 일반수납 path: `CommonReceiptViewModel.FillCardApproveNumber()` at `[crm: PresentationLayer/ViewModel/Receipt/SubControls/CommonReceipt/CommonReceiptViewModel.cs:1311-1321]` writes `"1", "2", "3"...` sequentially. **Neither placeholder is acceptable for real Toss-approved transactions.** v1 does not change this behavior on the non-integrated path.

### 3.6 일반수납 card path (OUT OF SCOPE for v1)

`CommonReceiptViewModel.CardvanPay(cardDetailViewModel)` at `[crm: PresentationLayer/ViewModel/Receipt/SubControls/CommonReceipt/CommonReceiptViewModel.cs:1258-1309]` — same `PopupCardApproveView.ShowDialog()` pattern but runs _per card detail row_, allowing multiple approvals in one receipt. Commits via legacy `SQLcrud(new CrudRcptInfo())` at `[crm: ...CommonReceiptViewModel.cs:1328]`. **v1 does not change this path.**

### 3.7 Device integration (current)

`CardServiceSupportTransaction.GetCardService()` at `[crm: BusinessLogicLayer/Service/Receipt/Card/CardServiceSupportTransaction.cs:46-62]` branches on `ConfigUtilKeys.CardVanType` (`[crm: BusinessLogicLayer/Config/ConfigUtilKeys.cs:37]`):

- `"NICE"` → `NiceCardVanCardService`
- `"KOCES"` → `KocesCardVanCardService`
- else → `throw new NotImplementedException()`

Device transport: `Dll32Client` at `[crm: BusinessLogicLayer/Dll32Client.cs]`, a static class that:

- Spawns `Dll32Server.exe` if not running (line 36–47)
- Connects via `NamedPipeClientStream(".", "Dll32Pipe", PipeDirection.InOut, …)` (line 63)
- 2000ms connect timeout (line 65)
- Serializes request as `JsonSerializer.Serialize(new { Command, Arguments })` (line 103)
- **No per-request timeout on the `TaskCompletionSource.Task` it awaits** (line 104)
- `SemaphoreSlim(1,1)` ensures one in-flight request at a time (line 22, 94)

### 3.8 Acquirer code churn

`CardServiceSupportTransaction.AddNewCardAcquirer(acquirerName)` at `[crm: BusinessLogicLayer/Service/Receipt/Card/CardServiceSupportTransaction.cs:73-93]` inserts a new `GeneralCodeEntity { UpCode = "R0307", ... }` to the **shared EF context** whenever the VAN returns an unknown acquirer name. Toss returns `acquirerName` and `acquirerCode` — **we must normalize to this existing code table or the table will drift**.

### 3.9 `CARDVAN_PAY` schema (full)

`[crm: EntityLayer/DataAccessObject/Receipt/CardVanPayEntity.cs]`, table `CARDVAN_PAY`, composite PK `(OrganizationId, CustomerNumber, InsuranceSeqNo, MedicalClinicSeqNo, SeqNo)`. Columns:

| Column            | Property              | Toss field mapping (proposed)                                                                                                                            |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREDIT_TYPE`     | `RawCreditType`       | new constant like `"TOSS"`                                                                                                                               |
| `APPOV_NO`        | `ApproveNumber`       | `response.card.approvalNumber` for CARD, `response.barcode.approvalNumber` for BARCODE, `response.cash.cashReceipt.approvalNumber` for CASH with receipt |
| `CARD_NO`         | `CardNumber`          | `response.card.maskedCardNumber` for CARD (BARCODE/CASH have none)                                                                                       |
| `HALBU`           | `InstallmentPayMonth` | `response.card.installment` for CARD, `response.barcode.installment` for BARCODE                                                                         |
| `JUM_NO`          | `FranchiseCode`       | **not provided by Toss** — may need to store merchant id from `sdk.app.getMerchant()` (see §11 OQ #2)                                                    |
| `BAL_CD`          | `IssuerCode`          | `response.card.issuerCode` for CARD, `response.barcode.issuerCode` for BARCODE                                                                           |
| `BAL_NAME`        | `IssuerName`          | `response.card.issuerName` for CARD, `response.barcode.issuerName` for BARCODE                                                                           |
| `CARD_TRACK`      | `CardTrack`           | **not provided by Toss** — leave null                                                                                                                    |
| `MAE_CD`          | `AcquirerCode`        | `response.card.acquirerCode` for CARD, `response.barcode.acquirerCode` for BARCODE                                                                       |
| `MAE_NAME`        | `AcquirerName`        | `response.card.acquirerName` for CARD, `response.barcode.acquirerName` for BARCODE                                                                       |
| `CARD_APROV_DAY`  | `CardApproveDay`      | derive from `response.card.timestamp` for CARD, `response.barcode.timestamp` for BARCODE, `response.cash.cashReceipt.timestamp` for CASH                 |
| `CARD_AMT`        | `CardAmount`          | `supplyValue + tax + tip`                                                                                                                                |
| `MESSAGE`         | `Message`             | leave null or store van name                                                                                                                             |
| `JUN_MUN`         | `Junmun`              | new value `"토스연동"` (see §6)                                                                                                                          |
| `CARD_VAN_TYPE`   | `RawCardVanType`      | new value `"TOSS"`                                                                                                                                       |
| `CAT_ID`          | `CatId`               | `response.card.van` for CARD, `response.barcode.van` for BARCODE, `response.cash.cashReceipt.van` for CASH with receipt                                  |
| `TRADE_DAY`       | `TradeDay`            | derive from `response.card.timestamp` for CARD, `response.barcode.timestamp` for BARCODE, `response.cash.cashReceipt.timestamp` for CASH                 |
| `TAX_AMT`         | `TaxAmount`           | `tax`                                                                                                                                                    |
| `NON_TAX_AMT`     | `NonTaxAmount`        | `supplyValue`                                                                                                                                            |
| `ENTERED_BY_USER` | `RawEnteredByUser`    | `"N"`                                                                                                                                                    |

- Operational verification needed: confirm `CARDVAN_PAY.CARD_NO` column width in live DB can accommodate Toss's 19-char format (e.g., `"9410-**-****-1234"`). If not, plan a schema migration.
- Note: DB column is `APPOV_NO` (5 chars after 'AP'), not `APPROV_NO`. Verified at `CardVanPayEntity.cs:34`. Typo will silently map to a nonexistent column.

### 3.10 SimpleReceiptPayType enum (current)

`[crm: EntityLayer/Receipt/SimpleReceiptPayType.cs]`:

```csharp
public enum SimpleReceiptPayType { CardPg, CardVan, Cash, Bank, Etc, Point }
```

**v1 does not add new enum values**; Toss approvals map to existing `CardVan` for card/Samsung/Apple Pay, `Cash` for cash, and (TBD — see §11 OQ #1) for barcode.

### 3.11 Cancel paths

`CancelReceiptWithSimpleReceiptDataRow.CancelReceipt()` at `[crm: PresentationLayer/Old/Receipt/CancelReceiptWithSimpleReceiptDataRow.cs:77-100]`:

- Line 81: `CancelCardVan()` — opens `PopupCardApproveView` with a `CardCancelRequest`, synchronous modal
- Line 82: `await CancelCashReceipt()`
- Line 83: `CancelCashReceiptRecord()`
- Line 84: `CancelPoint()`
- Line 86–89: update/insert negative-amount mirror rows
- Line 91: `_context.SaveChanges()`

`CancelConnectedReceipt()` at `[crm: ...CancelReceiptWithSimpleReceiptDataRow.cs:102-125]` — **bookkeeping-only** cancel (no device call) used when VAN cancel fails. Flips the original receipt row and writes negative rows.

---

## 4. Architecture overview (CRM perspective)

```
                 ┌──────────────────────┐
                 │   SmartDoctorCrm     │   (WPF client, per workstation)
                 │   ReceiptViewModel   │
                 │   ↓                  │
                 │  TossPaymentSession- │   ◀── new (this spec)
                 │  Service             │
                 └──────────┬───────────┘
                            │ WS A (wss://)
                            ▼
                 ┌──────────────────────┐
                 │   Partner Backend    │  (separate team — see backend spec)
                 │   PaymentSession     │
                 │   state machine      │
                 │   + session store    │
                 └──────────┬───────────┘
                            │ WS B (wss://)
                            ▼
                 ┌──────────────────────┐
                 │   Toss Front Plugin  │  (separate team — see frontend spec)
                 └──────────────────────┘
```

**Key architectural decisions affecting CRM:**

1. **Backend is the source of truth** for session state. CRM cannot infer session state from its own DB until backend confirms via `session.result`.
2. **`paymentKey` = `sessionId`** — backend-generated UUID (v4), opaque to CRM, used as the correlation key for WS A.
3. **CRM writes happen AFTER backend confirms Toss SUCCESS.** The new Toss code path wraps `_context.SaveChanges()` in `_context.Database.BeginTransaction()`. **This transaction covers only `_context` writes (`ReceiptInfo`, `ReceiptDetailInfo`, `CARDVAN_PAY`, `ReceiptDetailContent`). `FacadeContext.Save()` for prescription-tag updates and `PointHandler` writes via legacy `SQLcrud` remain on separate connections and are NOT part of this transaction** — matching today's non-atomic behavior. A crash after `_context` commit but before point/prescription writes leaves the same split-brain state the legacy path has; recovery is via CRM-side bookkeeping retry queue (§9.2).
4. **Seat-to-device binding:** CRM workstation config stores `TossDeviceSerialNumber`. Backend routes `session.create` to the WS B connection that presented that serial (the plugin sends `?serial=<TossDeviceSerialNumber>` on connect — see Backend Spec §7.1). The operator obtains the serial from the Toss device's settings screen / Toss partner portal — there is no plugin-side onboarding handoff.

---

## 5. WebSocket A — CRM ↔ Backend

CRM connects to backend as **client**. One connection per running CRM workstation, authenticated with a workstation token.

### 5.1 Connection

**URL:** `wss://<backend>/crm?token=<workstation_token>`

- `<workstation_token>` is CRM-side — mechanism TBD by CRM auth integration. For v1 assume it comes from an existing CRM auth endpoint not in scope here. Treat as a signed bearer.
- On invalid/expired token: backend closes with code `4401`.
- **Heartbeat:** Application-level heartbeat (NOT WS protocol ping, which browsers cannot send from JS): client sends `{"type":"ping"}` every 20s. Server responds `{"type":"pong"}`. Three missed pings → backend drops connection.

### 5.2 Message envelope

All messages use this envelope:

```json
{ "type": "<message.type>", "payload": { ... } }
```

### 5.3 Outbound (CRM → Backend)

#### `session.create`

CRM starts a new 수납.

```json
{
  "type": "session.create",
  "payload": {
    "clientRequestId": "c1r_01HXX...",
    "deviceSerialNumber": "TF-000123456",
    "workstationId": "ws_0001",
    "crmOrigin": {
      "organizationId": "ORG00001",
      "customerNumber": "CUST000123",
      "insuranceSeqNo": 1,
      "medicalClinicSeqNo": 42,
      "reservationSeqNo": null,
      "customerName": "홍길동"
    },
    "amount": {
      "supplyValue": 27273,
      "tax": 2727,
      "tip": 0
    },
    "orderSnapshot": {
      "items": [
        {
          "label": "진료비 (홍길동)",
          "value": 30000,
          "quantity": 1
        }
      ],
      "discounts": [],
      "summary": {
        "totalAmount": 30000,
        "earned": { "label": "이번 결제 적립", "value": 200, "suffix": "캐시" }
      }
    },
    "pointContext": {
      "availableBalance": 5000,
      "minUseAmount": 1000,
      "earnAmount": 200,
      "earnLabel": "이번 결제 적립",
      "earnSuffix": "캐시"
    }
  }
}
```

**Validation (backend will enforce):**

- `amount.supplyValue + amount.tax + amount.tip` must be a positive integer
- `amount.tip` MUST be `0` in v1. The plugin's 진료 금액 display (PDF p.10) and its usable-cash formula (PDF p.9) both use `supplyValue + tax` as the treatment total; a non-zero tip would diverge these. Reject with `INVALID_REQUEST` if tip ≠ 0.
- `deviceSerialNumber` must satisfy backend's trust check (see Backend Spec §5; until that OQ resolves, treat any serial as acceptable for v1 development)
- `clientRequestId` must be unique per workstation within 5 minutes (idempotency)

`clientRequestId` is a CRM-generated UUID so the CRM can match ack to its request even if the WS is momentarily reconnecting.

#### `session.abort`

CRM-side cancel **before** Toss approval has succeeded (user clicked cancel while backend status is still `CREATED` or `DISPATCHED`).

**The button must be disabled when status is `IN_PROGRESS`** (see §5.4 `session.abort.ack`; backend will reject IN_PROGRESS aborts as defense-in-depth).

```json
{
  "type": "session.abort",
  "payload": { "sessionId": "ses_01HXX..." }
}
```

#### `refund.create`

CRM user clicked 수납취소 on a previously-`SUCCEEDED` session.

```json
{
  "type": "refund.create",
  "payload": {
    "originalSessionId": "ses_01HXX...",
    "clientRequestId": "c1r_01HXY..."
  }
}
```

**Refund time window is not specified by Toss docs.** The 14-day device cache (`getPayment`) bounds only the plugin's ability to RECOVER an unknown result — it does not bound refund eligibility, because backend already stores the full Toss response and re-supplies `timestamp`/`approvalNumber` into `requestPaymentCancel`. Backend will not pre-reject based on age; Toss's own response will surface a denial if the card network rejects.

### 5.4 Inbound (Backend → CRM)

#### `session.ack`

Immediate ack for `session.create`.

```json
{
  "type": "session.ack",
  "payload": {
    "clientRequestId": "c1r_01HXX...",
    "sessionId": "ses_01HXX...",
    "status": "CREATED"
  }
}
```

#### `session.status`

Emitted on every state transition before terminal.

```json
{
  "type": "session.status",
  "payload": { "sessionId": "ses_01HXX...", "status": "DISPATCHED" }
}
```

States CRM will see in order: `CREATED` → `DISPATCHED` → `IN_PROGRESS` → terminal.

#### `session.abort.ack`

Confirms the backend accepted (or rejected) an abort request.

```json
{
  "type": "session.abort.ack",
  "payload": {
    "sessionId": "ses_01HXX...",
    "status": "CANCELED" | "REJECTED" | "ALREADY_TERMINAL",
    "reason"?: string
  }
}
```

If `status: REJECTED`, `reason` will be `IN_PROGRESS_NOT_ABORTABLE` (backend rejected because session was already mid-Toss-call). The CRM UI must prevent this case via §10.5 button gating; the server-side rejection is defense-in-depth.

#### `session.result`

Terminal update. CRM uses this to commit or not commit the receipt.

**SUCCEEDED example:**

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "ses_01HXX...",
    "status": "SUCCEEDED",
    "tossResponse": {
      "type": "SUCCESS",
      "response": {
        "paymentMethod": "CARD",
        "card": {
          "van": "TOSS",
          "timestamp": 1761284938000,
          "approvalNumber": "30021105",
          "acquirerName": "KB국민카드",
          "acquirerCode": "04",
          "issuerName": "KB국민카드",
          "issuerCode": "04",
          "cardType": "CREDIT",
          "balance": 0,
          "installment": 0,
          "maskedCardNumber": "9410-**-****-1234"
        }
      }
    },
    "pointUseAmount": 0,
    "chargedSupplyValue": 27273,
    "chargedTax": 2727,
    "amount": { "supplyValue": 27273, "tax": 2727, "tip": 0 }
  }
}
```

**FAILED example:**

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "ses_01HXX...",
    "status": "FAILED",
    "failureReason": "DEVICE_OFFLINE"
  }
}
```

A late-recovered success (after watchdog `EXPIRED`) carries `"late": true` in the payload — CRM handles via the bookkeeping retry queue (§9.2).

#### `refund.result`

```json
{
  "type": "refund.result",
  "payload": {
    "refundId": "rfd_01HXY...",
    "originalSessionId": "ses_01HXX...",
    "status": "SUCCEEDED",
    "tossResponse": {
      /* Toss cancel response, same shape as requestPayment result */
    }
  }
}
```

### 5.5 Backend `failureReason` codes CRM may receive

| Code                                   | When                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_OFFLINE`                       | No active WS B for the serial at dispatch time                                                                                   |
| `PLUGIN_UNRESPONSIVE`                  | Dispatched but no `session.claim` in time                                                                                        |
| `INVALID_REQUEST`                      | Schema validation failed on inbound message                                                                                      |
| `REFUND_REJECTED_BY_TOSS`              | Toss returned non-SUCCESS on `requestPaymentCancel` — the `tossResponse` carries the specific reason                             |
| `REFUND_NOT_SUPPORTED_CASH_NO_RECEIPT` | Original CASH response had `isCashReceipt: false`, so the documented response lacks cancel-required `timestamp`/`approvalNumber` |
| `ALREADY_REFUNDED`                     | Refund attempt when an active refund exists                                                                                      |
| `INVALID_STATE_TRANSITION`             | e.g. `session.claim` on a terminal session                                                                                       |
| `TOSS_AUTH_FAILED`                     | Only if Toss's own error surfaces in `tossResponse.type` (rare)                                                                  |
| `INTERNAL`                             | Anything else — alert, paging                                                                                                    |

---

## 6. CRM schema additions

**Additive only in v1** to keep blast radius small:

1. `CARDVAN_PAY.JUN_MUN` accepts new value `"토스연동"` (string column, no enum constraint in schema — verified at `[crm: EntityLayer/DataAccessObject/Receipt/CardVanPayEntity.cs:70]`).
2. `CARDVAN_PAY.CARD_VAN_TYPE` accepts new value `"TOSS"`.
3. A **new column** on `RECEIPT_DETAIL_CONTENT` (or a new sidecar table — backend team to decide naming): `TOSS_SESSION_ID` varchar(40) to correlate a row to its backend `PaymentSession`. Without this column, cancel of barcode payments is impossible (see §6 of backend spec for `requestPaymentCancel` field requirements).
4. A **new column** on `RECEIPT_DETAIL_CONTENT`: `TOSS_VAN_TX_MGMT_ID` varchar(64) nullable, required for barcode refunds.
5. A **new column** on `RECEIPT_DETAIL_CONTENT`: `TOSS_PAYMENT_TIMESTAMP` bigint nullable — extracted from Toss's `response.card.timestamp` / `response.barcode.timestamp` / `response.cash.cashReceipt.timestamp` per `paymentMethod`; required for `requestPaymentCancel`.
6. A **new column** on `RECEIPT_DETAIL_CONTENT`: `TOSS_PAYMENT_METHOD` varchar(10) nullable — one of `CARD | CASH | BARCODE` (exact Toss values), required to pass back to `requestPaymentCancel.paymentMethod`.

All additions are nullable; existing rows remain valid.

**Why we need the extra columns:** `requestPaymentCancel` requires `paymentKey, paymentMethod, tax, supplyValue, tip, timestamp, approvalNumber` and (for barcode) `extraData.vanTransactionManagementId`. Without persisting `paymentMethod`, `timestamp`, and `vanTransactionManagementId`, we cannot cancel. `approvalNumber` already fits in `CARDVAN_PAY.APPOV_NO`; the rest are new.

---

## 7. New service: `TossPaymentSessionService`

New class under `BusinessLogicLayer/Service/TossPayment/`. Responsibilities:

- Open and maintain WS A
- `Task<TossPaymentResult> StartSessionAsync(TossPaymentRequest request)` — sends `session.create`, awaits `session.result`, with cancellation support
- Translate `tossResponse` into a C# DTO shaped like the existing `CardResponse` so the downstream write code can reuse fields

---

## 8. New config keys

Add to `[crm: BusinessLogicLayer/Config/ConfigUtilKeys.cs]`:

```csharp
public const string TossDeviceSerialNumber = @"TossDeviceSerialNumber";
public const string UseTossFront = @"UseTossFront";  // boolean master switch
public const string TossBackendUrl = @"TossBackendUrl";
```

Settings UI: add a new tab to the existing reservation/receipt config view parallel to the `UseSimpleReceipt` toggle at `[crm: BusinessLogicLayer/Config/ConfigUtilKeys.cs:77]`.

---

## 9. New code paths

### 9.1 Receipt: `DoReceiptViaToss()`

Target file: `PresentationLayer/Old/Receipt/ReceiptWithSimpleReceiptDataRow.cs` — add `DoReceiptViaToss()` alongside the existing methods. Sequence:

```csharp
public async Task DoReceipt()
{
    if (ShouldUseTossFront())
    {
        await DoReceiptViaToss();
        return;
    }
    // ... existing flow from line 76 ...
}

private async Task DoReceiptViaToss()
{
    var tossRequest = BuildTossRequest();      // amount split from _row, customer info from _info
    // UI shows a pending indicator; cancellation via CancellationToken
    var tossResult = await _tossService.StartSessionAsync(tossRequest);

    if (tossResult.Status != SessionStatus.Succeeded)
        throw new ReceiptFailException(tossResult.FailureReason ?? "토스 결제 실패");

    // NOTE: this transaction covers only _context. UpdatePrescriptionReservationContent() commits FacadeContext separately. TryUsePoint() writes via legacy SQLcrud. Neither is rolled back on outer failure. See §4 decision #3.
    using (var tx = _context.Database.BeginTransaction())   // FIX: add real transaction
    {
        InsertReceiptInfo();
        InsertReceiptDetailInfo();
        InsertTossApprovalIntoCardVanPay(tossResult);        // §3.9 mapping
        InsertReceiptDetailContent(tossResult);              // §6 new columns
        UpdatePrescriptionReservationContent();              // unchanged
        TryUsePoint();                                       // unchanged — still legacy SQLcrud
        _context.SaveChanges();
        tx.Commit();
    }
    TrySavePoint();
    SaveTicket();
    SendTobecon();
    BoostreePayments();
    // Post-success UI updates unchanged: WaitingInfoService, SendPayComplete
}
```

### 9.2 Crash recovery (CRM-side bookkeeping retry)

Per user direction, "bookkeeping only retry" — if backend returns `SUCCEEDED` but the CRM commit transaction fails (DB down, app crashes mid-write), the CRM stores the Toss result locally (queue file + DB table, whichever is cleaner) and a background worker retries the bookkeeping write until success.

**We do not attempt to auto-cancel the Toss approval.** Manual reconciliation is available via the existing `CancelConnectedReceipt` path.

The same queue handles `"late": true` results that arrive after watchdog `EXPIRED` (the late-success case from backend reconciliation).

### 9.3 Cancel: `CancelReceiptViaToss()`

Add `CancelReceiptViaToss()` to `CancelReceiptWithSimpleReceiptDataRow` parallel to `CancelReceipt()` at `[crm: ...CancelReceiptWithSimpleReceiptDataRow.cs:77]`.

- CRM sends `refund.create` over WS A with the `originalSessionId`.
- Backend looks up the original session; if `SUCCEEDED`, backend creates a new refund record and issues a `session.dispatch` of type `cancel` to the plugin carrying the fields required by `requestPaymentCancel`.
- Plugin executes; result flows back through backend; CRM receives `refund.result`.
- On `refund.result.status === "SUCCEEDED"`: write mirror negative rows using existing `CancelReceiptWithSimpleReceiptDataRow` machinery `[crm: PresentationLayer/Old/Receipt/CancelReceiptWithSimpleReceiptDataRow.cs:77-100]`.
- On cancel failure at Toss (`failureReason: REFUND_REJECTED_BY_TOSS` or similar): **bookkeeping-only retry**. CRM falls back to `CancelConnectedReceipt()` at `[crm: ...CancelReceiptWithSimpleReceiptDataRow.cs:102-125]`, setting `ConnectedReceiptCancelFlag = true` on the detail-content rows (existing pattern, no new schema).

---

## 10. Branch points & preserved behaviors

### 10.1 Master switch — branch at the dispatch point

`ReceiptWithSimpleReceiptDataRow.DoReceipt()` at `[crm: ...ReceiptWithSimpleReceiptDataRow.cs:76]` becomes:

```
if (UseTossFront && PayType ∈ {CardPg, CardVan, Cash} && IsCardVan):
    run Toss flow (new code path, described in §9.1)
else:
    run legacy flow (preserved, unchanged)
```

Non-integrated paths (`!IsCardVan`) continue to use `SetCustomCardApproveInfo()` with the existing `_approveNumber = "1"` placeholder `[crm: ...ReceiptWithSimpleReceiptDataRow.cs:355]`. We do **not** change that behavior in v1.

### 10.2 Preserved behaviors (explicitly)

- `AutoSendService.Instance.SendPayReceipt(...)` still fires (same call site pattern as `[crm: ...ReceiptWithSimpleReceiptDataRow.cs:333]`)
- `AutoSendService.Instance.SendPayComplete(...)` still fires from the ViewModel post-save
- `WaitingInfoService.Instance.TransitionToCompleteState(...)` still fires
- Point save/use via `PointHandler` — unchanged. CRM continues to write the point-use row as `PayType = Point` via the existing `PointHandler` path at `[crm: BusinessLogicLayer/PointHandler.cs]`, matching legacy behavior.
- `AddNewCardAcquirer` at `[crm: ...CardServiceSupportTransaction.cs:73]` — we will call this with Toss's `acquirerName` if the code is not already in `GENERAL_CODE` (UpCode `R0307`). This keeps the existing code table from drifting.

### 10.3 Hardware swap protection

Backend cannot reconcile a Toss session across physically different devices (cache is device-local). Therefore the `TossDeviceSerialNumber` config change on CRM side **must be blocked while any non-terminal session is bound to the old serial**. CRM operators must be alerted when replacing a device mid-session.

### 10.4 Multi-device merchant scoping footgun

If CRM ops changes `TossDeviceSerialNumber` mid-flight, the new device can never reconcile the old device's sessions. Enforce at config-change time: block the change while any non-terminal session is bound to the old serial.

### 10.5 Abort UX gating (mid-device)

The Toss SDK has no documented "abort in-flight" API `[GAP]`. The CRM 취소/abort button:

- **Enabled** when backend status is `CREATED` or `DISPATCHED`
- **Disabled** when backend status is `IN_PROGRESS`, replaced with a tooltip: "Cannot cancel — payment in progress on device"
- If Toss ultimately returns SUCCESS while the user wished to abort, the receipt is written normally; user can then use the normal 수납취소 (refund) flow.
- If Toss returns CANCELED or TIMEOUT, no action is needed.
- The previously-proposed auto-refund is **rejected** because a success-then-immediate-refund pattern can trigger card-fraud holds at the issuer.

---

## 11. Failure modes (CRM-relevant subset)

| Failure                                                     | Who detects | Response                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM can't reach backend (WS A down)                         | CRM         | Show retry UI; do not allow 수납 submit                                                                                                                                                                                                                  |
| Backend can't find device (no WS B)                         | Backend     | Immediate `session.result: FAILED (DEVICE_OFFLINE)`                                                                                                                                                                                                      |
| Toss returns TIMEOUT                                        | Plugin      | Send `session.result: TIMEOUT` to backend → CRM sees TIMEOUT → no DB write                                                                                                                                                                               |
| Toss returns CANCELED                                       | Plugin      | Same as TIMEOUT                                                                                                                                                                                                                                          |
| Backend writes SUCCEEDED but CRM write fails                | CRM         | Persist `TossResultPendingApply` queue row; background retry writes bookkeeping rows (see §9.2)                                                                                                                                                          |
| Operator cancels a session that was mid-flight on device    | —           | Not supported in v1 — Toss SDK has no "abort in-flight" API documented `[GAP]`. CRM UI prevents this via §10.5 button gating.                                                                                                                            |
| Operator needs to cancel after 14 days (Toss cache expired) | CRM         | Backend still has the original approval fields and should attempt Toss cancel; if Toss rejects, fall back to `CancelConnectedReceipt()` bookkeeping-only correction. Cache expiry only affects `getPayment` recovery, not documented refund eligibility. |

---

## 12. Cash is verification-gated (CRM impact)

Until Toss support or real-device testing answers the §13 cash blockers, the integrated v1 flow excludes cash via `excludePaymentTypes: ["CASH"]`. CRM impact:

- Backend will not dispatch a CASH payment; the dispatch carries `excludePaymentTypes: ["CASH"]`.
- If a CASH result somehow arrives, backend rejects refund attempts on `cash.isCashReceipt: false` with `REFUND_NOT_SUPPORTED_CASH_NO_RECEIPT` (§5.5 codes). CRM must surface that failure to the operator and route to bookkeeping-only correction.
- CRM-side method picker UI may eventually be needed (CRM operator chooses cash vs non-cash, and CRM tags the dispatch accordingly) — gated on cash-blocker resolution.

---

## 13. Testing strategy

- **Unit:** `TossPaymentSessionService` mocked against a fake WS A; session state transitions; DTO mapping (§3.9).
- **Integration (CRM-side):** run CRM against a mock backend that impersonates both WS A responses and device-routing behavior. Verify `ReceiptWithSimpleReceiptDataRow.DoReceiptViaToss()` commits the right rows, no partial writes on failure, and preserves points/notifications.
- **End-to-end:** CRM → backend → real Toss device. Cover a full 수납 and a full 취소.

---

## 14. Open questions owned by CRM team

1. `[GAP]` **Barcode (Alipay/WeChat) PayType mapping**: current `SimpleReceiptPayType` has no good fit (`Etc` is closest). — **Owner: CRM team, decide mapping before schema migration lands**
2. `[GAP]` **Merchant/franchise ID mapping**: Toss `sdk.app.getMerchant()` returns `{id, name, businessNumber}`. Which maps to `CARDVAN_PAY.JUM_NO`? — **Owner: backend + CRM, verify on onboarding** (also tracked in Backend spec)
3. **Failure between backend SUCCEEDED and CRM write**: exact queue mechanism (file? table? how retried?) — decided in implementation plan, not here.
4. **Multi-seat multi-device numbering**: for a clinic with 3 counters, confirm that each workstation's config points to a distinct device serial. — **Owner: deployment/operations**
5. **Point use vs. tax/supplyValue split** — **RESOLVED.** Per the 메디캐시 PDF (2026-03-16, p.10): `결제할 금액 = 진료금액 - 메디캐시 사용 금액`. Tax split follows Toss's recommendation: `tax = Math.floor(charged/11)`, `supplyValue = charged − tax`. Point use is recorded in CRM as a separate `PayType = Point` ledger row (matching legacy behavior at [SimpleReceiptContentViewModel.cs:408-414](../../SmartDoctorCrm/SmartDoctorCrm/PresentationLayer/ViewModel/Receipt/SubControls/SimpleReceipt/SimpleReceiptContentViewModel.cs:408)); it does not interact with the Toss transaction's tax math. Implemented in plugin §6.2 (frontend spec).
6. `[BLOCKER]` **Cash-without-receipt cancellation**: documented `isCashReceipt: false` response lacks `timestamp` and `approvalNumber`, both required by `requestPaymentCancel`. We must either prevent that outcome or get a documented cancel path from Toss. — **Owner: plugin + backend team** (CRM impacted because it owns the operator-facing 수납취소 button)
7. **`session.abort` mid-device** — **RESOLVED in this spec.** CRM-side UI disables the 취소/abort button while backend status is `IN_PROGRESS`, replacing the button with a tooltip 'Cannot cancel — payment in progress on device'. See §10.5.
8. `[GAP]` **`merchant.id` wire path** (cross-team): With the plugin's HTTP onboarding endpoint removed, no message envelope in WS A or WS B carries `sdk.app.getMerchant().id` from plugin to backend (or onward to CRM). Natural fit is extending Backend Spec §7.2 `device.register.payload` with `merchant: { id, name, businessNumber }`. This OQ is about _where the value comes from on the wire_; OQ #2 above is about _which Toss merchant field maps to `CARDVAN_PAY.JUM_NO`_ — both must be answered for CRM to write the right value to its existing schema. — **Owner: backend + plugin team** (also tracked in Backend and Frontend specs)

---

## 15. References

**Toss official docs (all verified 2026-04-24, re-checked 2026-04-27):**

- Payment API: https://docs.tossplace.com/reference/plugin-sdk/front/payment.html
- Template API: https://docs.tossplace.com/reference/plugin-sdk/front/template.html
- App namespace: https://docs.tossplace.com/reference/plugin-sdk/front/app.html
- Storage namespace: https://docs.tossplace.com/reference/plugin-sdk/front/storage.html
- WebSocket namespace: https://docs.tossplace.com/reference/plugin-sdk/front/websocket.html
- Getting Started: https://docs.tossplace.com/guide/front-integration/getting-started.html

**Legacy CRM source files referenced in this spec (all directly re-read 2026-04-24):**

- `PresentationLayer/Old/FormLinker/ReceiptFormLinker.cs:81`
- `PresentationLayer/Old/Receipt/ReceiptWithSimpleReceiptDataRow.cs:76, 80–108, 292, 355`
- `PresentationLayer/Old/Receipt/CancelReceiptWithSimpleReceiptDataRow.cs:77, 102`
- `PresentationLayer/ViewModel/Receipt/SubControls/SimpleReceipt/SimpleReceiptContentViewModel.cs:931, 1005`
- `PresentationLayer/ViewModel/Receipt/SubControls/CommonReceipt/CommonReceiptViewModel.cs:1258, 1311, 1328`
- `BusinessLogicLayer/Service/Receipt/Card/CardServiceSupportTransaction.cs:46, 73`
- `BusinessLogicLayer/Dll32Client.cs:22, 63, 89–104`
- `BusinessLogicLayer/Config/ConfigUtilKeys.cs:9, 37, 40, 77, 78, 193`
- `EntityLayer/Receipt/SimpleReceiptPayType.cs:3–11`
- `EntityLayer/DataAccessObject/Receipt/CardVanPayEntity.cs:1–114`

**Companion specs:**

- [`2026-04-27-frontend-plugin.md`](2026-04-27-frontend-plugin.md) — Plugin (web) responsibilities
- [`2026-04-27-backend.md`](2026-04-27-backend.md) — Backend (WS A + WS B server) responsibilities

_End of CRM integration spec._
