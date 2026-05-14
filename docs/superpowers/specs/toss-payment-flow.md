# Toss Payment Backend Flow

> **⚠️ Partially SUPERSEDED 2026-05-12 for NICE-paired production.** The following sections are obsolete under the NICE-paired contract: §5.5 (`session.proceed`), §9 (timeout-and-reconcile sub-flow for plugin recovery), **§10 (entire plugin-mediated refund flow — refund is out of scope in the NICE-paired contract; uses pre-existing CRM↔NICE mechanism + pre-existing backend 메디캐시 reversal infrastructure)**, the Data Ownership bullets claiming Core owns `session.proceed` dispatch and skip-NICE signaling, the Plugin Data Ownership bullets claiming Toss SDK calls / requestPaymentCancel / getPayment recovery, and the State Summary's `TIMEOUT` terminal state (NICE-paired flow emits `EXPIRED` only). **Source of truth for the NICE-paired flow:** [`2026-05-12-nice-paired-final-flow-design.md`](./2026-05-12-nice-paired-final-flow-design.md) and the three role-specific MDs at [`../payment-flow-with-nice-terminal-{frontend,backend,crm}.md`](../payment-flow-with-nice-terminal-frontend.md). The remainder of this document — Hospital Feign endpoint inventory, base `session.create` / `session.abort` contracts, error frame §11, pointContext auto-enrichment rules — remains authoritative.

이 문서는 Toss Front Plugin 결제 flow에서 CRM, core, hospital, plugin 사이의 API/WebSocket 신호를 정렬한 문서다.

## 전제

- 외부 API 진입점은 core 모듈이다.
- hospital 모듈의 `/internal/toss-payment/**` API는 core Feign 호출 전용 내부 persistence API다.
- CRM과 plugin은 hospital API를 직접 호출하지 않는다.
- Plugin은 CRM과 직접 통신하지 않는다.
- DB table은 hospital DB에 생성한다.
- v1 결제 dispatch는 `excludePaymentTypes: ["CASH"]`로 현금 결제를 제외한다.
- `hospitalId`는 WS token에서 파싱되는 호출 컨텍스트다. `TOSS_PAYMENT_SESSION`에는 저장하지 않는다.
- `organizationId`는 Hospital DB의 `CARE_ORG_ID`로 저장하며, `RCPT_INFO` 조회 key로 사용한다.

## Endpoint Map

### Core Public API

Core HTTP API:

- `POST /toss-payments/sessions`
- `GET /toss-payments/sessions/{sessionId}`
- `GET /toss-payments/sessions/reconcile-targets?deviceSerialNumber=...`
- `GET /toss-payments/sessions/dispatch-targets?deviceSerialNumber=...`
- `PATCH /toss-payments/sessions/{sessionId}/status`
- `PATCH /toss-payments/sessions/{sessionId}/charge-context`
- `PATCH /toss-payments/sessions/{sessionId}/result`
- `POST /toss-payments/sessions/{sessionId}/abort`
- `POST /toss-payments/refunds`
- `PATCH /toss-payments/refunds/{refundId}/result`

Core WebSocket:

- CRM WS A: `wss://<core>/ws/crm?token=<workstationToken>`
- Plugin WS B: `wss://<core>/ws/plugin?serial=<deviceSerialNumber>&token=<coreToken>`

dev 환경의 core host는 `develop.api.core.smartdoctor.systems`다.

### Hospital Internal API

Core만 호출한다.

- `POST /internal/toss-payment/sessions`
- `GET /internal/toss-payment/sessions/{sessionId}`
- `GET /internal/toss-payment/sessions/reconcile-targets?deviceSerialNumber=...`
- `GET /internal/toss-payment/sessions/dispatch-targets?deviceSerialNumber=...`
- `PATCH /internal/toss-payment/sessions/{sessionId}/status`
- `PATCH /internal/toss-payment/sessions/{sessionId}/charge-context`
- `PATCH /internal/toss-payment/sessions/{sessionId}/result`
- `POST /internal/toss-payment/refunds`
- `PATCH /internal/toss-payment/refunds/{refundId}/result`

## 1. Plugin Register

Plugin은 Toss SDK에서 단말 serial을 얻은 뒤 core WS B에 연결한다.

