// scripts/lib/council-outcome.mjs
//
// **아무 의견도 못 남긴 회차를 success로 적지 않는다.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// `ai-issue-council.mjs`는 등록된 제공자마다 R1·R2를 호출하고 댓글을
// 남긴다. 그런데 호출이 실패하면:
//
//   · R1 오류 → `skipped` 배열에 담긴다. 그 배열은 **R2 댓글의 각주로만**
//     나간다. R2까지 전부 실패하면 그 각주는 어디에도 안 실린다
//   · R2 오류 → `console.log` 한 줄. 이슈에는 아무것도 안 남는다
//   · 그리고 `main()`이 정상 반환하므로 **종료코드 0 = 워크플로 success**
//
// 2026-11-24 06:16 예약 실행이 그 모양이었다: job은 `success`인데
// 이슈 댓글 0건, 로그에 HTTP 404 둘(등록된 두 모델 ID가 죽어 있다).
// **"AI 셋이 검토했다"는 초록이 켜지는데 아무도 검토하지 않았다.**
//
// 이 저장소가 가장 경계하는 모양이다 — 못 한 것을 했다고 적는 것.
// 그래서 판정을 여기 한곳에 두고 시험을 붙인다.
//
// 무엇을 고치지 않는가
// ────────────────────
// 모델 ID·API 키는 건드리지 않는다. 그건 설정이고 소유자 결정이다.
// 여기서 하는 일은 **실패를 보이게 만드는 것**뿐이다.

/**
 * 이번 회차가 실제로 일을 했는가.
 *
 * @param {object} i
 * @param {number} i.posted         이슈에 실제로 남긴 댓글 수
 * @param {string[]} [i.r1Errors]   R1 호출 오류 (가려진 메시지)
 * @param {string[]} [i.r2Errors]   R2 호출 오류 (가려진 메시지)
 * @param {string[]} [i.keyless]    키가 없어 건너뛴 제공자 id
 * @returns {{ok: boolean, exitCode: 0|1, summary: string}}
 */
export function councilOutcome(i) {
  const posted = Math.max(0, Math.floor(Number(i?.posted) || 0));
  const r1 = Array.isArray(i?.r1Errors) ? i.r1Errors : [];
  const r2 = Array.isArray(i?.r2Errors) ? i.r2Errors : [];
  const keyless = Array.isArray(i?.keyless) ? i.keyless : [];

  const parts = [`남긴 댓글 ${posted}건`];
  if (r1.length) parts.push(`R1 오류 ${r1.length}건`);
  if (r2.length) parts.push(`R2 오류 ${r2.length}건`);
  if (keyless.length) parts.push(`키 미등록 ${keyless.length}건 (${keyless.join(", ")})`);

  if (posted > 0) {
    // 일부 실패는 성공이 아니지만 회차가 아예 헛돈 것도 아니다.
    // 남긴 댓글이 있으면 그 댓글 안에 오류 기록이 실린다.
    return { ok: true, exitCode: 0, summary: parts.join(" · ") };
  }

  const why = (r1.length || r2.length)
    ? "호출이 전부 실패했습니다"
    : "호출은 끝났으나 쓸 내용이 0이었습니다";
  return {
    ok: false,
    exitCode: 1,
    summary: `${parts.join(" · ")} — ${why}. 이 회차는 아무 의견도 남기지 못했습니다`,
  };
}
