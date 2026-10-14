// src/lib/intel/personaCanon.ts
//
// **인물·기관·채널 발언 분석의 판정 정본.** 수집하지 않고, 판단만 한다.
//
// 이 파일이 막으려는 네 가지 거짓
// ──────────────────────────────
//   ① **확인하지 않은 계정을 공식으로 적는 것.** 동명이인과 사칭이
//      실제로 있다. 이름이 같다는 것은 증거가 아니다.
//   ② **인기를 정확도로 적는 것.** 구독자 수는 예측이 맞았다는 증거가
//      아니다. 두 숫자를 같은 칸에 쓰면 사람이 섞어 읽는다.
//   ③ **발언 뒤 가격이 올랐다는 사실을 "그 발언 때문"으로 적는 것.**
//      이 파일은 인과를 주장할 수 없고, 주장하지 않는다는 것을
//      출력에 명시한다.
//   ④ **판정할 수 없는 발언을 틀렸다고 적는 것.** 자산·방향·기간 중
//      하나라도 없거나 가격 자료가 구간을 못 덮으면 `UNRESOLVED`다.
//      적중률의 분모에 넣지 않는다.
//
// ★ 이 파일은 **import이 0개**다. 네트워크·DB·거래소를 모른다.
//   수집기는 이 파일을 쓰고, 이 파일은 수집기를 모른다.
//
// ★ 이 파일은 **매매 신호를 만들지 않는다.** 만들 수단이 타입에 없다.
//   누군가의 발언을 주문으로 바꾸는 경로는 별도 승인 사항이다.

// ══════════════════════════════════════════════════════════
// ① 주체 — 사람 · 조직 · 채널을 섞지 않는다
// ══════════════════════════════════════════════════════════
//
//   한 사람이 여러 채널을 갖고, 한 채널에 여러 사람이 나오고, 기관의
//   공식 발표는 개인 의견과 다르게 다뤄야 한다. 셋을 한 표에 넣으면
//   "이 발언의 주체가 누구인가"를 영영 못 적는다.

export type SubjectKind =
  /** 개인 (방송인·애널리스트·CEO·학자·중앙은행 관계자 등) */
  | 'PERSON'
  /** 조직 (증권사·운용사·리서치·규제기관·거래소·기업) */
  | 'ORGANIZATION'
  /** 채널·매체 (유튜브 채널·팟캐스트·뉴스 매체·공식 계정) */
  | 'CHANNEL';

/**
 * 영향력 분류. **예측 정확도와 무관하다.**
 *
 * 이 칸은 "왜 이 사람을 추적하는가"를 적는 자리이고, "이 사람이
 * 맞히는가"는 ③의 통계가 따로 답한다.
 */
export type InfluenceCategory =
  | 'RETAIL_BROADCASTER'     // 트레이딩 방송인·BJ·스트리머
  | 'ECONOMY_COMMENTATOR'    // 경제 해설자·유튜버·팟캐스터
  | 'JOURNALIST'             // 기자·방송 진행자
  | 'SELL_SIDE_ANALYST'      // 증권사·은행 애널리스트
  | 'BUY_SIDE_INVESTOR'      // 운용사·헤지펀드·VC·기관 투자자
  | 'CORPORATE_INSIDER'      // CEO·CFO·임원
  | 'POLICY_MAKER'           // 중앙은행·규제기관
  | 'ACADEMIC'               // 학자·경제학자
  | 'CRYPTO_INDUSTRY'        // 암호화폐 업계
  | 'INSTITUTION_OFFICIAL'   // 기관·매체의 공식 채널
  | 'OTHER';

export interface SubjectRef {
  /** 내부 식별자. 표시 이름이 아니다 — 이름은 바뀌고 겹친다 */
  subjectId: string;
  kind: SubjectKind;
  category: InfluenceCategory;
}

// ══════════════════════════════════════════════════════════
// ② 계정·출처 검증 — 이름이 같다는 것은 증거가 아니다
// ══════════════════════════════════════════════════════════

