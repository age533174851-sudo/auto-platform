// src/lib/strategies/simFormat.ts
//
// 모의 성적표를 사람이 읽을 수 있는 문장으로 바꾼다.
//
// 여기 있는 것들이 왜 따로 나와 있나
// ─────────────────────────────────
// 화면에 이런 두 줄이 떠 있었다.
//
//   표본 기간: 26. 8. 3. 오후 10:05 ~ 26. 8. 3. 오후 10:05
//   누적손익 +238,790,256,334,269,830,000,000,000,000,000,000
//
// 첫 줄은 기간이 아니다. 시작과 끝이 같은 시각이다 — 1000건을 1초에
// 돌렸으니 벽시계로는 당연히 그렇다. 둘째 줄은 칸을 뚫고 나가서 옆의
// 승률·MDD를 화면 밖으로 밀어냈다.
//
// 둘 다 "틀린 계산"이 아니라 **틀린 표시**다. 그래서 표시를 따로 떼어
// 두고 테스트를 붙인다. 컴포넌트 안에 있으면 확인할 방법이 없다.

/**
 * 초를 사람이 읽는 기간으로.
 *
 * 시뮬은 1000회를 1초에 돌린다. 그러면 "이 전략 1000번"이 쉬운 일처럼
 * 보이는데 실제로는 몇 달치다. 그 감각이 없으면 시뮬 결과를 과신한다.
 */
export function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = sec / 60, h = m / 60, d = h / 24;
  if (d >= 365) return `${(d / 365).toFixed(1)}년`;
  if (d >= 30)  return `${(d / 30).toFixed(1)}개월`;
  if (d >= 1)   return `${d.toFixed(d < 10 ? 1 : 0)}일`;
  if (h >= 1)   return `${h.toFixed(h < 10 ? 1 : 0)}시간`;
  if (m >= 1)   return `${Math.round(m)}분`;
  return `${Math.round(sec)}초`;
}

// 억(1e8)부터. 복리 시뮬은 금방 조·경을 넘어간다.
const KO_UNITS: Array<{ v: number; s: string }> = [
  { v: 1e32, s: '구' }, { v: 1e28, s: '양' }, { v: 1e24, s: '자' },
  { v: 1e20, s: '해' }, { v: 1e16, s: '경' }, { v: 1e12, s: '조' },
  { v: 1e8,  s: '억' },
];

/**
 * 금액. **칸을 뚫고 나가지 않는 것이 정확도보다 중요하다** — 35자리
 * 숫자를 다 적어 봐야 아무도 못 읽고 옆 칸만 화면 밖으로 밀린다.
 *
 * signed=true면 이득에 +를 붙인다(손익용). 잔고에는 안 붙인다.
 */
export function fmtMoney(n: number, currency: 'KRW' | 'USD' = 'KRW', signed = false): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : (signed ? '+' : '');

  if (currency === 'USD') {
    if (a >= 1e15) return `${sign}$${a.toExponential(2)}`;
    if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(1)}T`;
    if (a >= 1e9)  return `${sign}$${(a / 1e9).toFixed(1)}B`;
    if (a >= 1e6)  return `${sign}$${(a / 1e6).toFixed(2)}M`;
    return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : 2 })}`;
  }

  if (a >= 1e36) return `${sign}${a.toExponential(2)}원`;
  for (const u of KO_UNITS) {
    if (a >= u.v) {
      const q = a / u.v;
      return `${sign}${q.toFixed(q >= 100 ? 0 : 1)}${u.s}원`;
    }
  }
  return `${sign}${Math.round(a).toLocaleString('ko-KR')}원`;
}

/** 시간대는 기기 설정을 따른다 (Intl에 맡긴다). */
export function fmtStamp(ms: number): string {
  try {
    // dateStyle/timeStyle은 런타임에는 있지만 이 저장소의 lib 설정에서는
    // 타입에 없다. 타입 때문에 표시를 나쁘게 바꾸지는 않는다.
    const opts: any = { dateStyle: 'short', timeStyle: 'short' };
    return new Intl.DateTimeFormat('ko-KR', opts).format(new Date(ms));
  } catch { return '알 수 없음'; }
}

export interface SamplePeriodInput {
  trades: number;
  /** 이 표본이 잡아먹은 **모의** 시간(초) */
  simSeconds: number;
  /** 보유시간이 프로필에 없어서 가정한 값으로 셌나 */
  assumed?: boolean;
  firstAt?: number;
  lastAt?: number;
}

/**
 * 표본 기간 한 줄.
 *
 * **벽시계가 아니라 모의 시계로 적는다.** 1000건이 1초에 돌아가므로
 * 벽시계 기간은 언제나 0이고, 시작과 끝이 같은 시각으로 찍힌다. 알고
 * 싶은 것은 "이 성적이 며칠치인가"이고, 그건 모의 시계에만 있다.
 *
 * 벽시계는 참고로 뒤에 붙인다 — 언제 눌렀는지는 알아야 하니까.
 */
export function samplePeriodText(input: SamplePeriodInput): string {
  const trades = Number(input.trades) || 0;
  if (trades <= 0) return '';

  const sim = Number(input.simSeconds) || 0;
  const head = sim > 0
    ? `표본 기간: 모의 ${fmtDur(sim)}치 · ${trades.toLocaleString('ko-KR')}건`
      + (input.assumed ? ' (보유시간 가정치)' : '')
    : `표본 ${trades.toLocaleString('ko-KR')}건 · 모의 기간 기록 없음`
      + ' (이 기능이 생기기 전에 쌓인 표본입니다 — 계좌 리셋 후 다시 모으면 기간이 남습니다)';

  // 벽시계. **없으면 0으로 채우지 않는다** — 0은 1970년이다.
  const a = input.firstAt, b = input.lastAt;
  if (a == null || b == null) return head;
  // 1분 안에 다 돌았으면 두 번 적을 이유가 없다. 같은 시각 두 개를
  // '~'로 이어 놓은 것이 원래의 결함이었다.
  const tail = (b - a) < 60_000 ? fmtStamp(b) : `${fmtStamp(a)} ~ ${fmtStamp(b)}`;
  return `${head} · 실제 실행 ${tail}`;
}
