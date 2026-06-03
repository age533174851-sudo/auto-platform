'use client';
import React, { useState, useMemo } from 'react';
import {
  Brain, Target, Calendar, BadgeDollarSign, SlidersHorizontal,
  Tag, Rocket, ChartPie, TrendingUp, ChartLine, TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from '@/components/pages/ErrorBoundary';
import { formatKRW } from '@/lib/format';
import {
  generatePortfolio,
  RISK_LABEL, THEME_LABEL, HORIZON_LABEL,
} from '@/lib/accounts/aiPortfolio';
import type { AIPortfolioInput, AIPortfolioResult, RiskProfile, Theme, Horizon } from '@/lib/accounts/aiPortfolio';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';

const CAT_COLOR: Record<string, string> = {
  us_stock: '#60A5FA', us_etf: '#3B82F6', kr_stock: '#F59E0B', kr_etf: '#FB923C',
  crypto: '#F0B90B', cash: '#94A3B8', bond: '#10B981',
};

const inp: React.CSSProperties = {
  width: '100%', padding: '12px 14px', minHeight: 48,
  background: T.alt, border: `1px solid ${T.border}`, borderRadius: R.md,
  color: T.txt, fontSize: 14, boxSizing: 'border-box',
};

function Donut({ items, size = 180 }: { items: { weight: number; color: string }[]; size?: number }) {
  const safe = Array.isArray(items) ? items : [];
  const cx = size/2, cy = size/2, r = size/2 - 14, stroke = 22;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.alt} strokeWidth={stroke} />
      {safe.map((d, i) => {
        const len = C * (d.weight/100);
        const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color} strokeWidth={stroke} strokeDasharray={`${len} ${C-len}`} strokeDashoffset={-offset} />;
        offset += len;
        return el;
      })}
    </svg>
  );
}

