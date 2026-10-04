// src/lib/exchanges/positionRiskRead.ts
//
// **포지션 조회의 순서와 시각 경계 — 정본은 여기 하나다.**
//
// 왜 `binanceFutures.ts`에서 뗐는가
// ─────────────────────────────────
// 그 파일은 node 내장 `crypto`를 쓴다(서명). 그래서 검사기가 그 모듈을
// **컴파일할 수 없고**, 결국 "시각 경계가 맞는가"를 돌려서 확인할 수
// 없다. 이 저장소는 같은 함정을 `exitIntent.ts`에서 이미 겪었고 같은
// 방법으로 풀었다 — 판정을 순수 모듈로 떼서 검사기가 **실행**하게 한다.
//
// 이 파일은 네트워크를 모른다. 서명 조회와 시계를 전부 주입받는다.
//
// ★ 지키는 것 하나
// ────────────────
// `liquidationPrice`가 **관측된 시각**은 그 값을 담아 온 positionRisk
// 응답을 받은 시각이다. 그것 말고는 아무것도 그 자리에 적지 않는다:
//
//   · 요청을 보내기 **전** 시각 (왕복만큼 앞선다)
//   · 실패한 v2 요청의 시각 (성공한 관측의 시각이 아니다)
//   · 뒤이은 `/fapi/v3/account` 응답 시각 (청산가가 거기 없다)
//   · 거래소가 준 `updateTime` (문서는 그냥 "update time"이라고만 한다)

export interface SymbolPositionRisk {
  symbol: string;
  /** 부호 있는 수량. 0이면 포지션 없음 */
  positionAmt: number;
  /** 'isolated' | 'cross' */
  marginType: string;
  leverage: number | null;
  /** 0이면 거래소가 안 준 것이라 null */
  liquidationPrice: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  /**
   * 거래소가 적어 준 **포지션 갱신 시각**. 없으면 null.
   *
   * ★ **이것을 마크가의 관측 시각으로 쓰지 마라.** 문서상 이 값은
   *   포지션의 update time이고, 마크가 호가가 만들어진 시각이라는
   *   보장이 없다 — 포지션을 사흘 안 건드렸으면 사흘 전 값이다.
   *   기준 마크가는 `readMarketSnapshot`이 시장 데이터에서 읽는다.
   *   그래서 이름도 `markPriceObservedAtMs`가 아니라 이것이다.
   *
   * ★ **청산가의 시각으로도 쓰지 마라.** 같은 이유다 — 공식 응답에
   *   `liquidationPrice` 전용 시각은 없다.
   */
  positionUpdateTimeMs: number | null;
}

/**
 * **포지션 조회가 실제로 어느 HTTP 경계에서 왔는가.**
 *
 * 이 helper는 한 번의 왕복이 아니다 — v2가 실패하면 v3를, 그 뒤 마진
 * 모드를 채우려고 `/fapi/v3/account`까지 부른다. 그래서 부르는 쪽이
 * 호출 **전에** 시각을 찍으면 그 값은 "응답을 받은 시각"이 아니라
 * "요청을 시작하기 전 시각"이고, 왕복 두세 번만큼 앞선다.
 *
 * ⑤B-0의 목적이 나중 문턱을 유도할 **정확한 관측**을 모으는 것이므로
 * 이건 이름 문제가 아니라 데이터 오염이다. 그래서 경계를 **여기서**
 * 잡는다.
 *
 * ★ `liquidationPrice`가 관측된 시각은 **positionRisk 응답 시점**이다.
 *   그 뒤 account를 더 불러도 그 시각으로 덮어쓰지 않는다 — 청산가는
 *   account 응답에 들어 있지 않다.
 *
 * ★ v2가 실패하고 v3로 갔으면 **v2의 시각을 v3 provenance로 재사용하지
 *   않는다.** 실패한 요청의 시각은 성공한 관측의 시각이 아니다.
 */
export interface PositionRiskProvenance {
  /** 어느 엔드포인트가 `liquidationPrice`를 줬는가. 못 받았으면 null */
  positionRiskSource: 'V2' | 'V3' | null;
  /** 그 요청을 **보내기 직전** 시각 */
  positionRiskRequestStartedAtMs: number | null;
  /** 그 응답을 **받은 직후** 시각 */
  positionRiskReceivedAtMs: number | null;
  /** 마진 모드·배율을 채우려고 부른 계정 조회. 안 불렀으면 null */
  accountRequestStartedAtMs: number | null;
  accountReceivedAtMs: number | null;
}

const NO_PROVENANCE: PositionRiskProvenance = {
  positionRiskSource: null,
  positionRiskRequestStartedAtMs: null, positionRiskReceivedAtMs: null,
  accountRequestStartedAtMs: null, accountReceivedAtMs: null,
};