export type AccountVerdict =
  /** 플랫폼 인증 배지 또는 본인·소속이 공개적으로 상호 링크됨 */
  | 'OFFICIAL_CONFIRMED'
  /** 공개 정보로 연결은 되지만 상호 확인이 없다 */
  | 'CLAIMED_UNCONFIRMED'
  /** 사칭 신호가 있다 */
  | 'SUSPECTED_IMPERSONATION'
  /** 이미 등록된 다른 계정과 같은 주체로 보인다 */
  | 'DUPLICATE_OF_KNOWN'
  /** 판단할 재료가 없다. **공식으로 추정하지 않는다** */
  | 'UNVERIFIED';

export interface AccountEvidence {
  /** 플랫폼이 준 인증 표시. 없으면 null (false와 다르다) */
  platformVerified?: boolean | null;
  /**
   * 주체의 **다른 확인된 출처**가 이 계정을 가리키는가.
   * 예: 공식 홈페이지가 유튜브 채널을 링크
   */
  linkedFromConfirmedSource?: boolean | null;
  /** 이 계정이 가리키는, 이미 확인된 주체의 출처 */
  linksToConfirmedSource?: boolean | null;
  /** 사칭 신호 (아래 ②-b) */
  impersonationSignals?: readonly ImpersonationSignal[] | null;
  /** 같은 주체로 이미 등록된 계정 id. 있으면 중복 후보 */
  duplicateOfAccountId?: string | null;
}

export type ImpersonationSignal =
  | 'NAME_LOOKALIKE'         // 표기만 비슷한 이름 (0/O, 공백, 유사 문자)
  | 'NO_CROSS_REFERENCE'     // 확인된 출처 어디서도 이 계정을 가리키지 않는다
  | 'RECENTLY_CREATED'       // 계정 생성이 매우 최근
  | 'CONTACT_SOLICITATION'   // 개인 연락·투자 유도
  | 'PAYMENT_SOLICITATION';  // 입금·리딩방 유도

export interface AccountJudgement {
  verdict: AccountVerdict;
  /** 수집해도 되는가. **UNVERIFIED·사칭은 수집 대상이 아니다** */
  collectible: boolean;
  /** 발언을 그 주체의 것으로 적어도 되는가 */
  attributable: boolean;
  reason: string;
}

/**
 * 이 계정을 그 주체의 공식 계정으로 볼 수 있는가.
 *
 * 순서가 의미를 가진다 — 사칭 신호를 먼저 본다. 인증 배지가 있어도
 * 사칭 신호가 있으면 사람이 봐야 한다.
 */
export function judgeAccount(
  e: AccountEvidence | null | undefined,
): AccountJudgement {
  const signals = Array.isArray(e?.impersonationSignals) ? e!.impersonationSignals! : [];

  // 입금·연락 유도는 단독으로도 멈출 사유다.
  const hardSignal = signals.includes('PAYMENT_SOLICITATION')
    || signals.includes('CONTACT_SOLICITATION');
  if (hardSignal || signals.length >= 2) {
    return {
      verdict: 'SUSPECTED_IMPERSONATION', collectible: false, attributable: false,
      reason: `사칭 신호 ${signals.length}건 — 사람이 확인하기 전에는 수집하지 않습니다`,
    };
  }

  const dup = String(e?.duplicateOfAccountId ?? '').trim();
  if (dup) {
    return {
      verdict: 'DUPLICATE_OF_KNOWN', collectible: false, attributable: false,
      reason: '이미 등록된 계정과 같은 주체로 보입니다 — 통계가 두 번 세집니다',
    };
  }

  // **상호 확인**이 있어야 공식이다. 한쪽 방향만으로는 부족하다.
  const bothWays = e?.linkedFromConfirmedSource === true && e?.linksToConfirmedSource === true;
  if (e?.platformVerified === true || bothWays) {
    return {
      verdict: 'OFFICIAL_CONFIRMED', collectible: true, attributable: true,
      reason: e?.platformVerified === true
        ? '플랫폼 인증 표시가 있습니다' : '확인된 출처와 상호 링크됩니다',
    };
  }

  if (e?.linkedFromConfirmedSource === true || e?.linksToConfirmedSource === true) {
    return {
      verdict: 'CLAIMED_UNCONFIRMED', collectible: true, attributable: false,
      reason: '한쪽 방향만 연결됩니다 — 수집은 하되 발언을 그 사람의 것으로 단정하지 않습니다',
    };
  }

  return {
    verdict: 'UNVERIFIED', collectible: false, attributable: false,
    reason: '계정이 그 주체의 것이라는 증거가 없습니다 — 이름이 같은 것은 증거가 아닙니다',
  };
}

