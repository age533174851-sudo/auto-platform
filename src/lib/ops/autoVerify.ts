// src/lib/ops/autoVerify.ts
//
// **사용자가 Gate 앱을 열어 확인하지 않아도 되게 한다.**
//
// 지금까지 "정말 정리됐나"를 확인하는 방법은 사람이 거래소 앱을 열어
// Positions와 Orders 탭을 보는 것이었다. 그건 확인이 아니라 숙제다.
// 그리고 사람이 보는 것은 기록으로 남지 않는다 — 어제 봤는지 못 봤는지도
// 아무도 모른다.
//
// 여기서 하는 것은 셋이다:
//
//   1. 테스트넷 읽기 전용 검증 — 주문을 내지 않고 무엇이 되는지 확인
//   2. #142 정리 검증 — 포지션 0 · 내 SL/TP 없음 · 재조회로 확인
//   3. 장부 건강 — 표가 있는지가 아니라 **쓰이고 있는지**
//
// 공통 규칙: **읽지 못한 것을 통과로 적지 않는다.**

export type CheckState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIPPED';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface VerifyResult {
  code: 'PASS' | 'FAIL' | 'UNKNOWN';
  summary: string;
  checks: Check[];
  /** 새 진입을 막아야 하는가 */
  blockEntry: boolean;
}

function fold(checks: Check[], what: string, blockOnFail: boolean): VerifyResult {
  const seen = checks.filter(c => c.state !== 'SKIPPED');
  const failed = seen.filter(c => c.state === 'FAIL');
  const unknown = seen.filter(c => c.state === 'UNKNOWN');

  if (seen.length === 0) {
    return { code: 'UNKNOWN', checks, blockEntry: false,
      summary: `${what}에서 확인한 것이 없습니다 — 통과가 아닙니다` };
  }
  if (failed.length > 0) {
    return {
      code: 'FAIL', checks, blockEntry: blockOnFail,
      summary: `${failed.length}가지가 실패했습니다 — ${failed.map(f => f.label).slice(0, 3).join(' · ')}`,
    };
  }
  if (unknown.length > 0) {
    // **확인하지 못한 것은 통과가 아니다.**
    return {
      code: 'UNKNOWN', checks, blockEntry: false,
      summary: `${unknown.length}가지를 확인하지 못했습니다 (${unknown.map(u => u.label).slice(0, 3).join(' · ')}) — 정상이라는 뜻이 아닙니다`,
    };
  }
  return { code: 'PASS', checks, blockEntry: false, summary: `${seen.length}가지를 확인했고 모두 정상입니다` };
}

// ── 1. 테스트넷 읽기 전용 검증 ──

export interface TestnetProbe {
  /** 계좌를 읽었는가. **못 읽었으면 null** */
  accountOk: boolean | null;
  /** 포지션 조회가 됐는가 */
  positionsOk: boolean | null;
  /** 주문 조회가 됐는가 */
  ordersOk: boolean | null;
  /** 배율을 읽었는가 (요청 배율과 실제 배율 대조에 필요) */
  leverageOk: boolean | null;
  /** 포지션 모드(ONE_WAY/HEDGE)를 읽었는가 */
  positionModeOk: boolean | null;
  /** 이 연결이 실제로 테스트넷인가. **모르면 null** */
  isTestnet: boolean | null;
}

/**
 * 주문을 내지 않고 무엇이 되는지 본다.
 *
 * **주문을 내는 스모크는 여기 없다.** 그건 따로 명령해야 도는 것이고,
 * 이 검증은 배포 뒤 자동으로 돌아도 안전해야 한다.
 */
