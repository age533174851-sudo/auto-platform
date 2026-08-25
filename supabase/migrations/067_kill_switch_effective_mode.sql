-- 067_kill_switch_effective_mode.sql
--
-- **설정값과 이번에 실제로 실행한 것을 구분한다.**
--
-- 무엇이 있었나
-- ─────────────
-- `kill_switch_state.action_mode`에는 **설정값**이 저장됐다. 그런데
-- 사용자가 화면에서 단계를 골라 누르면(`body.level`) 그 순간 실행되는
-- 조합은 다를 수 있다.
--
--   설정 BC → 수동 CLOSE_ALL(ABCD) 실행 → 포지션 일부 남음 → reset
--   → reset은 저장된 BC로 읽어 `expectedClosed = false`
--   → 잔여 판정이 포지션을 세지 않고 CLEAR
--   → **남은 포지션 위에서 신규 진입 잠금이 풀린다**
--
-- 킬스위치에서 가장 위험한 실패는 "안 됐다"가 아니라 "됐다고 말하는
-- 것"이다. 그리고 이건 그 말을 믿고 잠금까지 푸는 경로다.
--
-- 그래서 이번 발동을 만든 조합을 따로 남긴다. 리셋이 성공하면 비운다 —
-- 발동이 끝나면 그 값은 더 이상 이번 것이 아니다.
--
-- 안전한가
-- ────────
-- 칸을 더하기만 한다. 지우지도, 이름을 바꾸지도, 타입을 바꾸지도 않는다.
-- 없어도 코드는 그대로 돈다 — 칸이 없다는 오류가 나면 이 값을 빼고 다시
-- 쓰는 경로가 있고, **읽는 쪽은 값이 없으면 가장 강한 쪽으로 판단한다**
-- (`effectiveModeOf`의 ASSUMED_STRICT). 모르는 것을 느슨하게 읽지 않는다.

ALTER TABLE kill_switch_state ADD COLUMN IF NOT EXISTS effective_action_mode TEXT;

-- 그리고 **그 단계가 끝났는지**도 남긴다.
--
-- 조합만으로는 부족하다. REDUCE_RISK는 'AB', CLOSE_AUTOMATED는 'ABC'라
-- 둘 다 D가 없다. 그래서 잔여 판정이 `expectedClosed=false`가 되어
-- **포지션을 세지 않는다** — 절반 축소가 실패한 채로도 미체결이 0이면
-- 깨끗한 것으로 읽히고 잠금이 풀린다.
--
-- 비어 있으면(칸 없음·쓰기 실패) 읽는 쪽은 '끝났는지 모른다'로 보고
-- 잠금을 풀지 않는다. 모르는 것은 끝난 것이 아니다.
ALTER TABLE kill_switch_state ADD COLUMN IF NOT EXISTS targeted_pending BOOLEAN;

COMMENT ON COLUMN kill_switch_state.targeted_pending IS
  '이번 발동의 포지션 축소·종료가 아직 끝나지 않았는가. true면 리셋을 막습니다. 기록이 없으면(NULL) 끝났다고 단정하지 않습니다';

COMMENT ON COLUMN kill_switch_state.effective_action_mode IS
  '이번 발동을 실제로 만든 조합(예: ABCD). 설정값 action_mode와 다를 수 있습니다 — 화면에서 단계를 골라 누르면 그 조합입니다. 리셋되면 비웁니다. 비어 있으면 읽는 쪽이 가장 강한 쪽으로 판단합니다';