```text
Plugin -> Core WS B
wss://<core>/ws/plugin?serial={deviceSerialNumber}&token={coreToken}
```

Plugin 등록 메시지:

```json
{
  "type": "device.register",
  "payload": {
    "serialNumber": "TF-000123456",
    "sdkVersion": "v0"
  }
}
```

Core 검증:

```text
query serial == payload.serialNumber
```

불일치하면 WS close `4403`.

성공 응답:

```json
{
  "type": "device.registered",
  "payload": {}
}
```

등록 직후 core는 같은 serial에 묶인 세션을 확인한다.

- `CREATED`: 즉시 `session.dispatch` 전송
- `DISPATCHED`, `IN_PROGRESS`, `EXPIRED`: `session.reconcile` 전송

## 2. CRM Starts Payment

권장 flow는 CRM WS A다.

```text
CRM -> Core WS A
wss://<core>/ws/crm?token={workstationToken}
```

CRM 요청:

```json
{
  "type": "session.create",
  "payload": {
    "clientRequestId": "c1r_01HXX",
    "deviceSerialNumber": "TF-000123456",
    "workstationId": "ws_0001",
    "crmOrigin": {
      "hospitalId": "99995",
      "organizationId": "ORG00001",
      "customerNumber": "CUST000123",
      "insuranceSeqNo": 1,
      "clinicSeqNo": 42,
      "reservationSeqNo": null
    },
    "amount": {
      "supplyValue": 27273,
      "tax": 2727,
      "tip": 0
    },
    "pointAccrualTargetAmount": 20000,
    "orderSnapshot": {}
  }
}
```

Core 처리:

```text
Core validate
If payload.pointContext is missing:
  Core -> Hospital Feign GET /payment/medicash/available
  Core -> Hospital Feign GET /payment/customer-info
  Core -> Reservation Platform Feign GET /api/v2/medicash/customer
  Core -> Reservation Platform Feign GET /api/v1/medicash/config
  Core builds pointContext
Core -> Hospital Feign POST /internal/toss-payment/sessions
Hospital DB insert TOSS_PAYMENT_SESSION, STATUS_CD=CREATED
```

`crmOrigin.hospitalId`는 포인트 조회/설정 조회와 core -> hospital Feign 인증 컨텍스트에 사용한다.
`crmOrigin.organizationId`는 `CARE_ORG_ID`로 저장한다.

`pointContext` 자동 보강은 CRM이 필드를 넘기지 않은 경우에만 수행한다. CRM이 명시적으로 넘긴 `pointContext`는 빈 객체 `{}`여도 그대로 저장하고 plugin에 전달한다.

자동 보강 필드:

```json
{
  "availableBalance": 5000,
  "minUseAmount": 1000,
  "earnAmount": 200,
  "earnLabel": "이번 결제 적립",
  "earnSuffix": "캐시"
}
```

계산 기준:

```text
availableBalance = reservation platform medicashAmount
minUseAmount = reservation platform minimumUsableAmount
earnAmount = floor(pointAccrualTargetAmount * accrualRate)
accrualRate = defaultAccuralRate + firstPaymentBonusRate when isFirstAccumulate=true
```

`pointAccrualTargetAmount`는 실제 결제해야 하는 금액과 다를 수 있다. CRM이 비적립 항목, 보장/지원/할인 정책 등을 반영해 적립 대상금액을 별도로 계산해 보내고, core는 이 값을 메디캐시 예상 적립액 계산에만 사용한다.

Core는 계산된 `earnAmount`를 `pointContext.earnAmount`에 저장하고, plugin 주문 화면 표시를 위해 `orderSnapshot.summary.earned.value`에도 같은 값으로 반영한다. `earned.label`은 `"이번 결제 적립"`, `earned.suffix`는 `"캐시"`로 고정한다.

Core 응답:

```json
{
  "type": "session.ack",
  "payload": {
    "clientRequestId": "c1r_01HXX",
    "sessionId": "{sessionId}",
    "status": "CREATED"
  }
}
```

HTTP를 사용할 경우 CRM은 core에만 요청한다.