// ══════════════════════════════════════════════════════════
// ③ 발언 — 원문·시각·출처가 없으면 기록이 아니다
// ══════════════════════════════════════════════════════════

export type Direction = 'UP' | 'DOWN' | 'NEUTRAL';

export interface StatementRecord {
  /** 원문. **요약으로 대체하지 않는다** — 인용 정확성이 걸린다 */
  quote: string;
  /** 출처 URL */
  sourceUrl: string;
  /** 발언 시각 (ms epoch, UTC) */
  spokenAtMs: number | null;
  /** 수집 시각 (ms epoch) — 발언 시각과 다르다 */
  collectedAtMs: number | null;
}

export interface ExtractedClaim {
  /** 대상 자산 심볼. 못 읽으면 null */
  asset: string | null;
  direction: Direction | null;
  /** 전망 기간(ms). 못 읽으면 null */
  horizonMs: number | null;
}

export type ClaimUsability =
  /** 사후 검증이 가능하다 */
  | 'MEASURABLE'
  /** 방향이 없거나 중립이다 — 맞고 틀림을 매길 수 없다 */
  | 'NOT_DIRECTIONAL'
  /** 자산·기간·시각 중 하나가 없다 */
  | 'INCOMPLETE'
  /** 원문·출처가 없다 */
  | 'UNSOURCED';

export interface ClaimCheck {
  usability: ClaimUsability;
  /** 성과 통계의 분모에 넣어도 되는가 */
  scorable: boolean;
  reason: string;
}

/**
 * 이 발언을 사후 검증 대상으로 쓸 수 있는가.
 *
 * ★ **못 쓰는 발언을 틀린 발언으로 적지 않는다.** 분모에서 빼는 것과
 *   오답으로 세는 것은 전혀 다른 통계가 된다.
 */
export function checkClaim(
  s: StatementRecord | null | undefined,
  c: ExtractedClaim | null | undefined,
): ClaimCheck {
  const quote = String(s?.quote ?? '').trim();
  const url = String(s?.sourceUrl ?? '').trim();
  if (!quote || !url) {
    return { usability: 'UNSOURCED', scorable: false,
      reason: '원문 또는 출처가 없습니다 — 확인되지 않은 인용은 기록하지 않습니다' };
  }
  const spoken = s?.spokenAtMs;
  if (!Number.isFinite(spoken as number) || (spoken as number) <= 0) {
    return { usability: 'INCOMPLETE', scorable: false,
      reason: '발언 시각이 없습니다 — 언제의 전망인지 모르면 검증할 수 없습니다' };
  }
  const asset = String(c?.asset ?? '').trim();
  if (!asset) {
    return { usability: 'INCOMPLETE', scorable: false, reason: '대상 자산을 읽지 못했습니다' };
  }
  if (!Number.isFinite(c?.horizonMs as number) || (c?.horizonMs as number) <= 0) {
    return { usability: 'INCOMPLETE', scorable: false,
      reason: '전망 기간을 읽지 못했습니다 — 기간이 없으면 언제 평가할지 정할 수 없습니다' };
  }
  if (c?.direction !== 'UP' && c?.direction !== 'DOWN') {
    return { usability: 'NOT_DIRECTIONAL', scorable: false,
      reason: '방향이 상승·하락이 아닙니다 — 적중 여부를 매기지 않습니다' };
  }
  return { usability: 'MEASURABLE', scorable: true, reason: '' };
}

// ══════════════════════════════════════════════════════════
// ④ 사후 대조 — 가격이 구간을 덮지 않으면 판정하지 않는다
// ══════════════════════════════════════════════════════════