export function testnetVerify(p: TestnetProbe | null | undefined): VerifyResult {
  const b = (v: boolean | null | undefined): CheckState =>
    v == null ? 'UNKNOWN' : v ? 'PASS' : 'FAIL';

  if (!p) {
    return { code: 'UNKNOWN', checks: [], blockEntry: false,
      summary: '거래소를 확인하지 못했습니다 — 정상이라는 뜻이 아닙니다' };
  }

  const checks: Check[] = [
    { id: 'account', label: '계좌 조회', state: b(p.accountOk),
      detail: p.accountOk == null ? '읽지 못했습니다' : p.accountOk ? '읽었습니다' : '실패했습니다' },
    { id: 'positions', label: '포지션 조회', state: b(p.positionsOk),
      detail: p.positionsOk == null ? '읽지 못했습니다'
        : p.positionsOk ? '읽었습니다' : '실패했습니다 — 포지션을 못 읽으면 청산 판단을 할 수 없습니다' },
    { id: 'orders', label: '주문 조회', state: b(p.ordersOk),
      detail: p.ordersOk == null ? '읽지 못했습니다'
        : p.ordersOk ? '읽었습니다' : '실패했습니다 — 남은 보호주문을 볼 수 없습니다' },
    { id: 'leverage', label: '배율 확인', state: b(p.leverageOk),
      detail: p.leverageOk == null ? '읽지 못했습니다'
        : p.leverageOk ? '읽었습니다' : '실패했습니다 — 요청 배율과 실제 배율을 대조할 수 없습니다' },
    { id: 'positionMode', label: '포지션 모드', state: b(p.positionModeOk),
      detail: p.positionModeOk == null ? '읽지 못했습니다' : p.positionModeOk ? '읽었습니다' : '실패했습니다' },
    {
      id: 'testnet', label: '테스트넷 확인',
      // **모르면 통과가 아니다.** 실전 계좌를 테스트넷으로 착각하면
      // 그 한 번이 실제 돈이다.
      state: p.isTestnet == null ? 'UNKNOWN' : p.isTestnet ? 'PASS' : 'FAIL',
      detail: p.isTestnet == null ? '이 연결이 테스트넷인지 확인하지 못했습니다'
        : p.isTestnet ? '테스트넷 연결입니다' : '**실전 연결입니다** — 테스트넷 검증 대상이 아닙니다',
    },
  ];
  return fold(checks, '테스트넷 검증', false);
}

// ── 2. #142 정리 검증 ──

export interface CleanupProbe {
  /** 거래소에서 다시 읽은 포지션 수량. **못 읽었으면 null** */
  positionQty: number | null;
  positionRead: boolean;
  /** 내 것으로 확인된, 아직 살아 있는 보호주문 번호들. **못 읽었으면 null** */
  ownedProtectionLeft: string[] | null;
  /** 남의 것이라 손대지 않은 주문 수 (있어도 정상이다) */
  foreignKept: number;
  /** 소유를 판정하지 못한 주문 수. **하나라도 있으면 통과가 아니다** */
  unknownOwnership: number | null;
  /** 정리 절차가 스스로 낸 판정 */
  cleanupCode: string | null;
  /** 정리 뒤 거래소를 다시 읽어 확인했는가 */
  rereadConfirmed: boolean | null;
}

/**
 * 실제 자동매매 한 판이 끝난 뒤, **정말 깨끗한가.**
 *
 * 사용자가 Gate 앱을 열어 Positions 0 / Orders 0을 눈으로 확인하는 일을
 * 없앤다. 대신 실패하면 **새 진입을 막는다** — 남은 보호주문 위로 새
 * SL/TP를 얹으면 다음 진입이 옛 주문에 맞아 예상치 못하게 닫힌다.
 */