```text
CRM -> Core HTTP POST /toss-payments/sessions
Core -> Hospital Feign POST /internal/toss-payment/sessions
```

## 3. Core Dispatches Payment To Plugin

Plugin이 online이면 core가 session을 dispatch 상태로 바꾼다.

```text
Core -> Hospital Feign PATCH /internal/toss-payment/sessions/{sessionId}/status
STATUS_CD=DISPATCHED
```

Core -> CRM:

```json
{
  "type": "session.status",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "DISPATCHED"
  }
}
```

Core -> Plugin:

```json
{
  "type": "session.dispatch",
  "payload": {
    "kind": "payment",
    "sessionId": "{sessionId}",
    "paymentKey": "{sessionId}",
    "amount": {
      "supplyValue": 27273,
      "tax": 2727,
      "tip": 0
    },
    "orderSnapshot": {},
    "pointContext": {},
    "timeoutMs": 60000,
    "excludePaymentTypes": ["CASH"]
  }
}
```

Plugin이 offline이면 core는 10초 grace를 둔다. 그 안에 plugin이 등록되면 dispatch한다. 끝까지 없으면:

```text
STATUS_CD=FAILED
FAIL_REASON_CD=DEVICE_OFFLINE
```

Core -> CRM:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "FAILED",
    "failureReason": "DEVICE_OFFLINE"
  }
}
```

## 4. Plugin Claims Session

Plugin이 order/point UI 진입 직전 claim한다.

Plugin -> Core:

```json
{
  "type": "session.claim",
  "payload": {
    "sessionId": "{sessionId}"
  }
}
```

Core 처리:

```text
DISPATCHED -> IN_PROGRESS
Core -> Hospital Feign PATCH /internal/toss-payment/sessions/{sessionId}/status
```

Core -> CRM:

```json
{
  "type": "session.status",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "IN_PROGRESS"
  }
}
```

`IN_PROGRESS` 이후 CRM abort는 거부된다.

## 5. Plugin Saves Charge Context

Plugin은 포인트 사용 여부를 반영한 실제 Toss 결제 금액을 phase 1 종료 직후 (사용자가 메디캐시 사용 옵션을 선택한 직후) core로 보낸다. 이는 Toss SDK 호출 이전 단계로, core가 할인 후 금액을 CRM에 전달해 CRM이 NICE 카드 단말기에 결제 dispatch를 보낼 수 있도록 한다. 자세한 NICE 단말기 flow는 §5.5와 [docs/payment-flow-with-nice-terminal.md](../../payment-flow-with-nice-terminal.md)를 참조한다.

Plugin -> Core:

```json
{
  "type": "session.chargeContext",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636
  }
}
```

Core 처리:

```text
Core validate:
pointUseAmount + chargedSupplyValue + chargedTax + tip
== original supplyValue + original tax + original tip

