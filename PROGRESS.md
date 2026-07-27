# TRAIGO 작업 현황

> 대화가 길어져 컨텍스트가 요약될 수 있으므로 남기는 인수인계 문서.
> 마지막 갱신: 2026-07-28

## 인프라

| 항목 | 상태 |
|---|---|
| Vercel | `auto-platform-zeta.vercel.app` · regions `hnd1`(도쿄) · Hobby 플랜 |
| GitHub | `age533174851-sudo/auto-platform` · main 브랜치 |
| Supabase | ref `sgbysrvvxlluzffmgcho` · 39개 테이블 |
| Railway 워커 | **사용 안 함** — Binance가 IP 지역 차단 (`Service unavailable from a restricted location`) |

**Binance 도달성**: Vercel(hnd1)에서는 선물·현물·테스트넷 모두 정상. Railway만 차단됨.
그래서 청산 감시를 Vercel Cron + GitHub Actions로 옮겼다.

## 아직 안 된 설정 (사용자 작업)

- [ ] `ADMIN_SECRET` — Vercel 환경변수 + GitHub Secret(`EXIT_MONITOR_SECRET`)에 동일 값
      없으면 청산 감시 cron이 401로 실패한다
- [ ] GitHub Secret `EXIT_MONITOR_URL` = `https://auto-platform-zeta.vercel.app`
- [ ] 바이낸스 테스트넷 연결 재등록 (암호화 키가 바뀌어 기존 항목은 못 읽음)
- [ ] 대화 초반 노출된 Supabase/Vercel 토큰 폐기

## 실데이터 검증 결과 (핵심)

09:00 KST 전환 → N분 관찰 → 1회 진입 → 다음 09:00 청산 전략.
Mark Price 1분봉 기준, 비용(수수료 0.08% + 슬리피지 0.03% + 펀딩 0.01%×3) 반영.

| 심볼 | 기간 | MAE 중앙값 | 100배 생존률 | 100배 기대값 |
|---|---|---|---|---|
| BTCUSDT | 90일 | 1.29~1.49% | 18~21% | -77~-82% |
| BTCUSDT | 365일 | 1.28~1.36% | 17~21% | -78~-80% |
| ETHUSDT | 365일 | 1.75~1.98% | 14~18% | -80~-85% |

**결론: 구조적이다.** 기간을 4배로 늘리고 심볼을 바꿔도 동일.
MAE 중앙값이 100배 청산거리(0.5%)의 **2.6~4배**다.
방향을 맞혀도 23시간 30분 보유 중 중간 역행에서 청산된다.

**단, 방향 적중률(41~52%)은 사용자 실력이 아니라 검증 스크립트의 임의 판단 규칙 성적이다.**
(몸통 30% 이상 + 반대꼬리가 몸통보다 짧으면 진입)
MAE 분포는 진입 규칙과 무관하므로 그 결론만 유효하다.

재현: `npm run validate:real` (일반) / `node scripts/validate-09kst.mjs BTCUSDT 365` (09시 전략)

## 다음 단계 (사용자 합의 순서)

- [x] **D** 교차 확인 — BTC 365 + ETH 365 완료
- [ ] **A** 테스트넷 가동 — `ADMIN_SECRET` 설정 후 시작. 하루 1표본씩 누적
- [x] **B** 비상 종료 — `src/lib/engine/positionGuard.ts` 작성 완료, **아직 배선 안 됨**
- [ ] **C** 판단 규칙 개선 후 재측정 — 사용자의 실제 진입 기준을 받아야 함

### B의 남은 작업
`positionGuard.checkPositionGuard()`는 순수 함수로 완성됐고 테스트 12개가 붙어 있다.
아직 `/api/autotrade/exit-monitor`에 연결되지 않았다. 연결 시 필요한 것:
- 거래소에서 포지션·마진타입·미체결주문 조회 → `PositionSnapshot` 구성
- `action === 'CLOSE'`면 reduceOnly 시장가 청산
- `action === 'ALERT'`면 알림만

## 매매 화면 개편 (미착수)

사용자가 요청한 우선순위:
1. 거래소-앱 포지션 자동 대조 ← 나머지가 이것 위에 얹힘. `/api/orders/reconcile` 이미 있음
2. 계좌 위험판 ← `calcLiquidationPrice`, ISOLATED 검사, 킬스위치 재사용
3. 포지션/미체결 통합 관리
4. 실시간 호가·체결 ← 현재 **임의 숫자를 생성해 표시 중**. WebSocket 연결 필요
5. 차트 위 TP·SL 드래그

별도로 09시 전략 전용 화면 7단계 명세도 받아둠 (관찰 패널 · LONG/SHORT 판정판 ·
100배 생존 패널 · 주문 확인 · 포지션 보유 · 09시 교체).

## 감사 지적 처리 현황

| # | 내용 | 상태 |
|---|---|---|
| 1 | 웹훅 connectionId 위조 | ✅ user_id 소유권 검사 추가 (근본 해결은 사용자별 토큰) |
| 2 | ISOLATED 미강제 | ✅ `/fapi/v1/marginType` 호출 추가, 실패 시 주문 중단 |
| 3 | 손절 실패인데 진입 성공 | ✅ 즉시 청산 + ok:false |
| 4 | 워커 lock 중복 주문 | ✅ 락 no-op 제거 · stale 회수 조건 강화 · clientOrderId 멱등 |
| 5 | Expansion 미적용 | ✅ 주문 경로 연결 + 상한 5→100 개방 |
| 6 | TP/SL 수정이 타 주문 취소 | ✅ closePosition=true인 STOP/TP만 선별 취소 |
| 7 | DB 컬럼명 불일치 | ✅ `api_key_enc`(없는 컬럼) → `api_key`/`api_secret_enc` |
| 8 | reconcile 무인증 | ✅ 관리자 JWT 또는 x-admin-secret 요구 |
| 9 | 캘린더 아무나 변조 | ✅ `checkAdminRole`로 관리자 전용 |
| 10 | 전략 중복(10슬롯 vs 하루1회) | ❌ 미처리. `slotManager.ts`는 폐기 표시만 되어 있음 |

추가 발견: `/api/safety`에 하드코딩 관리자 시크릿(`traigo-admin-dev`) → 제거 완료

## 미처리 과제

- Gate 거래소 경로: 마진타입 설정 없음, 손절 부착 없음, `setLeverageGateFutures` 결과 미확인
- `slotManager.ts` 정리 (감사 10번)
- 타입 에러 80건 잔여 (`next.config.js`가 `ignoreBuildErrors: true`로 덮고 있음)
- `middleware.ts`가 `/admin`·`/developer`를 실질적으로 막지 않음
  (세션이 localStorage에 있어 미들웨어가 볼 수 없음. API는 `requireAdmin`으로 보호됨)

## 검증 명령

```bash
npm test          # 유닛 테스트 55개
npm run typecheck # 타입 에러 (현재 80)
npm run build     # 프로덕션 빌드 (104 라우트)
```