export function cleanupVerify(p: CleanupProbe | null | undefined): VerifyResult {
  if (!p) {
    return { code: 'UNKNOWN', checks: [], blockEntry: false,
      summary: '정리 결과를 읽지 못했습니다 — 깨끗하다는 뜻이 아닙니다' };
  }

  const checks: Check[] = [];

  checks.push({
    id: 'position', label: '포지션 0',
    state: !p.positionRead || p.positionQty == null ? 'UNKNOWN'
      : Math.abs(p.positionQty) < 1e-12 ? 'PASS' : 'FAIL',
    detail: !p.positionRead || p.positionQty == null
      ? '거래소에서 포지션을 읽지 못했습니다 — 0이라는 뜻이 아닙니다'
      : Math.abs(p.positionQty) < 1e-12 ? '포지션이 없습니다' : `포지션이 ${p.positionQty} 남아 있습니다`,
  });

  checks.push({
    id: 'ownedProtection', label: '내 보호주문 없음',
    state: p.ownedProtectionLeft == null ? 'UNKNOWN'
      : p.ownedProtectionLeft.length === 0 ? 'PASS' : 'FAIL',
    detail: p.ownedProtectionLeft == null
      ? '주문을 읽지 못했습니다 — 남은 것이 없다는 뜻이 아닙니다'
      : p.ownedProtectionLeft.length === 0 ? '내 보호주문이 남아 있지 않습니다'
        // **번호는 문자열로 그대로 적는다.** Gate의 int64는 숫자로 다루면 끝자리가 뭉개진다.
        : `내 보호주문 ${p.ownedProtectionLeft.length}건이 남아 있습니다 (${p.ownedProtectionLeft.slice(0, 3).join(', ')})`,
  });

  checks.push({
    id: 'unknownOwnership', label: '소유 판정',
    // **UNKNOWN을 0으로 적지 않는다.** 누구 것인지 모르는 주문을
    // 통과로 넘기면, 다음 진입이 그 주문에 맞는다.
    state: p.unknownOwnership == null ? 'UNKNOWN' : p.unknownOwnership === 0 ? 'PASS' : 'FAIL',
    detail: p.unknownOwnership == null ? '소유를 판정하지 못했습니다'
      : p.unknownOwnership === 0 ? '모든 주문의 소유를 판정했습니다'
        : `소유를 판정하지 못한 주문이 ${p.unknownOwnership}건 있습니다`,
  });

  checks.push({
    id: 'foreign', label: '남의 주문 보존',
    // 남의 것이 남아 있는 것은 **정상이다.** 지우면 안 되는 것이다.
    state: 'PASS',
    detail: p.foreignKept > 0
      ? `다른 전략의 주문 ${p.foreignKept}건은 손대지 않았습니다`
      : '다른 전략의 주문은 없었습니다',
  });

  checks.push({
    id: 'reread', label: '재조회 확인',
    state: p.rereadConfirmed == null ? 'UNKNOWN' : p.rereadConfirmed ? 'PASS' : 'FAIL',
    detail: p.rereadConfirmed == null ? '정리 뒤 다시 읽지 못했습니다'
      : p.rereadConfirmed ? '정리 뒤 거래소를 다시 읽어 확인했습니다'
        // 취소 요청이 200을 받은 것과 주문이 사라진 것은 다른 사실이다.
        : '정리 뒤 재조회에서 확인되지 않았습니다',
  });

  if (p.cleanupCode) {
    checks.push({
      id: 'cleanupCode', label: '정리 판정',
      state: p.cleanupCode === 'CLEAN' || p.cleanupCode === 'NOTHING_TO_DO' ? 'PASS' : 'FAIL',
      detail: `정리 절차가 ${p.cleanupCode}로 끝났습니다`,
    });
  }

  // 실패면 **새 진입을 막는다.**
  return fold(checks, '정리 검증', true);
}

// ── 3. 장부 건강 ──

export interface LedgerProbe {
  /** 표가 있는가. **못 읽었으면 null** */
  tableExists: boolean | null;
  /** 마지막 기록 시각. 없으면 null */
  lastEventMs: number | null;
  /** 기록 수 */
  eventCount: number | null;
  /** 같은 열쇠로 두 번 들어간 것이 있는가 */
  duplicateKeys: number | null;
  /** 체결 수 (거래소 기준) */
  fillCount: number | null;
  /** 장부에 적힌 체결 수 */
  ledgerFillCount: number | null;
  /** 수수료·펀딩이 수집되고 있는가 */
  feesCollected: boolean | null;
  nowMs: number;
}

/** 이 시간 넘게 아무것도 안 적혔으면 writer가 죽은 것으로 본다 */
export const LEDGER_STALE_MS = 24 * 60 * 60_000;