Core -> Hospital Feign PATCH /internal/toss-payment/sessions/{sessionId}/charge-context
```

Hospital DB 저장:

- `POINT_USE_AMT`
- `TOSS_CHRG_SUPPLY_VAL`
- `TOSS_CHRG_TAX_AMT`

Plugin은 chargeContext 송신 직후 다음 분기로 진입한다.

- **100% 메디캐시 (`chargedSupplyValue === 0 && chargedTax === 0`)**: NICE 단말기를 거치지 않는다. Plugin이 `session.proceed`를 기다리지 않고 곧바로 §6의 `session.result`로 진행한다 (`tossResponse: null`). Core는 zero-charge chargeContext를 보고 CRM에 NICE dispatch를 보내지 말라고 신호한다.
- **부분 메디캐시 또는 메디캐시 미사용 (`chargedSupplyValue + chargedTax > 0`)**: Plugin은 §5.5의 `session.proceed`를 기다린다. Core는 CRM에 할인 후 금액을 전달하고, CRM은 NICE 단말기에 결제 dispatch를 보낸다. NICE가 준비되면 core가 `session.proceed`로 plugin을 깨운다.

## 5.5. Plugin Awaits Proceed

Phase 1과 phase 2 사이의 경계다. CRM이 NICE 카드 단말기에 결제 dispatch를 마치고 NICE가 결제 처리 준비를 마치면 core가 plugin에 `session.proceed`를 송신한다. 이 메시지가 도착한 후에만 plugin이 Toss SDK를 호출한다.

Core -> Plugin:

```json
{
  "type": "session.proceed",
  "payload": {
    "sessionId": "{sessionId}"
  }
}
```

Plugin은 `sessionId`가 현재 진행 중인 session과 일치하는지 검증한 뒤 Toss SDK를 호출한다.

```ts
sdk.payment.requestPayment({
  paymentKey: sessionId,
  supplyValue: chargedSupplyValue,
  tax: chargedTax,
  tip: 0,
  excludePaymentTypes: ['CASH']
})
```

Core가 `session.proceed`를 송신하는 시점:

- Plugin의 `session.chargeContext`를 정상 처리한 뒤
- CRM에 할인 후 금액을 전달하고 CRM이 NICE에 결제 dispatch를 마친 뒤
- NICE가 카드 입력 준비를 마쳤다고 CRM이 core에 통보한 뒤

`session.proceed`가 100% 메디캐시 결제에서는 발생하지 않는다. §5 마지막 문단 참조.

`AWAITING_NICE` 등 별도 sub-state를 둘지 여부는 core 구현자가 결정한다. 현재 `IN_PROGRESS`는 abort 불가이므로, NICE 대기 중 CRM-driven abort를 허용하려면 backend state machine 확장이 필요하다 (자세한 내용은 [docs/payment-flow-with-nice-terminal-backend.md](../../payment-flow-with-nice-terminal-backend.md) §4.4 참조).

**Plugin-side feature gate**: Plugin은 `config.js`의 `AWAITS_PROCEED` flag로 이 동작을 gating한다. `false`이면 plugin은 chargeContext 직후 곧바로 payment.html로 navigate하여 Toss SDK를 호출한다 (legacy flow). Core가 `session.proceed`를 본격 도입한 뒤 plugin 배포 측에서 `true`로 flip한다.

## 6. Plugin Sends Payment Result

Plugin -> Core:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636,
    "tossResponse": {
      "type": "SUCCESS",
      "response": {
        "paymentMethod": "CARD",
        "card": {
          "timestamp": 1761284938000,
          "approvalNumber": "30021105"
        }
      }
    }
  }
}
```

Core 처리:

```text
Extract:
- paymentMethod
- approvalNumber
- timestamp
- barcode vanTransactionManagementId if BARCODE

Persist full tossResponse
IN_PROGRESS -> SUCCEEDED
Core -> Hospital Feign PATCH /internal/toss-payment/sessions/{sessionId}/result
```

결과 저장 시 core는 WS token의 hospitalId로 hospital API token을 발급해 hospital internal API를 호출한다.
hospital은 `@HospitalId` argument resolver로 이 값을 받아 메디캐시 차감 API의 `hospitalId`로 사용한다.
이 값은 session row에 저장하지 않는다.

100% 메디캐시 결제에서는 plugin이 Toss SDK를 호출하지 않고 `tossResponse`를 `null`로 보낸다.
Core는 `pointUseAmount`가 원 결제금액 전체를 커버하고 `chargedSupplyValue=0`, `chargedTax=0`이면 이를 `SUCCEEDED`로 저장한다.
이 경우 Toss 응답, 결제수단, 승인번호, 승인시각은 모두 `null`로 유지한다.

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "pointUseAmount": 30000,
    "chargedSupplyValue": 0,
    "chargedTax": 0,
    "tossResponse": null
  }
}
```

Core -> CRM:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "SUCCEEDED",
    "tossResponse": {
      "type": "SUCCESS",
      "response": {}
    },
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636,
    "amount": {
      "supplyValue": 27273,
      "tax": 2727,
      "tip": 0
    },
    "late": false
  }
}
```

100% 메디캐시 성공이면 CRM으로 내려가는 `tossResponse`도 `null`이다.