export async function readPositionRiskWithProvenance(
  symbol: string,
  /** 서명 조회. **주입받는다** — 이 파일은 네트워크를 모른다 */
  signed: (path: string, params?: Record<string, string | number>) => Promise<any>,
  /** 지금 시각. **시험이 고정한다** — 전역 `Date.now`를 바꾸지 않는다 */
  nowMs: () => number = () => Date.now(),
): Promise<{
  risk: SymbolPositionRisk | null; error: string | null;
  provenance: PositionRiskProvenance;
}> {
  const sym = symbol.toUpperCase().replace('/', '');
  const prov: PositionRiskProvenance = { ...NO_PROVENANCE };

  const shape = (row: any, extra?: { marginType?: string; leverage?: number | null }) => {
    const liq = parseFloat(row.liquidationPrice ?? '0');
    const lev = extra?.leverage != null ? extra.leverage : parseInt(row.leverage ?? '0', 10);
    return {
      symbol: String(row.symbol ?? sym),
      positionAmt: parseFloat(row.positionAmt ?? '0') || 0,
      marginType: String(extra?.marginType ?? row.marginType ?? '').toLowerCase(),
      // 0은 값이 아니라 '못 받았음'이다
      leverage: Number.isFinite(lev as any) && Number(lev) > 0 ? Number(lev) : null,
      liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : null,
      entryPrice: parseFloat(row.entryPrice ?? '0') || null,
      markPrice: parseFloat(row.markPrice ?? '0') || null,
      // 버리지 않고 보존하되 **마크가 시각이 아니다**(위 주석).
      positionUpdateTimeMs: (() => {
        const u = Number(row.updateTime);
        return Number.isFinite(u) && u > 0 ? u : null;
      })(),
    } as SymbolPositionRisk;
  };
  // 헤지 모드에서는 같은 심볼에 LONG/SHORT 두 줄이 온다. 열려 있는 쪽을
  // 고르고, 둘 다 0이면 첫 줄(설정값은 같다)을 쓴다.
  const pick = (data: any) => {
    const rows = Array.isArray(data) ? data : [data];
    return rows.find((r: any) => parseFloat(r?.positionAmt ?? '0') !== 0) ?? rows[0];
  };

  let v2Err = '';
  // ── v2 ──
  //
  //   실패하면 아래 v3가 **자기 시각을 새로 찍는다.** 여기서 찍은 값은
  //   실패한 요청의 것이므로 성공한 관측에 붙이지 않는다.
  const v2Started = nowMs();
  try {
    const raw = await signed('/fapi/v2/positionRisk', { symbol: sym });
    const v2Received = nowMs();
    const row = pick(raw);
    if (row && row.marginType != null) {
      return {
        risk: shape(row), error: null,
        provenance: {
          ...prov, positionRiskSource: 'V2',
          positionRiskRequestStartedAtMs: v2Started,
          positionRiskReceivedAtMs: v2Received,
        },
      };
    }
  } catch (e: any) { v2Err = String(e?.message || e); }

  // v3 + 계정 조회. v3에는 marginType·leverage가 없다.
  const v3Started = nowMs();
  try {
    const raw3 = await signed('/fapi/v3/positionRisk', { symbol: sym });
    // ★ **청산가가 관측된 시각은 여기다.** 아래 account 응답으로
    //   덮어쓰지 않는다 — 청산가는 그 응답에 들어 있지 않다.
    const v3Received = nowMs();
    const row = pick(raw3);
    if (!row) {
      return { risk: null, error: `포지션 정보가 비어 있습니다 (v2: ${v2Err || '없음'})`,
        provenance: { ...prov } };
    }
    const p3: PositionRiskProvenance = {
      ...prov, positionRiskSource: 'V3',
      positionRiskRequestStartedAtMs: v3Started,
      positionRiskReceivedAtMs: v3Received,
    };

    let marginType: string | undefined;
    let leverage: number | null | undefined;
    p3.accountRequestStartedAtMs = nowMs();
    try {
      const acct: any = await signed('/fapi/v3/account');
      p3.accountReceivedAtMs = nowMs();
      const p = (acct?.positions || []).find((x: any) => String(x?.symbol) === sym);
      if (p) {
        // v3 계정은 isolated 여부를 boolean으로 준다
        marginType = p.isolated === true ? 'isolated' : p.isolated === false ? 'cross' : undefined;
        const l = parseInt(p.leverage ?? '0', 10);
        leverage = Number.isFinite(l) && l > 0 ? l : null;
      }
    } catch { /* marginType은 빈 값 → 검사가 '확인 못 함'으로 잡는다 */ }

    return {
      risk: shape(row, { marginType, leverage }),
      // 마진 모드를 못 채웠으면 그 사실을 남긴다. 값만 비워 두면 또
      // "왜 확인 못 했지"가 된다.
      error: marginType ? null : `마진 모드를 계정 조회에서 못 찾았습니다 (v2: ${v2Err || '없음'})`,
      provenance: p3,
    };
  } catch (e: any) {
    return {
      risk: null,
      error: `포지션 조회 실패 — v2: ${v2Err || '시도 안 함'} / v3: ${String(e?.message || e)}`,
      provenance: { ...prov },
    };
  }
}