export type OutcomeCode =
  | 'HIT'
  | 'MISS'
  /** 임계 미만 움직임 — 맞다고도 틀리다고도 하지 않는다 */
  | 'FLAT'
  /** 가격 자료가 구간을 못 덮는다. **오답이 아니다** */
  | 'UNRESOLVED';

export interface PriceWindow {
  /** 발언 시각의 가격 */
  priceAtStatement: number | null;
  /** 전망 기간이 끝나는 시각의 가격 */
  priceAtHorizon: number | null;
  /** 자료가 구간 전체를 덮는가 */
  covered: boolean;
}

export interface OutcomeJudgement {
  code: OutcomeCode;
  /** 실제 변화율(%). 판정 불가면 null */
  movePct: number | null;
  /** 적중률 분모에 들어가는가 */
  counted: boolean;
  /**
   * ★ **언제나 'NOT_ESTABLISHED'다.**
   *
   * 발언 뒤 가격이 움직였다는 관측은 그 발언이 원인이라는 증거가
   * 아니다. 이 칸을 상수로 둔 이유: 호출부가 인과를 적고 싶어질 때
   * 여기서 막히게 하려는 것이다.
   */
  causality: 'NOT_ESTABLISHED';
  reason: string;
}

/** FLAT으로 볼 변화율 임계 (%). 비용·노이즈보다 작은 움직임은 판정하지 않는다 */
export const FLAT_THRESHOLD_PCT = 0.5;

/**
 * 전망이 맞았는가.
 *
 * ★ 가격 자료가 구간을 못 덮으면 `UNRESOLVED`다. "자료가 없다"를
 *   "틀렸다"로 적으면 적중률이 조용히 내려간다.
 */
export function judgeOutcome(
  claim: ExtractedClaim | null | undefined,
  w: PriceWindow | null | undefined,
  flatThresholdPct: number = FLAT_THRESHOLD_PCT,
): OutcomeJudgement {
  const un = (why: string): OutcomeJudgement => ({
    code: 'UNRESOLVED', movePct: null, counted: false,
    causality: 'NOT_ESTABLISHED', reason: why,
  });
  if (w?.covered !== true) return un('가격 자료가 전망 구간을 덮지 않습니다');
  const a = w?.priceAtStatement, b = w?.priceAtHorizon;
  if (!Number.isFinite(a as number) || (a as number) <= 0) return un('발언 시각의 가격이 없습니다');
  if (!Number.isFinite(b as number) || (b as number) <= 0) return un('기간 종료 시각의 가격이 없습니다');
  const dir = claim?.direction;
  if (dir !== 'UP' && dir !== 'DOWN') return un('방향이 상승·하락이 아닙니다');

  const movePct = ((b as number) - (a as number)) / (a as number) * 100;
  const th = Number.isFinite(flatThresholdPct) && flatThresholdPct >= 0
    ? flatThresholdPct : FLAT_THRESHOLD_PCT;
  if (Math.abs(movePct) < th) {
    return { code: 'FLAT', movePct, counted: false, causality: 'NOT_ESTABLISHED',
      reason: `변화 ${movePct.toFixed(2)}% — 임계 ${th}% 미만이라 판정하지 않습니다` };
  }
  const hit = dir === 'UP' ? movePct > 0 : movePct < 0;
  return {
    code: hit ? 'HIT' : 'MISS', movePct, counted: true, causality: 'NOT_ESTABLISHED',
    reason: `변화 ${movePct.toFixed(2)}% · 전망 ${dir}`,
  };
}

// ══════════════════════════════════════════════════════════
// ⑤ 성과 통계 — 인기와 정확도를 같은 칸에 쓰지 않는다
// ══════════════════════════════════════════════════════════

/** 적중률을 **적어도 되는** 최소 표본. 미만이면 숫자를 내놓지 않는다 */
export const MIN_SCORED_SAMPLE = 20;

export interface AccuracyStats {
  /** 판정된 표본 (HIT+MISS). FLAT·UNRESOLVED는 포함하지 않는다 */
  scored: number;
  hit: number;
  miss: number;
  flat: number;
  unresolved: number;
  /** 적중률(%). 표본이 부족하면 **null** — 0으로 적지 않는다 */
  hitRatePct: number | null;
  /** 표본이 부족한가 */
  insufficient: boolean;
  causality: 'NOT_ESTABLISHED';
  reason: string;
}