/**
 * 장부가 **있는지**가 아니라 **쓰이고 있는지**.
 *
 * 048(자산 스냅샷)이 표만 만들어지고 채우는 코드가 없어서 지갑 곡선이
 * 구조적으로 비어 있었다. 표의 존재를 건강으로 읽으면 그 고장이 그대로
 * 돌아온다.
 */
export function ledgerHealth(p: LedgerProbe | null | undefined): VerifyResult {
  if (!p) {
    return { code: 'UNKNOWN', checks: [], blockEntry: false,
      summary: '장부를 확인하지 못했습니다 — 정상이라는 뜻이 아닙니다' };
  }

  const checks: Check[] = [];

  checks.push({
    id: 'table', label: '장부 표',
    state: p.tableExists == null ? 'UNKNOWN' : p.tableExists ? 'PASS' : 'FAIL',
    detail: p.tableExists == null ? '표가 있는지 읽지 못했습니다'
      : p.tableExists ? '있습니다' : '없습니다 — 마이그레이션이 자동으로 적용합니다',
  });

  if (p.tableExists) {
    const age = p.lastEventMs == null ? null : p.nowMs - p.lastEventMs;
    checks.push({
      id: 'writer', label: '기록 중',
      // **표가 있는데 아무것도 안 적히는 것이 가장 조용한 고장이다.**
      state: p.eventCount == null ? 'UNKNOWN'
        : p.eventCount === 0 ? 'FAIL'
        : age == null ? 'UNKNOWN'
        : age > LEDGER_STALE_MS ? 'FAIL' : 'PASS',
      detail: p.eventCount == null ? '기록 수를 읽지 못했습니다'
        : p.eventCount === 0 ? '표는 있는데 기록이 하나도 없습니다 — writer가 배선되지 않았을 수 있습니다'
        : age == null ? '마지막 기록 시각을 읽지 못했습니다'
        : age > LEDGER_STALE_MS ? `마지막 기록이 ${Math.round(age / 3_600_000)}시간 전입니다`
        : `기록 ${p.eventCount}건 · 마지막 ${Math.round(age / 60_000)}분 전`,
    });

    checks.push({
      id: 'duplicates', label: '중복 기록',
      state: p.duplicateKeys == null ? 'UNKNOWN' : p.duplicateKeys === 0 ? 'PASS' : 'FAIL',
      detail: p.duplicateKeys == null ? '중복을 확인하지 못했습니다'
        : p.duplicateKeys === 0 ? '같은 사건이 두 번 적힌 것은 없습니다'
          : `같은 열쇠로 ${p.duplicateKeys}건이 중복 기록됐습니다 — 손익이 부풀려집니다`,
    });

    checks.push({
      id: 'fills', label: '체결 ↔ 장부',
      state: p.fillCount == null || p.ledgerFillCount == null ? 'UNKNOWN'
        : p.fillCount === p.ledgerFillCount ? 'PASS' : 'FAIL',
      detail: p.fillCount == null || p.ledgerFillCount == null
        ? '체결 수를 대조하지 못했습니다'
        : p.fillCount === p.ledgerFillCount
          ? `체결 ${p.fillCount}건이 모두 장부에 있습니다`
          : `체결 ${p.fillCount}건 중 장부에 ${p.ledgerFillCount}건만 있습니다 — 빠진 것이 손익에 안 잡힙니다`,
    });

    checks.push({
      id: 'fees', label: '수수료·펀딩',
      state: p.feesCollected == null ? 'UNKNOWN' : p.feesCollected ? 'PASS' : 'FAIL',
      detail: p.feesCollected == null ? '수수료 수집 여부를 확인하지 못했습니다'
        : p.feesCollected ? '수집되고 있습니다'
          // 넷 중 하나라도 없으면 매매손익은 만들 수 없다.
          : '수수료·펀딩이 수집되지 않아 매매손익을 확정할 수 없습니다',
    });
  }

  return fold(checks, '장부 점검', false);
}
