# TRAIGO Worker / Kill Switch QA 체크리스트

## A. 배포 전 (Supabase / 환경변수)
- [ ] `supabase/migrations/kill_switch.sql` 실행 (kill_switch_state, kill_switch_log, telegram_alert_log, worker_heartbeat, worker_lock)
- [ ] Vercel env: EXCHANGE_ENCRYPTION_KEY, SUPABASE_*, TELEGRAM_*, UPSTASH_REDIS_*
- [ ] Railway env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, **EXCHANGE_ENCRYPTION_KEY (Vercel과 동일값)**, TELEGRAM_*, WORKER_ID
- [ ] EXCHANGE_ENCRYPTION_KEY가 Vercel과 Worker에서 **반드시 동일** (다르면 복호화 실패 → 주문 불가)

## B. Worker 기본
- [ ] Railway 배포 후 `worker_heartbeat`에 행 생성됨 (last_seen 갱신)
- [ ] Vercel UI 리스크 패널에 `Worker 정상` 배지 표시
- [ ] Worker 2개 띄우면 1개만 `running`, 나머지 `standby` (main lock)
- [ ] Worker 종료(SIGTERM) 시 heartbeat `stopped` 기록

## C. Kill Switch 발동 (테스트넷에서)
- [ ] 한도 초과 또는 수동 발동 → active=true
- [ ] Cancel All 실행 → 미체결 주문 사라짐
- [ ] D 옵션 ON → Close All → 포지션 0
- [ ] Telegram Money Bot에 critical 알림 도착
- [ ] kill_switch_log에 CANCEL_ALL / CLOSE_ALL 기록

## D. 이중 실행 방지 (lock) — 가장 중요
- [ ] Vercel status 폴링과 Worker가 동시 동작해도 Close All이 **한 번만** 나감
- [ ] `worker_lock`에 `ks:{connId}` 행 — 한쪽이 잡으면 다른쪽 skip
- [ ] lock holder 만료(60s) 후 재탈취 정상

## E. 장애 시나리오 (제미나이 지적 핵심)
- [ ] **Vercel Timeout 중 종료**: Vercel이 Close 중 끊겨도 Worker가 다음 사이클에 이어받아 포지션 0까지 재시도
- [ ] **Binance 30초 지연**: 워커 fetch timeout 30s → 다음 사이클 재시도, 무한루프 없음
- [ ] **Redis 장애**: 알림 throttle 깨져도 Kill Switch/Cancel/Close는 정상 실행 (fail-open)
- [ ] **Telegram 429/실패**: 알림 실패해도 핵심 로직 계속 (try/catch 격리)
- [ ] **Worker 재시작**: 메모리 날아가도 모든 원본은 Supabase 로그에 있음

## F. Telegram Throttling
- [ ] 1초에 동일 Critical 100개 → Telegram 1건만 (쿨다운)
- [ ] 쿨다운 후 동일 이벤트 재발 → "지난 3분간 N회" 요약
- [ ] 동일 Warning 1시간 10회 → Critical 격상
- [ ] Info → telegram_alert_log만, 발송 없음

## G. 안전 가드
- [ ] 출금권한(has_withdrawal) 키는 Worker가 스킵 + 주문 거부
- [ ] Kill Switch active 중 webhook 신규신호 → dropped(200) + Money/System 알림
- [ ] active 중 클라 신규주문 → 차단, Close/TPSL은 허용

## H. 회귀 (기존 기능)
- [ ] 모의(mock) 매매 정상
- [ ] 테스트넷 실주문 정상
- [ ] Ghost Sync 배지/불일치 정상
- [ ] TP/SL·부분청산·전량청산 정상