/**
 * 적중률.
 *
 * ★ 표본이 적으면 숫자를 주지 않는다. 3건 중 2건으로 "적중률 67%"를
 *   적으면 그 숫자가 근거처럼 쓰인다.
 */
export function accuracyStats(
  outcomes: readonly { code?: OutcomeCode | null }[] | null | undefined,
  minSample: number = MIN_SCORED_SAMPLE,
): AccuracyStats {
  const list = Array.isArray(outcomes) ? outcomes : [];
  let hit = 0, miss = 0, flat = 0, unresolved = 0;
  for (const o of list) {
    if (o?.code === 'HIT') hit += 1;
    else if (o?.code === 'MISS') miss += 1;
    else if (o?.code === 'FLAT') flat += 1;
    // 알 수 없는 값도 판정 불가로 센다 — 분모에 몰래 들어가지 않게
    else unresolved += 1;
  }
  const scored = hit + miss;
  const need = Number.isFinite(minSample) && minSample > 0 ? minSample : MIN_SCORED_SAMPLE;
  const insufficient = scored < need;
  return {
    scored, hit, miss, flat, unresolved,
    hitRatePct: insufficient ? null : (hit / scored) * 100,
    insufficient,
    causality: 'NOT_ESTABLISHED',
    reason: insufficient
      ? `판정된 표본 ${scored}건 — ${need}건 미만이라 적중률을 적지 않습니다`
      : '',
  };
}

export interface PopularityStats {
  followers?: number | null;
  viewsPerPost?: number | null;
}

/**
 * 인기와 정확도를 **한 객체로 합치지 않는다.**
 *
 * 이 함수는 둘을 나란히 두되, 섞어 만든 단일 점수를 만들지 않는다.
 * 합성 점수를 한 번 만들면 화면이 그것만 보여 주게 되고, 사람은
 * 구독자 많은 사람을 잘 맞히는 사람으로 읽는다.
 */
export function personaScorecard(i: {
  accuracy: AccuracyStats;
  popularity?: PopularityStats | null;
}): {
  accuracy: AccuracyStats;
  popularity: PopularityStats;
  /** 합성 점수는 없다. 이 칸이 그 사실을 적는다 */
  combinedScore: null;
  note: string;
} {
  return {
    accuracy: i.accuracy,
    popularity: { followers: i.popularity?.followers ?? null,
      viewsPerPost: i.popularity?.viewsPerPost ?? null },
    combinedScore: null,
    note: '인기와 적중률을 합산하지 않습니다 — 구독자 수는 전망이 맞았다는 증거가 아닙니다',
  };
}

// ══════════════════════════════════════════════════════════
// ⑥ 수집기 인터페이스 — 이 파일은 구현하지 않는다
// ══════════════════════════════════════════════════════════

export interface RawCapture {
  subjectId: string;
  accountId: string;
  statement: StatementRecord;
  /** 플랫폼 식별자 ('youtube' 등). 분류는 수집기 몫이다 */
  platform: string;
}

/**
 * 수집기 계약.
 *
 * ★ **대량 수집은 승인 사항이다.** 이 인터페이스는 모양만 정하고,
 *   구현체는 이 변경에 포함하지 않는다.
 *
 * ★ 수집기는 `judgeAccount`가 `collectible: true`를 준 계정만 읽는다.
 *   그 검사를 수집기 안에서 다시 구현하지 않는다.
 */
export interface PersonaCollector {
  readonly platform: string;
  /** 수집해도 되는 계정인가 — 정본에 위임한다 */
  mayCollect(evidence: AccountEvidence): boolean;
  /** 한 계정의 새 발언. **구현체 없음 (설계 단계)** */
  fetchSince(accountId: string, sinceMs: number): Promise<RawCapture[]>;
}

/** 수집기가 정본을 쓰도록 강제하는 기본 구현 */
export function mayCollectWith(evidence: AccountEvidence): boolean {
  return judgeAccount(evidence).collectible === true;
}
