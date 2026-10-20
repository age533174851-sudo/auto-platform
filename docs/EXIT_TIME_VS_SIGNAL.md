# 시간청산 ↔ 신호청산 충돌 분석 (Issue #325 · 4시간 상수)

> 작성 2026-10-14 · 기준 main `f902be8` · **운영 전략 변경 0 · 실주문 0**

## 1. 결론부터

**4시간 상수는 지우면 될 숫자가 아니다.** 지금 Exact100X 포지션과 거래소
강제청산 사이에 있는 **유일한 자동 종료 수단**이다.

사용자 확정 운영 방식(매일 09:00 KST 진입 판단 → 지속 감시 → **실제 청산
신호 발생 시 매도**)과 충돌하는 것은 사실이다. 그러나 해결 순서는
"4시간을 없앤다"가 아니라 **"신호 청산을 먼저 배선하고, 그 뒤 시간청산을
주 종료에서 백스톱으로 내린다"**다.

12시간 연장도 해결이 아니다 — 무보호 노출을 3배로 늘리면서 신호 청산을
추가하지 않는다.

## 2. 추적 결과 (실제 코드)

| 위치 | 사실 |
|---|---|
| `src/lib/strategies/profiles.ts:316` | `MAX_LEV_100X.maxHoldSec = 14400` (4시간) |
| `src/lib/engine/exitAuthority.ts:390` | `if (!(heldMs >= policy.maxHoldMs))` — **여기가 집행한다** |
| `src/lib/engine/managedPosition.ts:286` | `seatExitCapabilities` — 아래 표 |
| `src/lib/engine/holdExtension.ts` | 12시간까지 연장 가능하나 **기본 OFF** (`EXACT100X_HOLD_EXTENSION_APPROVED_AT` 필요) |

`seatExitCapabilities`가 `NO_FIXED_SL_EXACT100X`에 주는 권한:

```
fixedStopAtEntry: false   ← 계약상 안 건다 (NO_FIXED_SL)
breakEven:        false   ← 1R이 없어 정의 불가
trailing:         false
timeExit:         true    ← 유일하게 열린 것
emergency:        false   ← 주석: "아직 구현이 없다. 있다고 적지 않는다"
```

**사용자 요구인 "청산 신호 발생 시 매도"는 Exact100X에 구현돼 있지 않다.**
신호 기반 청산 경로가 권한 표에 없다.

## 3. 강제 청산을 제거하면

| 위험 | 크기 |
|---|---|
| 자동 종료 수단이 **0개**가 된다 | 손절·익절·트레일링·본전이동·긴급 전부 false |
| 거래소 강제청산까지 방치 | 100배 청산 거리 = `100/100 − MMR 0.4%` = **가격 0.6%** |
| 증거금 전액 손실 | 불리한 0.6% 움직임 한 번 |
| 사람의 주의력만 남는다 | 09:00~다음 09:00 사이 24시간 |

ROE로 보면 가격 0.6%는 **ROE 60%**이고, 왕복 수수료 0.1%(ROE 10%)와
펀딩이 그 여유를 더 갉아먹는다.

## 4. 청산 감시가 멈추면

시간청산도 신호청산도 **감시 회차가 돌 때만 집행된다.** 감시가 멈추면
자동 종료는 전부 멈춘다. 그리고 두 가지가 더 있다.

- **진입 쪽**: PR #324가 `blockEntry`를 fail-closed로 뒤집는다. 감시 성공이
  확인되지 않으면 `scalp`·`my-original-v1`·`daily-ladder` 진입이 503으로
  막힌다(배선 확인했다). 방향 찬성 — "닫을 수 없으면 열지 않는다".
- **미해결 종료 쪽**: `exitAuthorityRun`은 `CLOSE_INCOMPLETE`·
  `CLOSE_UNKNOWN_RECONCILE_REQUIRED`에서 `needsReconcile: true`를 준다.
  그런데 그 값은 **HTTP 응답에만 적힌다.** 읽어서 재조회를 걸거나 어딘가에
  남기는 코드가 없다(아래 §6).

## 5. 제안하는 변경 — 테스트 가능한 관문

운영 전략을 바꾸지 않는다. **시간청산을 완화해도 되는지 묻는 자리**를
만들고, 유일한 종료 수단일 때는 어떤 입력에서도 허가하지 않는다.

`src/lib/engine/exitDependency.ts` (import 0 · 순수 판정):