Core는 CRM에 위 `session.result`를 보내기 전에 hospital 저장 API를 통해 결제 결과를 확정한다.
`status=SUCCEEDED`이고 `pointUseAmount > 0`이면 hospital은 해당 `TOSS_PAYMENT_SESSION`의 `CARE_ORG_ID`, `CUST_NO`, `INSR_SEQNO`, `MDCL_SEQNO`와 `SEQNO=1`로 `RCPT_INFO`를 찾아 plugin이 보낸 `pointUseAmount`만큼 `RCPT_INFO.DC_AMT`에 가산한다.
메디캐시 차감 API에는 core가 hospital Feign 호출에 사용한 인증 토큰의 hospitalId를 사용하고, `CARE_ORG_ID`는 Hospital DB의 `RCPT_INFO` 조회 key로만 사용한다.
포인트 사용액이 있는데 이 갱신이 실패하면 성공 결과를 CRM에 전달하지 않는다.

## 7. CRM Abort

Abort 허용 상태:

- `CREATED`
- `DISPATCHED`

CRM -> Core:

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "{sessionId}"
  }
}
```

Core 처리:

```text
CREATED/DISPATCHED -> CANCELED
Core -> Hospital Feign PATCH /internal/toss-payment/sessions/{sessionId}/status
```

Core -> CRM:

```json
{
  "type": "session.abort.ack",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "CANCELED"
  }
}
```

이미 plugin에 dispatch된 경우 Core -> Plugin:

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "{sessionId}",
    "reason": "ABORTED_BY_CRM"
  }
}
```

Core -> CRM terminal:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "CANCELED"
  }
}
```

`IN_PROGRESS` abort 요청은 거부한다.

```json
{
  "type": "session.abort.ack",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "REJECTED",
    "reason": "IN_PROGRESS_NOT_ABORTABLE"
  }
}
```

## 8. Plugin Abort

Plugin 사용자가 Toss SDK 호출 전 화면에서 이탈한 경우:

```json
{
  "type": "session.abort",
  "payload": {
    "sessionId": "{sessionId}",
    "reason": "USER_BACKED_OUT"
  }
}
```

Core 처리:

```text
STATUS_CD=CANCELED
Core -> Hospital Feign PATCH /internal/toss-payment/sessions/{sessionId}/status
```

Core -> CRM:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "CANCELED",
    "failureReason": "USER_BACKED_OUT"
  }
}
```

## 9. Timeout And Reconciliation

Plugin claim이 없으면:

```text
DISPATCHED > 30s
-> FAILED / PLUGIN_UNRESPONSIVE
```

Plugin result가 없으면:

```text
IN_PROGRESS > timeoutMs + 30s
-> EXPIRED
```

Core -> CRM:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "EXPIRED",
    "failureReason": "EXPIRED"
  }
}
```

Plugin 재연결 시 Core -> Plugin:

```json
{
  "type": "session.reconcile",
  "payload": {
    "sessionId": "{sessionId}",
    "paymentKey": "{sessionId}"
  }
}
```

Plugin은 같은 물리 단말의 Toss cache에서 조회한다.

```ts
sdk.payment.getPayment({ paymentKey: sessionId })
```

성공하면 Plugin -> Core:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "late": true,
    "pointUseAmount": 1000,
    "chargedSupplyValue": 26364,
    "chargedTax": 2636,
    "tossResponse": {
      "type": "SUCCESS",
      "response": {}
    }
  }
}
```

Core -> Hospital:

```text
PATCH /internal/toss-payment/sessions/{sessionId}/result
STATUS_CD=SUCCEEDED
LATE_YN=Y
```

Core -> CRM:

```json
{
  "type": "session.result",
  "payload": {
    "sessionId": "{sessionId}",
    "status": "SUCCEEDED",
    "late": true
  }
}
```

## 10. Refund

CRM -> Core:

```json
{
  "type": "refund.create",
  "payload": {
    "originalSessionId": "{sessionId}",
    "clientRequestId": "c1r_refund_01HXX"
  }
}
```

Core 처리:

```text
Validate original session status=SUCCEEDED
Validate original session has Toss payment method
Validate no active refund
Core -> Hospital Feign POST /internal/toss-payment/refunds
Build cancelParams from original Toss response and charged amount
```

100% 메디캐시 결제는 Toss 승인 정보가 없으므로 현재 `refund.create`에서 plugin cancel dispatch를 만들 수 없다.
메디캐시 복원/차감 취소 flow는 별도 API/정책이 필요하다.

Core -> Plugin:

