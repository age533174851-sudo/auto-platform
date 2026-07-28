'use client';
import { A } from '@/lib/theme/colors';
// AssetDetailModal — 종목 카드 탭 시 뜨는 상세 팝업.
// 현재가·금일등락·미니차트·거래량 + [매매하기]/[관심등록]/[AI 분석] 액션.
import React, { useState, useEffect } from 'react';
import { T } from '@/lib/constants';
import { cvt, fmtPct } from '@/lib/utils';
import { Card, Logo, AreaChart, Bdg } from './pages/SharedUI';
import { X, TrendingUp, Star, Sparkles, ArrowUpDown } from 'lucide-react';

const WL_STORE = 'tg_watchlist_v2';

function loadWL(): any[] { if (typeof window === 'undefined') return []; try { return JSON.parse(localStorage.getItem(WL_STORE) || '[]'); } catch { return []; } }
function saveWL(arr: any[]) { try { localStorage.setItem(WL_STORE, JSON.stringify(arr)); } catch {} }

export default function AssetDetailModal({
  asset, currency = 'KRW', logoUrl, prices, onClose, onTrade, onPnL, onNav,
}: {
  asset: any | null;
  currency?: string;
  logoUrl?: string | null;
  /** 실시간 시세 목록. 뉴스처럼 심볼만 아는 화면에서 열면 asset에 가격이 없다 */
  prices?: any[];
  onClose: () => void;
  onTrade?: (a: any) => void;
  onPnL?: (a: any) => void;
  onNav?: (dest: string) => void;
}) {
  const [watched, setWatched] = useState(false);

  useEffect(() => {
    if (!asset) return;
    setWatched(loadWL().some(w => (w.id || w.sym) === (asset.id || asset.sym)));
  }, [asset]);

  if (!asset) return null;

  // 넘어온 asset에 가격이 없을 수 있다. 뉴스 화면은 '관련 종목'으로 심볼만
  // 넘기기 때문이다. 그때 asset.p는 undefined인데, 그대로 그리면 화면에
  // ₩0이 뜬다. 0원짜리 비트코인은 시세가 아니라 고장인데 사용자는 둘을
  // 구분할 수 없다. 실시간 목록에서 다시 찾고, 그래도 없으면 숫자 대신
  // '확인 불가'라고 말한다.
  const key = String(asset.id || asset.sym || '').toUpperCase();
  const live = Array.isArray(prices)
    ? prices.find((x: any) => String(x?.id || x?.sym || '').toUpperCase() === key)
    : null;
  const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
  const pOwn = num(asset.p); const pLive = num(live?.p);
  const px = pOwn != null && pOwn > 0 ? pOwn : (pLive != null && pLive > 0 ? pLive : null);
  const chg = num(asset.c) ?? num(live?.c);
  const vol = asset.v ?? live?.v ?? null;

  const up = Number(chg ?? 0) >= 0;
  const nameKr = asset.nameKr || asset.name || asset.id;
  const sym = asset.sym || asset.id;

  const toggleWatch = () => {
    const wl = loadWL();
    const key = asset.id || asset.sym;
    const exists = wl.some(w => (w.id || w.sym) === key);
    if (exists) { saveWL(wl.filter(w => (w.id || w.sym) !== key)); setWatched(false); }
    else {
      saveWL([{ id: asset.id, sym, nameKr, clr: asset.clr || '#3B82F6', t: asset.t || 'coin', p: asset.p, c: asset.c }, ...wl].slice(0, 100));
      setWatched(true);
    }
  };

  const stat = (label: string, val: string) => (
    <div style={{ flex: 1, background: T.alt, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ color: T.muted, fontSize: 10, marginBottom: 3 }}>{label}</div>
      <div style={{ color: T.txt, fontSize: 13, fontWeight: 700, fontFamily: 'Inter,monospace' }}>{val}</div>
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10050, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, background: T.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTop: `1px solid ${T.border2}`, maxHeight: '90vh', overflowY: 'auto', animation: 'tg-sheet-up .24s ease-out' }}>
        <style>{`@keyframes tg-sheet-up{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>

        {/* 핸들 + 닫기 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: T.border, margin: '0 auto' }} />
          <button onClick={onClose} style={{ position: 'absolute', right: 14, background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><X size={20} color={T.muted} /></button>
        </div>

        <div style={{ padding: '8px 18px 26px' }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <Logo id={asset.id} size={48} clr={asset.clr} name={nameKr} logoUrl={logoUrl} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: T.txt, fontSize: 18, fontWeight: 800 }}>{nameKr}</div>
              <div style={{ color: T.muted, fontSize: 12 }}>{sym}</div>
            </div>
          </div>

          {/* 현재가 + 등락 */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: T.txt, fontSize: 30, fontWeight: 900, fontFamily: 'Inter,monospace', fontVariantNumeric: 'tabular-nums', letterSpacing: -1 }}>{px == null ? '확인 불가' : cvt(px, currency)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ color: chg == null ? T.muted : up ? T.grn : T.red, fontSize: 14, fontWeight: 800 }}>{chg == null ? '—' : fmtPct(chg)}</span>
              <span style={{ color: T.muted, fontSize: 11 }}>금일 등락</span>
            </div>
          </div>

          {/* 미니 차트 */}
          <div style={{ marginBottom: 14, borderRadius: 12, overflow: 'hidden', border: `1px solid ${T.border}` }}>
            <AreaChart color={up ? T.grn : T.red} h={110} up={up} />
          </div>

          {/* 통계 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {stat('거래량', vol != null ? String(vol) : '—')}
            {stat('심볼', String(sym))}
            {stat('유형', asset.t === 'coin' ? '코인' : asset.t === 'stock' ? '해외주식' : asset.t === 'krstock' ? '국내주식' : asset.t === 'etf' ? 'ETF' : '자산')}
          </div>

          {/* 액션 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button onClick={() => { onClose(); onTrade && onTrade(asset); }}
              style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: `linear-gradient(135deg,${T.acc},${T.prp})`, color: '#fff', border: 'none', borderRadius: 13, padding: '15px', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
              <TrendingUp size={18} /> 매매하기
            </button>
            <button onClick={toggleWatch}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: watched ? A(T.ylw,'20') : T.card, color: watched ? T.ylw : T.txt, border: `1px solid ${watched ? A(T.ylw,'50') : T.border}`, borderRadius: 13, padding: '15px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              <Star size={16} fill={watched ? T.ylw : 'none'} color={watched ? T.ylw : T.txt} /> {watched ? '관심됨' : '관심'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {onPnL && (
              <button onClick={() => { onClose(); onPnL(asset); }}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: T.card, color: T.txt, border: `1px solid ${T.border}`, borderRadius: 12, padding: '12px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                <ArrowUpDown size={15} color={T.acl} /> 손익계산기
              </button>
            )}
            {onNav && (
              <button onClick={() => { onClose(); onNav('ai'); }}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: T.card, color: T.txt, border: `1px solid ${T.border}`, borderRadius: 12, padding: '12px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                <Sparkles size={15} color={T.prp} /> AI 분석
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
