# 뉴스 파이프라인 정리 단계 거짓 성공 누적 CI (검증 전용 · 병합 금지)

- 기준 main: `38bb82172aa2bb56d0b44f5b10692ab99f33e3bd`.
- 부모 #435: `18882e4fb29a4d6fda7bf47f542df89ca7e94a55` (news/calendar/AI 응답 판정).
- 자식 #466: `179c6690d5e03839225d8530d935be1c01ca2315` (cleanup 표별 오류 판정, 원문 로그 미출력).
- 이 브랜치는 #466 HEAD 그대로 복제해 문서만 추가했다. 기존 #435/#466 브랜치 쓰기 0.
- CI는 `main` 대상 pull_request에서만 자동 실행되므로 검증 전용 Draft를 별도로 만든다.
- 통과 조건: `node --test scripts/news-pipeline-verdict.test.mjs`, `npm test`, `npm run worker:build`, 타입 기준선 초과 0, 프로덕션 빌드, actionlint/검사기, 100X 8 shard + 합산 성공.
- HTTP 200 + ok:true여도 cleanup 테이블 조회/삭제 실패가 포함되면 workflow 실패. 정상 0건은 통과.
- 기본 ai_cache 1일 규칙은 MIN_RETENTION_DAYS 7보다 작아 거부된다. 데이터 보존 정책은 **수정하지 않는다**. 이 경고는 `ok_with_rejected_rules`로 표시.
- 다른 스택 #374/#461/#463/#465와 통합 검증은 별도 필요. NEWS_CRON_SECRET 운영 설정 문제도 이 PR로 해결되지 않는다.
- TESTNET/LIVE 주문, 운영 DB, 배포, 병합, 전략/청산 정책 변경 없음.