```json
{
  "type": "session.dispatch",
  "payload": {
    "kind": "cancel",
    "refundId": "{refundId}",
    "originalSessionId": "{sessionId}",
    "cancelParams": {
      "paymentKey": "{sessionId}",
      "paymentMethod": "CARD",
      "tax": 2636,
      "supplyValue": 26364,
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

Plugin calls:

```ts
sdk.payment.requestPaymentCancel(cancelParams)
```

Plugin -> Core:

```json
{
  "type": "refund.result",
  "payload": {
    "refundId": "{refundId}",
    "tossResponse": {
      "type": "SUCCESS",
      "response": {}
    }
  }
}
```

Core 처리:

```text
Core -> Hospital Feign PATCH /internal/toss-payment/refunds/{refundId}/result
```

Core -> CRM:

```json
{
  "type": "refund.result",
  "payload": {
    "refundId": "{refundId}",
    "originalSessionId": "{sessionId}",
    "status": "SUCCEEDED",
    "tossResponse": {}
  }
}
```

## 11. Error Frames

WebSocket message 처리 중 request validation, invalid state, hospital/reservation upstream 실패, 내부 예외가 발생하면 core는 연결을 1011로 종료하지 않고 `error` frame을 보낸다.

Plugin message에서 `sessionId`를 확인할 수 있으면 plugin WS와 해당 CRM WS 양쪽에 같은 error frame을 보낸다.
CRM message 처리 중 발생한 예외는 CRM WS에 보낸다.

```json
{
  "type": "error",
  "payload": {
    "code": "INVALID_STATE",
    "message": "receipt info not found",
    "sessionId": "{sessionId}"
  }
}
```

현재 code 값:

- `INVALID_REQUEST`: JSON 파싱 실패, 필수 필드 누락, 금액 검증 실패
- `INVALID_STATE`: 상태 전이 오류, 원 session이 환불 가능한 상태가 아님, `RCPT_INFO` 미존재 등
- `UPSTREAM_ERROR`: hospital/reservation 등 Feign upstream 실패
- `INTERNAL_ERROR`: 그 외 예외

## State Summary

Session states:

```text
CREATED
-> DISPATCHED
-> IN_PROGRESS
-> SUCCEEDED | FAILED | CANCELED | TIMEOUT | EXPIRED
```

Refund states:

```text
CREATED
-> DISPATCHED
-> IN_PROGRESS
-> SUCCEEDED | FAILED | TIMEOUT
```

## Data Ownership

Core owns:

- External API and WebSocket contracts
- Session orchestration
- Device routing index
- State transition decisions
- Toss response extraction
- Hospital Feign calls
- WS token authentication context, including hospitalId
- `session.proceed` dispatch to plugin after CRM/NICE handoff (§5.5)
- Skip-NICE signaling to CRM on zero-charge sessions (§5)

Hospital owns:

- `TOSS_PAYMENT_SESSION`
- `TOSS_REFUND_RECORD`
- MSSQL persistence
- Idempotency and active refund storage constraints
- `RCPT_INFO.DC_AMT` update for `pointUseAmount`
- Medicash deduction request using token-derived hospitalId
- `TOSS_PAYMENT_SESSION.POINT_ACCR_TARGET_AMT` stores CRM's original `pointAccrualTargetAmount`
- `TOSS_PAYMENT_SESSION.POINT_CTX_JSON.earnAmount` stores the calculated expected accrual display value

CRM owns:

- Receipt/cardvan data preparation before plugin completion so backend can update `RCPT_INFO.DC_AMT` before `session.result status=SUCCEEDED`
- Optional explicit `pointContext`; omit the field to use server-side Medicash lookup
- Bookkeeping retry when CRM commit fails after backend success

Plugin owns:

- Toss SDK calls
- Order/point UI rendering (custom HTML for the 메디캐시 page; Toss templates for waiting/result)
- Point-use amount selection and `session.chargeContext`
- Phase 1 → phase 2 waiting screen and `session.proceed` consumption
- `requestPayment`
- `requestPaymentCancel`
- `getPayment` recovery
- 100% 메디캐시 skip-NICE detection (sends zero chargeContext without waiting for `session.proceed`)