```
judgeTimeExitRelax({ capabilities, monitorVerified })
  → BLOCKED_UNKNOWN              권한을 못 읽음
  → BLOCKED_MONITOR_UNVERIFIED   감시 성공 미확인
  → BLOCKED_ONLY_EXIT_PATH       시간청산이 유일 ← **지금 Exact100X**
  → BLOCKED_NO_SIGNAL_EXIT       신호 청산 미배선
  → ALLOWED                      다른 수단이 남는다
```

시험이 **전수로** 확인한다: 완화가 허가되는 모든 입력 조합에서 시간청산
외 수단이 반드시 1개 이상 남고, 감시 미확인에서는 허가가 나지 않는다
(`완화 ⑥`, 입력 256조합).

그리고 `완화 ②-b`가 **분기가 죽지 않았는지** 확인한다. 처음 구현에서
신호 청산 검사를 먼저 뒀더니 `BLOCKED_ONLY_EXIT_PATH`가 **도달 불가능**
해졌다 — 신호 청산이 켜져야 그 검사에 닿는데, 켜지면 이미 유일이 아니다.
순서를 바꿔 고쳤고 시험이 재발을 막는다.

### 다음 단계 (승인 필요)

1. **신호 청산 정의와 배선** — 반대 신호·모멘텀 둔화·실현 기준 트레일링
   중 무엇을 쓸지는 `STRATEGY_SPEC.md` §1.1대로 **아직 사용자 확정이
   아니다.** 임의로 공식을 정하지 않는다.
2. 배선된 뒤 `signalExit: true`가 되면 이 관문이 완화를 허가한다.
3. 그때 시간청산은 **백스톱**으로 남긴다 — 제거하지 않는다.

## 6. Issue #325 — 네 시나리오는 이미 덮여 있다

중복 시험을 만들지 않았다. 추적표다.

| 시나리오 | 덮는 시험 (등록됨) |
|---|---|
| 부분 체결 | `holdExtensionIntegration` ⑦ · ⑧-g · `orderPathIntegration:300` |
| 결과 불명 / 타임아웃 | `holdExtensionIntegration` ⑦(거래소 응답 실패) · ⑧-f |
| 중복 주문 | `holdExtensionIntegration` ⑥ · ⑨ · `orderPathIntegration:217,745,771,1060,1110` |
| 재시작 복구 | `holdExtensionIntegration` ⑤ · ⑤(상한 초과) · ⑧-g · `orderPathIntegration:353` |

특히 `⑧-g`가 핵심을 고정한다: 부분 체결 뒤 재시작하면 **진입 수량이 아니라
지금 관측한 노출**(0.006)로 닫고, 전송은 1건이다.

### 찾은 공백 — 미해결 종료의 내구성

`needsReconcile: true`가 **응답에만 적힌다.** 복구는 다음 회차의
**재발견**에 암묵적으로 의존한다 — 포지션이 아직 열려 있으므로 다음
회차가 다시 찾는다(`⑧-g`가 그 경로를 고정한다). 거기까지는 동작한다.

문제는 **그 회차가 마지막이었을 때**다. 임차 상실·배포·크래시로 감시가
멈추면 "주문을 보냈고 닫혔는지 모른다"는 사실이 응답 본문과 함께
사라지고, 아무도 그 포지션을 다시 보지 않는다. 킬스위치는 같은 상황에서
`UNPROTECTED_EXPOSURE`를 운영자 알림으로 올리는데, 종료 경로에는 그에
대응하는 것이 없다.

`judgeUnresolvedClose`가 그 상태를 이름 붙인다:

```
needsReconcile=true + 감시 확인  → PENDING_MONITOR_ALIVE  (알림 불필요)
needsReconcile=true + 감시 중단  → OPERATOR_REQUIRED      ← 알려야 한다
needsReconcile 미확인            → UNKNOWN                (해결로 적지 않는다)
```

**아직 알림에 배선하지 않았다.** 배선은 운영 동작 변경이라 승인 사항이고,
이 PR은 판정과 시험까지다.

## 7. 하지 않은 것

- `maxHoldSec` 값을 바꾸지 않았다. `exitAuthority`의 집행 코드를 바꾸지 않았다.
- 고정 TP/SL을 Exact100X에 추가하지 않았다.
- 보유 연장을 켜지 않았다(기본 OFF 유지).
- 알림·라우트·화면을 건드리지 않았다.
- 실주문 0 · 운영 DB 변경 0 · 스케줄 변경 0.