function ProjChart({ data, goal }: { data: AIPortfolioResult['projection']; goal: number }) {
  const safe = Array.isArray(data) ? data : [];
  if (safe.length === 0) return null;
  const maxY = Math.max(...safe.map(d => d.optimistic), goal || 0);
  const W = 320, H = 160, padL = 8, padR = 8, padT = 8, padB = 18;
  const xFor = (i: number) => padL + (i / (safe.length - 1 || 1)) * (W - padL - padR);
  const yFor = (v: number) => padT + (1 - v / (maxY || 1)) * (H - padT - padB);

  const path = (key: 'expected'|'conservative'|'optimistic') =>
    safe.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(d[key])}`).join(' ');

  const areaPath =
    `M ${xFor(0)} ${yFor(safe[0].conservative)} ` +
    safe.map((d, i) => `L ${xFor(i)} ${yFor(d.optimistic)}`).join(' ') + ' ' +
    safe.slice().reverse().map((d, i) => `L ${xFor(safe.length-1-i)} ${yFor(d.conservative)}`).join(' ') + ' Z';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 160 }}>
      <path d={areaPath} fill={T.acl} fillOpacity={0.12} />
      <path d={path('optimistic')}   fill="none" stroke={T.grn} strokeWidth={1.2} strokeDasharray="4 3" />
      <path d={path('expected')}     fill="none" stroke={T.acl} strokeWidth={2.4} />
      <path d={path('conservative')} fill="none" stroke={T.ylw} strokeWidth={1.2} strokeDasharray="4 3" />
      {goal > 0 && goal <= maxY && (
        <line x1={padL} x2={W-padR} y1={yFor(goal)} y2={yFor(goal)} stroke={T.red} strokeWidth={1} strokeDasharray="3 3" />
      )}
    </svg>
  );
}

const RISKS: RiskProfile[]   = ['conservative','balanced','aggressive','extreme'];
const THEMES: Theme[]        = ['ai_semi','us_tech','dividend','crypto','broad_etf','kr_growth'];
const HORIZONS: Horizon[]    = ['1y','3y','5y','10y'];

function AIPortfolioInner() {
  const [goal,    setGoal]    = useState(100_000_000);
  const [horizon, setHorizon] = useState<Horizon>('5y');
  const [monthly, setMonthly] = useState(1_000_000);
  const [risk,    setRisk]    = useState<RiskProfile>('aggressive');
  const [themes,  setThemes]  = useState<Theme[]>(['ai_semi','us_tech','crypto']);
  const [riskTol, setRiskTol] = useState(60);
  const [result,  setResult]  = useState<AIPortfolioResult | null>(null);

  const toggleTheme = (t: Theme) => {
    setThemes(prev => Array.isArray(prev) && prev.includes(t) ? prev.filter(x => x !== t) : [...(prev||[]), t]);
  };

  const onGenerate = () => {
    const input: AIPortfolioInput = {
      goalAmount: goal, horizon, monthly, risk,
      themes: themes.length > 0 ? themes : ['broad_etf'],
      riskTolerance: riskTol,
    };
    try { setResult(generatePortfolio(input)); }
    catch (e) { console.error('[ai-portfolio] generate', e); setResult(null); }
  };

  const donutData = useMemo(() => {
    if (!result) return [];
    return (Array.isArray(result.allocations) ? result.allocations : []).map(a => ({
      weight: a.weight, color: CAT_COLOR[a.category] || T.acl,
    }));
  }, [result]);

  return (
    <div style={PAGE_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
        <IconBox tone="purple" size="md"><Brain size={IC_SIZE.md} strokeWidth={IC_STROKE} /></IconBox>
        <div>
          <div style={F.title}>AI 추천 포트폴리오</div>
          <div style={F.caption}>목표 · 성향 · 월투자금 입력 → 분산 자산 배분</div>
        </div>
      </div>

      {/* 입력 폼 */}
      <div style={cardStyle({ marginBottom: SP.md })}>
        <Field Icon={Target} label="목표 금액 (KRW)">
          <input type="number" value={goal} onChange={e => setGoal(Number(e.target.value)||0)} style={inp} />
          <div style={{ ...F.muted, marginTop: 4 }}>{formatKRW(goal)}</div>
        </Field>

        <Field Icon={Calendar} label="투자 기간">
          <SegGroup options={HORIZONS.map(h => ({ id: h, label: HORIZON_LABEL[h] }))}
            value={horizon} onChange={v => setHorizon(v as Horizon)} />
        </Field>

        <Field Icon={BadgeDollarSign} label="월 투자금 (KRW)">
          <input type="number" value={monthly} onChange={e => setMonthly(Number(e.target.value)||0)} style={inp} />
          <div style={{ ...F.muted, marginTop: 4 }}>{formatKRW(monthly)}</div>
        </Field>

        <Field Icon={SlidersHorizontal} label="투자 성향">
          <SegGroup options={RISKS.map(r => ({ id: r, label: RISK_LABEL[r] }))}
            value={risk} onChange={v => setRisk(v as RiskProfile)} />
        </Field>

        <Field Icon={SlidersHorizontal} label={`위험 허용도: ${riskTol}`}>
          <input type="range" min={0} max={100} value={riskTol}
            onChange={e => setRiskTol(Number(e.target.value)||0)}
            style={{ width: '100%', accentColor: T.acl }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', ...F.muted, marginTop: 2 }}>
            <span>안전 우선</span><span>수익 우선</span>
          </div>
        </Field>

        <Field Icon={Tag} label="선호 자산 (복수 선택)">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>
            {THEMES.map(t => {
              const active = themes.includes(t);
              return (
                <button key={t} onClick={() => toggleTheme(t)} style={{
                  ...buttonStyle('ghost', 'md'),
                  fontSize: 12,
                  background: active ? T.acg : T.alt,
                  border: `1px solid ${active ? T.acl : T.border}`,
                  color: active ? T.acl : T.txt,
                }}>
                  {THEME_LABEL[t]}
                </button>
              );
            })}
          </div>
        </Field>

        <button onClick={onGenerate} style={{ ...buttonStyle('primary', 'lg'), width: '100%', gap: 8, fontSize: 14, marginTop: 4 }}>
          <Rocket size={16} strokeWidth={IC_STROKE} /> 추천 받기
        </button>
      </div>

      {/* 결과 */}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.md }}>
          <div style={cardStyle()}>
            <div style={{ display: 'flex', gap: SP.lg, alignItems: 'center' }}>
              <Donut items={donutData} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={F.caption}>예상 연수익률</div>
                <div style={{ ...F.numXL, color: T.grn }}>+{result.expectedAnnualReturn.toFixed(1)}%</div>
                <div style={{ ...F.caption, marginTop: 8 }}>변동성</div>
                <div style={{ ...F.numM, color: T.ylw }}>{result.expectedVolatility.toFixed(0)}%</div>
                <div style={{ ...F.caption, marginTop: 8 }}>위험점수</div>
                <div style={F.numM}>{result.riskScore} / 10</div>
              </div>
            </div>
            <div style={{ ...F.muted, marginTop: SP.sm + 2, lineHeight: 1.5 }}>{result.summary}</div>
          </div>

          <div style={cardStyle()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.sm }}>
              <IconBox tone="blue" size="sm"><ChartLine size={IC_SIZE.sm} strokeWidth={IC_STROKE} /></IconBox>
              <div style={F.section}>{HORIZON_LABEL[horizon]} 시뮬레이션</div>
            </div>
            <ProjChart data={result.projection} goal={goal} />
            <div style={{ display: 'flex', gap: 10, marginTop: 6, ...F.muted }}>
              <span><span style={{ color: T.grn }}>━</span> 낙관</span>
              <span><span style={{ color: T.acl }}>━</span> 기대</span>
              <span><span style={{ color: T.ylw }}>━</span> 보수</span>
              {goal > 0 && <span><span style={{ color: T.red }}>━</span> 목표</span>}
            </div>
            {result.projection.length > 0 && (() => {
              const last = result.projection[result.projection.length - 1];
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginTop: SP.sm + 2 }}>
                  <MiniStat label="원금"          value={formatKRW(last.principal)} />
                  <MiniStat label="기대 자산"     value={formatKRW(last.expected)}     color={T.acl} />
                  <MiniStat label="보수 시나리오" value={formatKRW(last.conservative)} color={T.ylw} />
                  <MiniStat label="낙관 시나리오" value={formatKRW(last.optimistic)}   color={T.grn} />
                </div>
              );
            })()}
            {result.monthsToGoal !== null && (
              <div style={{ marginTop: SP.sm + 2, padding: SP.sm + 2, background: T.acg, borderRadius: R.md, color: T.acl, fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Target size={14} strokeWidth={IC_STROKE} />
                목표 달성 예상: {Math.floor(result.monthsToGoal/12)}년 {result.monthsToGoal % 12}개월
              </div>
            )}
          </div>

          {/* 종목별 비중 */}
          <div style={cardStyle()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.sm }}>
              <IconBox tone="blue" size="sm"><ChartPie size={IC_SIZE.sm} strokeWidth={IC_STROKE} /></IconBox>
              <div style={F.section}>추천 종목별 비중</div>
            </div>
            {(Array.isArray(result.allocations) ? result.allocations : []).map(a => (
              <div key={a.symbol} style={{ padding: '12px 14px', background: T.alt, borderRadius: R.md, marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: CAT_COLOR[a.category] || T.acl, flexShrink: 0 }} />
                  <span style={{ color: T.txt, fontWeight: 800, fontSize: 13 }}>{a.symbol}</span>
                  <span style={{ color: T.muted, fontSize: 11, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{a.name}</span>
                  <span style={{ color: CAT_COLOR[a.category] || T.acl, fontWeight: 900, fontSize: 15 }}>{a.weight}%</span>
                </div>
                <div style={{ height: 4, background: T.bg, borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${a.weight}%`, height: '100%', background: CAT_COLOR[a.category] || T.acl }} />
                </div>
                <div style={{ ...F.muted, marginTop: 6 }}>{a.rationale}</div>
              </div>
            ))}
          </div>

          {/* 경고 */}
          {Array.isArray(result.warnings) && result.warnings.length > 0 && (
            <div style={{ ...cardStyle(), background: T.ylw + '12', border: `1px solid ${T.ylw}55` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: 6 }}>
                <TriangleAlert size={IC_SIZE.sm} strokeWidth={IC_STROKE} color={T.ylw} />
                <div style={{ ...F.section, color: T.ylw }}>알아두기</div>
              </div>
              {result.warnings.map((w, i) => (
                <div key={i} style={{ ...F.muted, marginTop: 4, lineHeight: 1.5 }}>• {w}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 보조
function Field({ Icon, label, children }: { Icon?: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: SP.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {Icon && <Icon size={13} strokeWidth={IC_STROKE} color={T.sub} />}
        <span style={F.caption}>{label}</span>
      </div>
      {children}
    </div>
  );
}

function SegGroup({ options, value, onChange }: { options: { id: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map(o => {
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            ...buttonStyle('ghost', 'md'), flex: '1 1 60px',
            background: active ? T.acg : T.alt,
            border: `1px solid ${active ? T.acl : T.border}`,
            color: active ? T.acl : T.txt,
          }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: 10, background: T.alt, borderRadius: R.sm + 2 }}>
      <div style={F.muted}>{label}</div>
      <div style={{ ...F.numS, color: color || T.txt, marginTop: 3 }}>{value}</div>
    </div>
  );
}

export default function AIPortfolioPage() {
  return <ErrorBoundary><AIPortfolioInner /></ErrorBoundary>;
}
