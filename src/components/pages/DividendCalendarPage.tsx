'use client';
import { A } from '@/lib/theme/colors';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { notifyError } from '@/lib/notify/center';
import DripSimulator from '@/components/DripSimulator';
import {
  BadgeDollarSign, Briefcase, CalendarDays, ListChecks, Pencil,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { formatKRW } from '@/lib/format';
import {
  DIVIDEND_UNIVERSE, FREQ_LABEL,
  getUpcomingDividends, estimateAnnualDividends,
  loadDividendHoldings, saveDividendHoldings,
  validateHoldingShares,
} from '@/lib/accounts/dividends';
import type { DividendHolding, UpcomingDividend } from '@/lib/accounts/dividends';
import { SliderField } from '@/components/ui/SettingField';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';

const inp: React.CSSProperties = {
  width: '100%', padding: '12px 14px', minHeight: 48,
  background: T.alt, border: `1px solid ${T.border}`, borderRadius: R.md,
  color: T.txt, fontSize: 14, boxSizing: 'border-box',
};

const USD_TO_KRW = 1375;
const toKRW = (amount: number, currency: 'USD'|'KRW') => currency === 'USD' ? amount * USD_TO_KRW : amount;
const daysUntil = (d: Date) => Math.ceil((d.getTime() - Date.now()) / 86400000);

function DividendInner({ currency = 'KRW' }: { currency?: string }) {
  const [tab, setTab] = useState<'upcoming'|'holdings'|'all'>('upcoming');
  const [holdings, setHoldings] = useState<DividendHolding[]>([]);
  const [filterMyOnly, setFilterMyOnly] = useState(true);
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [draftShares, setDraftShares] = useState<string>('');
  const [addSymbol, setAddSymbol] = useState('');
  const [addShares, setAddShares] = useState('');

  useEffect(() => {
    try { setHoldings(loadDividendHoldings()); } catch (e) { console.error('[div] load', e); setHoldings([]); }
  }, []);

  const persist = useCallback((next: DividendHolding[]) => {
    setHoldings(next);
    try { saveDividendHoldings(next); } catch (e) { console.warn('[div] save', e); }
  }, []);

  const upcoming = useMemo(() => {
    const symbols = filterMyOnly && holdings.length > 0 ? holdings.map(h => h.symbol) : undefined;
    return getUpcomingDividends(3, symbols);
  }, [holdings, filterMyOnly]);

  const annualEsts = useMemo(() => estimateAnnualDividends(holdings), [holdings]);
  const totalAnnualKRW = useMemo(() => annualEsts.reduce((s, e) => s + toKRW(e.annualDividend, e.currency), 0), [annualEsts]);
  const monthlyKRW = totalAnnualKRW / 12;

  type UpcomingWithPayment = UpcomingDividend & { shares: number; payment: number; paymentKRW: number };
  const holdingsUpcoming = useMemo<UpcomingWithPayment[]>(() => {
    if (holdings.length === 0) return [];
    const symbols = holdings.map(h => h.symbol);
    const all = getUpcomingDividends(3, symbols);
    return all.map(u => {
      const h = holdings.find(x => x.symbol === u.symbol);
      const shares = h?.shares || 0;
      const payment = u.paymentPerShare * shares;
      return { ...u, shares, payment, paymentKRW: toKRW(payment, u.currency) };
    });
  }, [holdings]);

  const addHolding = () => {
    if (!addSymbol.trim() || !addShares.trim()) return;
    const s = addSymbol.toUpperCase().trim();
    const n = Number(addShares);
    if (!DIVIDEND_UNIVERSE.find(d => d.symbol === s)) {
      notifyError(`${s}는 배당 데이터베이스에 없는 종목입니다.`);
      return;
    }
    if (!isFinite(n) || n <= 0) { notifyError('수량을 정확히 입력하세요.'); return; }
    persist([...holdings.filter(h => h.symbol !== s), { symbol: s, shares: n }]);
    setAddSymbol(''); setAddShares('');
  };

  const updateHolding = (symbol: string) => {
    // 수정 경로는 양의 유한 수량만 받는다. 삭제는 별도 버튼 (removeHolding).
    //
    // **왜 분기를 뗐는가 (#778 Codex 3차 재현)**
    // 전에는 n === 0이면 삭제로 해석했다. 그런데 SliderField의 toFixed(5)는
    // step 아래 입력(예: 0.000001)을 0으로 반올린다. 양의 수량 0.000001을
    // 치려던 사용자가 **보유를 조용히 잃는다.** 삭제 의도를 숫자칸과
    // 공유하지 않도록 아예 분리.
    const v = validateHoldingShares(Number(draftShares));
    if (v.ok === false) {
      // 참고: tsconfig strict=false라 discriminated union narrowing이 좁아
      // reason 접근은 any 경유. 이 분기는 ok===false인 variant만 들어온다.
      const reason = (v as { ok: false; reason: 'not-finite' | 'non-positive' }).reason;
      notifyError(reason === 'non-positive'
        ? '수량은 0보다 커야 합니다. 보유를 없애려면 삭제 버튼을 쓰세요.'
        : '수량을 정확히 입력하세요.');
      return;
    }
    persist(holdings.map(h => h.symbol === symbol ? { ...h, shares: v.shares } : h));
    setEditingSymbol(null); setDraftShares('');
  };

  const removeHolding = (symbol: string) => {
    persist(holdings.filter(h => h.symbol !== symbol));
    setEditingSymbol(null); setDraftShares('');
  };

  return (
    <div style={PAGE_STYLE}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
        <IconBox tone="green" size="md"><BadgeDollarSign size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
        <div>
          <div style={F.title}>배당 캘린더</div>
          <div style={F.caption}>다가오는 배당락일 · 예상 수령액 · 연 배당수익 추정</div>
        </div>
      </div>

      <DripSimulator currency={currency} />

      {/* 요약 카드 */}
      <div style={cardStyle({ marginBottom: SP.md })}>
        <div style={{ display: 'flex', gap: SP.md, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={F.caption}>연 예상 배당</div>
            <div style={{ ...F.numL, color: T.grn, marginTop: 2 }}>{formatKRW(totalAnnualKRW)}</div>
            <div style={{ ...F.muted, marginTop: 2 }}>월평균 {formatKRW(monthlyKRW)}</div>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={F.caption}>보유 배당 종목</div>
            <div style={{ ...F.numL, color: T.acl, marginTop: 2 }}>{holdings.length}개</div>
            <div style={{ ...F.muted, marginTop: 2 }}>3개월 내 {upcoming.length}건 배당</div>
          </div>
        </div>
      </div>

      {/* 탭 */}
      <div style={{ display: 'flex', gap: SP.xs, marginBottom: SP.md, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {([
          ['upcoming', '다가오는 배당', CalendarDays],
          ['holdings', '내 배당주',     Briefcase],
          ['all',      '지원 종목',     ListChecks],
        ] as const).map(([id, label, Ic]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ ...buttonStyle('ghost', 'md'), flexShrink: 0,
              background: tab === id ? T.acg : 'transparent',
              color: tab === id ? T.acl : T.sub,
              border: `1px solid ${tab === id ? T.acl : T.border}` }}>
            <Ic size={IC_SIZE.sm} strokeWidth={IC_STROKE} /> {label}
          </button>
        ))}
      </div>

      {/* 다가오는 배당 */}
      {tab === 'upcoming' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm + 2 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 36 }}>
            <input type="checkbox" checked={filterMyOnly} onChange={e => setFilterMyOnly(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span style={F.body}>내 보유 종목만</span>
          </label>

          {(filterMyOnly ? holdingsUpcoming : upcoming).length === 0 ? (
            <div style={cardStyle({ textAlign: 'center', padding: '40px 20px' })}>
              <div style={F.muted}>{filterMyOnly ? '내 보유 배당 종목의 3개월 배당이 없습니다.' : '3개월 배당 일정이 없습니다.'}</div>
            </div>
          ) : (
            (filterMyOnly ? holdingsUpcoming : upcoming).map((d, i) => {
              const days = daysUntil(d.exDate);
              const dayColor = days <= 3 ? T.red : days <= 14 ? T.ylw : T.acl;
              const withPayment = 'paymentKRW' in d ? (d as UpcomingWithPayment) : null;
              return (
                <div key={`${d.symbol}-${i}`} style={cardStyle({ padding: SP.md })}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP.sm + 2 }}>
                    <div style={{ minWidth: 58, textAlign: 'center', padding: 8, background: dayColor + '22', borderRadius: R.md }}>
                      <div style={{ color: dayColor, fontWeight: 900, fontSize: 20 }}>{days}</div>
                      <div style={{ color: dayColor, fontSize: 9, fontWeight: 700 }}>일 남음</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ ...F.section, fontSize: 13 }}>{d.symbol}</span>
                        <span style={{ ...F.muted, fontWeight: 500 }}>{d.name}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4, ...F.caption }}>
                        <span>배당락 {d.exDate.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</span>
                        <span style={{ color: T.muted }}>지급 {d.payDate.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12 }}>
                        <span style={F.muted}>1주당 </span>
                        <span style={{ color: T.txt, fontWeight: 700 }}>{d.currency === 'USD' ? `$${d.paymentPerShare.toFixed(3)}` : `${d.paymentPerShare.toLocaleString()}원`}</span>
                        <span style={{ ...F.muted, marginLeft: 8 }}>· {FREQ_LABEL[d.frequency]} · {d.yieldPct.toFixed(1)}%</span>
                      </div>
                      {withPayment && withPayment.shares > 0 && (
                        <div style={{ marginTop: SP.sm, padding: '10px 12px', background: A(T.grn,'15'), borderRadius: R.md, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={F.muted}>예상 수령액 ({withPayment.shares}주)</span>
                          <span style={{ ...F.numM, color: T.grn }}>{formatKRW(withPayment.paymentKRW)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* 내 배당주 */}
      {tab === 'holdings' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.sm + 2 }}>
          <div style={cardStyle()}>
            <div style={F.section}>＋ 보유 종목 추가/수정</div>
            <div style={{ display: 'flex', gap: 6, marginTop: SP.sm }}>
              <input value={addSymbol} onChange={e => setAddSymbol(e.target.value)} placeholder="심볼 (예: SCHD)" style={{ ...inp, flex: 1 }} />
              <button onClick={addHolding} style={buttonStyle('primary')}>저장</button>
            </div>
            {/* 숫자칸 혼자였을 때는 '100' 칠 자리에 '1000'을 눌러도 알아채기
                어려웠다. 1주당 배당이 크지 않다 보니 10배 입력해도 연배당 숫자가
                "꽤 나오네" 범위에 들어가 지나칠 수 있다. 슬라이더로 감을 잡고,
                숫자칸으로 정확히 넣고, 범위 밖 입력은 SliderField가 자동으로
                clamp해서 들여 보낸다.

                min·max·step·preserveRawNumber 고른 이유 (#778 리뷰 네 차례 반영):
                - `preserveRawNumber` — 숫자칸은 사용자가 친 그대로 저장한다
                  (Codex 4차 재현 "0.000001 → 0.00001로 10배 저장" 차단).
                  slider는 여전히 min·max 안에서만 움직이지만, 숫자칸은 범위
                  밖 양수도 통과시키고 `addHolding`/`updateHolding`이 저장 전에
                  명시 거절한다. 저장 계약의 유한 양수 전부를 보존한다.
                - `step=0.00001` — slider 눈금 자리와 숫자칸 toFixed의 참조.
                  preserveRawNumber와 함께면 숫자칸은 더 작은 소수도 받는다.
                - `min=0.00001`·`max=100_000_000` — slider 물리적 범위. 숫자
                  칸에서 이 밖의 양수를 쳐도 preserveRawNumber가 그대로 통과.
                  silent-delete 방어를 위해 min은 step과 같게 유지 (slider로
                  0에 닿지 못하게; 숫자칸 0은 validateHoldingShares가 거절).

                SliderField의 산식과 preserveRawNumber 분기가 어떤 입력을
                어떤 저장값으로 바꾸는지는 `scripts/test-dividend-sliderfield.mjs`
                가 **실제 SettingField.tsx 소스의 해당 라인을 snapshot으로
                묶어** 값으로 못 박는다. 산식이 바뀌면 그 테스트가 먼저 깨진다. */}
            <div style={{ marginTop: SP.sm }}>
              <SliderField
                label="수량"
                value={addShares === '' ? NaN : Number(addShares)}
                unit="주"
                min={0.00001} max={100_000_000} step={0.00001}
                onChange={v => setAddShares(String(v))}
                preserveRawNumber
                hint="숫자칸은 그대로 저장. 범위 밖/0 이하는 저장 시 안내."
              />
            </div>
            <div style={{ ...F.muted, marginTop: 6 }}>지원 종목 탭에서 사용 가능한 심볼 확인</div>
          </div>

          {annualEsts.length === 0 ? (
            <div style={cardStyle({ textAlign: 'center', padding: '30px 20px' })}>
              <div style={F.muted}>보유 종목을 추가하면 예상 배당이 표시됩니다.</div>
            </div>
          ) : (
            annualEsts.map(est => (
              <div key={est.symbol} style={cardStyle({ padding: SP.md })}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ ...F.section, fontSize: 13 }}>{est.symbol}</span>
                      <span style={{ ...F.muted, fontWeight: 500 }}>{est.name}</span>
                    </div>
                    <div style={{ ...F.caption, marginTop: 4 }}>
                      {est.shares}주 보유 · {FREQ_LABEL[est.frequency]} · {est.yieldPct.toFixed(1)}%
                    </div>
                  </div>
                  <button onClick={() => { setEditingSymbol(est.symbol); setDraftShares(String(est.shares)); }}
                    style={{ ...buttonStyle('ghost', 'sm'), gap: 4 }}>
                    <Pencil size={13} strokeWidth={IC_STROKE} /> 수정
                  </button>
                </div>
                <div style={{ marginTop: SP.sm, padding: '10px 12px', background: A(T.grn,'15'), borderRadius: R.md, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={F.caption}>연 예상 배당</span>
                  <span style={{ ...F.numM, color: T.grn }}>{formatKRW(toKRW(est.annualDividend, est.currency))}</span>
                </div>
                {editingSymbol === est.symbol && (
                  <div style={{ marginTop: 8, padding: SP.sm, background: T.alt, borderRadius: R.md }}>
                    {/* 기본값(= 바꾸기 전 보유 수량)을 같이 적는다. "원래 100주였는데
                        지금 125로 바꿔 놨다"가 한눈에 보인다. 삭제는 **별도
                        버튼**으로 떼어 냈다 — 전에는 "0으로 두고 확인하면 삭제"
                        였는데, SliderField의 toFixed(5)가 양의 소수 0.000001을
                        0으로 반올려 **의도치 않은 삭제**로 이어진다는 걸 Codex
                        3차 재현이 짚었다 (#778 코멘트 7177918783).

                        min=step(0.00001)로 올려 slider가 0에 닿지 않게 하고,
                        숫자칸에서 0을 치더라도 SliderField가 min으로 clamp하므로
                        draftShares는 0이 되지 않는다. 최종 방어는 updateHolding의
                        validateHoldingShares — 그쪽이 n<=0을 거절한다. */}
                    <SliderField
                      label="수량"
                      value={draftShares === '' ? est.shares : Number(draftShares)}
                      base={est.shares}
                      unit="주"
                      min={0.00001} max={100_000_000} step={0.00001}
                      onChange={v => setDraftShares(String(v))}
                      preserveRawNumber
                      hint="숫자칸은 그대로 저장. 삭제는 🗑 버튼."
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: SP.sm }}>
                      <button onClick={() => updateHolding(est.symbol)} style={{ ...buttonStyle('primary'), flex: 1 }}>확인</button>
                      <button onClick={() => { setEditingSymbol(null); setDraftShares(''); }} style={{ ...buttonStyle('ghost'), flex: 1 }}>취소</button>
                      <button onClick={() => removeHolding(est.symbol)}
                        style={{ ...buttonStyle('ghost'), flex: 0, padding: '0 14px',
                                 color: T.red, borderColor: A(T.red, '40') }}
                        title={`${est.symbol} 보유를 목록에서 뺀다`}>🗑</button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* 지원 종목 */}
      {tab === 'all' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ ...F.muted, marginBottom: 4 }}>현재 {DIVIDEND_UNIVERSE.length}개 종목 지원</div>
          {DIVIDEND_UNIVERSE.map(u => (
            <div key={u.symbol} style={{ padding: '12px 14px', background: T.card, border: `1px solid ${T.border}`, borderRadius: R.md, display: 'flex', alignItems: 'center', gap: SP.sm }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ color: T.txt, fontWeight: 700, fontSize: 13 }}>{u.symbol}</span>
                  <span style={{ ...F.muted, fontWeight: 500 }}>{u.name}</span>
                </div>
                <div style={{ ...F.muted, marginTop: 2 }}>
                  {FREQ_LABEL[u.frequency]} · 지급월: {u.payMonths.join(', ')}월
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...F.numS, color: T.grn }}>{u.yieldPct.toFixed(1)}%</div>
                <div style={{ ...F.muted, fontSize: 9 }}>{u.currency}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DividendCalendarPage(props: { currency?: string }) {
  return <ErrorBoundary><DividendInner {...props} /></ErrorBoundary>;
}
