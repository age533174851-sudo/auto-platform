'use client';
// src/components/terminal/StockOrderPanel.tsx
//
// 주식 주문판. **거래소가 아니라 증권사(한국투자증권)를 탄다.**
//
// 왜 파일을 또 나누는가
// ─────────────────────
// 현물·선물과 같은 이유다. 하나의 폼에 `{isStock ? … : …}`를 흩뿌리면
// 조건 하나를 빠뜨린 자리에 레버리지 입력이 남고, 사용자는 그것을 보고
// 10배를 걸었다고 믿는다. 주식 화면에는 레버리지·청산가·마진모드·펀딩·
// 공매도가 **코드에 없다.** 조건부로 숨기는 것이 아니다.
//
// 그리고 주식에만 있는 것이 둘 있다
// ─────────────────────────────────
//  · **장이 열려 있는가.** 코인은 24시간이라 이 질문이 없다. 주식은
//    닫혀 있으면 주문이 예약으로 남거나 거부되는데, 그 차이를 모르면
//    "넣었는데 안 됐다"가 된다. 그래서 시장 상태를 폼 위에 늘 띄운다.
//  · **연결이 다르다.** 바이낸스 키로는 주문이 안 나간다. 증권사 연결이
//    없으면 **주문 버튼을 만들지 않는다** — 눌리는 버튼을 두고 실패
//    메시지를 띄우는 것보다, 왜 못 누르는지를 먼저 말하는 편이 낫다.
import React, { memo, useEffect, useState } from 'react';
import { C, FS, NUM, input } from './theme';
import { useTerminal } from './TerminalContext';
import { notifyError, notifySuccess } from '@/lib/notify/center';

/** 증권사 연결인가. 주식 주문은 이 연결로만 나간다. */
function isBrokerConn(c: any): boolean {
  return String(c?.exchange_id || '').toLowerCase() === 'kis';
}

export const StockOrderPanel = memo(function StockOrderPanel({ dense }: { dense?: boolean }) {
  const { connections, auth } = useTerminal();

  const brokers = (Array.isArray(connections) ? connections : []).filter(isBrokerConn);
  const [connId, setConnId] = useState('');
  useEffect(() => {
    // 고른 연결이 목록에서 사라지면 비운다. 지운 연결의 id를 들고 있으면
    // '연결 있음'으로 보이는데 주문은 안 나간다.
    if (connId && brokers.some(c => c.id === connId)) return;
    setConnId(brokers[0]?.id || '');
  }, [connId, brokers.map(c => c.id).join(',')]);   // eslint-disable-line

  const [symbol, setSym] = useState('');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [slPct, setSlPct] = useState(3);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [blockers, setBlockers] = useState<any[]>([]);
  const [blockOpen, setBlockOpen] = useState(false);
  const [noAskWhy, setNoAskWhy] = useState('');
  const [hours, setHours] = useState<any>(null);

  const conn = brokers.find(c => c.id === connId) || null;
  // is_testnet === false 만 실전이다. 저장소 전체가 쓰는 규칙이다 —
  // 모르는 값이 실전으로 읽히면 안 된다.
  const isLive = conn?.is_testnet === false;

  const submit = async (want: 'BUY' | 'SELL') => {
    setMsg(null); setBlockers([]); setBlockOpen(false); setNoAskWhy('');
    setSide(want);
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    if (!connId) { setMsg({ ok: false, text: '증권사 연결이 필요합니다' }); return; }
    const code = symbol.trim();
    if (!code) { setMsg({ ok: false, text: '종목 코드를 입력하세요 (예: 005930 · AAPL)' }); return; }
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) { setMsg({ ok: false, text: '수량을 입력하세요' }); return; }
    // 주식 수량은 주(株)다. 0.5주는 없다 — 소수를 보내면 증권사가 거부하는데
    // 그 메시지는 화면에서 원인을 알기 어렵다.
    if (!Number.isInteger(q)) { setMsg({ ok: false, text: '수량은 정수여야 합니다 (1주 단위)' }); return; }
    if (orderType === 'LIMIT' && !(Number(price) > 0)) {
      setMsg({ ok: false, text: '지정가인데 가격이 없습니다' }); return;
    }

    if (isLive) {
      const { confirmDialog } = await import('@/lib/confirm/dialog');
      const ok = await confirmDialog([
        `실전 계좌로 ${code} ${q}주를 ${want === 'BUY' ? '매수' : '매도'}합니다.`,
        orderType === 'LIMIT' ? `지정가 ${price}` : '시장가 — 체결가는 지금 호가와 다를 수 있습니다',
        '',
        '실제 자금이 사용됩니다.',
      ].join('\n'), { title: '실전 주문', confirmText: '네', cancelText: '아니요', danger: true });
      if (!ok) return;
    }

    setBusy(true);
    try {
      const send = (overrideChecks?: string[]) => fetch('/api/stock/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
          connectionId: connId, symbol: code, side: want, orderType,
          quantity: q,
          price: orderType === 'LIMIT' ? Number(price) : undefined,
          // 매도는 나가는 주문이라 손절을 요구하지 않는다.
          stopLossPct: want === 'BUY' ? slPct : undefined,
          overrideChecks,
        }),
      });

      let r = await send();
      let j = await r.json();

      if (r.status === 409 && j?.error === 'checklist_blocked') {
        setBlockers(Array.isArray(j?.checklist?.blockers) ? j.checklist.blockers : []);
        setHours(j?.marketHours ?? null);
        const { overridePrompt } = await import('@/lib/engine/checkOverride');
        const p = overridePrompt(j?.checklist?.blockers, { realMoney: !!isLive });
        if (p.canAsk) {
          const { confirmDialog } = await import('@/lib/confirm/dialog');
          const yes = await confirmDialog(p.text, {
            title: '이대로 주문할까요?', confirmText: '네', cancelText: '아니요', danger: !!isLive,
          });
          if (yes) { r = await send(p.askable.map((b: any) => String(b.id))); j = await r.json(); }
        } else {
          // 왜 안 물어보는지 적는다 — 아무 일도 안 일어나면 고장과 같아 보인다.
          setNoAskWhy(p.whyNoAsk || '');
        }
      }

      if (j?.marketHours) setHours(j.marketHours);

      if (r.ok && j?.ok) {
        const t = j.message || '주문 접수됨';
        setMsg({ ok: true, text: t });
        notifySuccess('주식 주문 접수됨', `${code} ${q}주 · ${t}`);
        setQty('');
      } else {
        const t = j?.message || j?.error || `실패 (${r.status})`;
        setMsg({ ok: false, text: t });
        const first = Array.isArray(j?.checklist?.blockers) ? j.checklist.blockers[0] : null;
        notifyError(r.status === 409 ? '점검이 주문을 막았습니다' : '주식 주문 실패',
          first?.detail ? `${first.label}: ${first.detail}` : t);
      }
    } catch (e: any) {
      // 응답을 못 받았다. 나갔는지 안 나갔는지 모른다.
      const t = `응답 없음 — 재시도 말고 증권사 앱에서 체결 내역을 먼저 확인하세요 (${e?.message || e})`;
      setMsg({ ok: false, text: t });
      notifyError('응답을 못 받았습니다', t);
    } finally { setBusy(false); }
  };

  const pad = dense ? 7 : 12;
  const gap = dense ? 5 : 10;

  // ── 증권사 연결이 없다 ──
  //
  // 여기서 폼을 그리고 버튼만 비활성화하면, 사용자는 종목·수량을 다 채운
  // 뒤에야 못 넣는다는 것을 안다. 먼저 말한다.
  if (brokers.length === 0) {
    return (
      <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{
          padding: '10px 12px', borderRadius: 8, background: C.raised,
          color: C.warn, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>증권사 연결이 없습니다.</b><br/>
          주식 주문은 한국투자증권(KIS) 연결로만 나갑니다 — 바이낸스 키로는
          나가지 않습니다. 아래 <b>증권사</b> 탭에서 먼저 연결하세요.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap }}>

      {/* 어느 계좌인가. 실전이면 눈에 띄게 — 주식은 모의/실전이 화면에서
          똑같이 생겨서, 이 줄이 없으면 실계좌를 모의로 착각한다. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 9px', borderRadius: 8,
        background: isLive ? C.downBg : C.raised,
        border: `1px solid ${isLive ? C.down : C.hair}`,
      }}>
        <span style={{
          fontSize: FS.micro, fontWeight: 800,
          color: isLive ? C.down : C.dim, flexShrink: 0,
        }}>{isLive ? '실전 계좌' : '모의 계좌'}</span>
        <select value={connId} onChange={e => setConnId(e.target.value)}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none',
            outline: 'none', color: C.text, fontSize: FS.micro, fontWeight: 600,
          }}>
          {brokers.map(c => (
            <option key={c.id} value={c.id}>
              {c.label || c.exchange_id} {c.is_testnet === false ? '· 실전' : '· 모의'}
            </option>
          ))}
        </select>
      </div>

      {/* 장이 열려 있는가. **주식에만 있는 질문이다.**
          주문을 한 번 눌러 봐야 아는 것이 아니라 폼 위에 늘 떠 있어야 한다. */}
      {hours && (
        <div style={{
          padding: '7px 9px', borderRadius: 8, fontSize: FS.micro, lineHeight: 1.5,
          background: hours.canOrder ? C.raised : C.downBg,
          color: hours.canOrder ? C.dim : C.down,
        }}>
          {hours.reason || (hours.canOrder ? '장중' : '장 마감')}
          {hours.holidaysKnown === false && (
            <span style={{ color: C.warn }}> · 휴장일 목록이 없어 임시휴장은 판단하지 못합니다</span>
          )}
        </div>
      )}

      {/* 종목 코드. 이름 검색은 아직 없다 — 없는 것을 있는 척하지 않는다. */}
      <input value={symbol} onChange={e => setSym(e.target.value.toUpperCase())}
        placeholder="종목 코드 (005930 · AAPL)"
        style={{ ...input, padding: '9px 11px', fontSize: dense ? FS.small : FS.body }}/>

      {/* 시장가 / 지정가 */}
      <div style={{ display: 'flex', gap: 5 }}>
        {(['MARKET', 'LIMIT'] as const).map(t => (
          <button key={t} onClick={() => setOrderType(t)} style={{
            flex: 1, minHeight: 32, borderRadius: 7, cursor: 'pointer',
            background: orderType === t ? C.raised : 'transparent',
            color: orderType === t ? C.text : C.dim,
            border: `1px solid ${orderType === t ? C.hair2 : C.hair}`,
            fontSize: FS.micro, fontWeight: 700,
          }}>{t === 'MARKET' ? '시장가' : '지정가'}</button>
        ))}
      </div>

      {orderType === 'LIMIT' && (
        <input value={price} onChange={e => setPrice(e.target.value)}
          placeholder="지정가" inputMode="decimal"
          style={{ ...input, padding: '9px 11px', ...NUM }}/>
      )}

      {/* 수량 — 주 단위. 소수는 없다 */}
      <div style={{
        display: 'flex', alignItems: 'center', background: C.raised,
        border: `1px solid ${C.hair}`, borderRadius: 8, overflow: 'hidden',
      }}>
        <input value={qty}
          onChange={e => setQty(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="수량" inputMode="numeric"
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: C.text, padding: '9px 11px', fontSize: dense ? FS.small : FS.body, ...NUM,
          }}/>
        <span style={{
          padding: '0 10px', color: C.dim, fontSize: FS.micro, fontWeight: 600,
          borderLeft: `1px solid ${C.hair}`, lineHeight: '34px',
        }}>주</span>
      </div>

      {/* 손절 폭 — 매수에만. 서버가 이 값으로 종목 배수를 반영해 크기를 잡는다
          (3배 ETF에 일반 주식과 같은 손절을 걸면 3배 자주 걸린다). */}
      {side === 'BUY' && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ color: C.faint, fontSize: FS.micro, flexShrink: 0 }}>손절</span>
          {[2, 3, 5, 7, 10].map(p => (
            <button key={p} onClick={() => setSlPct(p)} style={{
              flex: 1, minHeight: 26, borderRadius: 6, cursor: 'pointer',
              background: slPct === p ? C.accentBg : C.raised,
              color: slPct === p ? C.accent : C.dim,
              border: `1px solid ${slPct === p ? C.accent : C.hair}`,
              fontSize: FS.micro, fontWeight: 700, ...NUM,
            }}>{p}%</button>
          ))}
        </div>
      )}

      {/* 막은 이유 — 선물 주문판과 같은 규칙으로 접어 둔다 */}
      {blockers.length > 0 && (
        <div style={{ borderRadius: 8, background: C.downBg, overflow: 'hidden' }}>
          <button onClick={() => setBlockOpen(v => !v)} style={{
            width: '100%', background: 'none', border: 'none', cursor: 'pointer',
            padding: '9px 10px', display: 'flex', gap: 8, alignItems: 'center',
            textAlign: 'left', color: 'inherit',
          }}>
            <span style={{ color: C.down, fontWeight: 900, fontSize: FS.micro }}>✕</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: FS.micro, lineHeight: 1.45 }}>
              <b style={{ color: C.down }}>{blockers.length}개가 막고 있습니다</b>
              <span style={{
                display: 'block', color: C.faint, marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {blockers[0]?.label} — {blockers[0]?.status === 'unknown' ? '확인 못 함' : '조건 불일치'}
              </span>
            </span>
            <span style={{ color: C.faint, fontSize: FS.micro }}>{blockOpen ? '접기 ▲' : '자세히 ▼'}</span>
            <span onClick={(e) => { e.stopPropagation(); setBlockers([]); setNoAskWhy(''); }}
              role="button" aria-label="닫기"
              style={{ color: C.faint, fontSize: FS.body, lineHeight: 1, padding: '0 2px' }}>×</span>
          </button>

          {noAskWhy && (
            <div style={{
              margin: '0 10px 9px', padding: '7px 9px', borderRadius: 7,
              background: C.raised, color: C.warn, fontSize: FS.micro, lineHeight: 1.5,
            }}>확인창을 띄우지 않았습니다 — {noAskWhy}</div>
          )}

          {blockOpen && (
            <div style={{
              padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 7,
              maxHeight: '40vh', overflowY: 'auto',
            }}>
              {blockers.map((b: any, i: number) => (
                <div key={b?.id ?? i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                  <span style={{
                    color: b?.status === 'unknown' ? C.faint : C.down,
                    fontWeight: 900, fontSize: FS.micro, width: 10, flexShrink: 0, lineHeight: 1.5,
                  }}>{b?.status === 'unknown' ? '?' : '✕'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.text, fontSize: FS.micro, fontWeight: 700 }}>
                      {b?.label}
                      <span style={{ marginLeft: 5, color: b?.status === 'unknown' ? C.faint : C.down, fontWeight: 600 }}>
                        {b?.status === 'unknown' ? '확인 못 함' : '조건 불일치'}
                      </span>
                    </div>
                    <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 2, lineHeight: 1.5 }}>
                      {b?.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {msg && (
        <div style={{
          padding: '8px 10px', borderRadius: 8,
          background: msg.ok ? C.upBg : C.downBg,
          color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}

      {/* 매수·매도를 나란히. 방향 토글을 두지 않는 이유는 선물과 같다 —
          '매도로 맞춰놨다고 믿었는데 매수가 나가는' 사고는 화면만 봐서는
          예방되지 않는다. 누른 버튼이 방향이다.
          **공매도는 없다** — 이 경로는 현금 매수·매도만 낸다. */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => submit('BUY')} disabled={busy} style={{
          flex: 1, minHeight: 44, borderRadius: 8, border: 'none',
          cursor: busy ? 'default' : 'pointer', opacity: busy ? .5 : 1,
          background: C.up, color: '#fff', fontSize: FS.small, fontWeight: 800,
        }}>{busy && side === 'BUY' ? '보내는 중…' : '매수'}</button>
        <button onClick={() => submit('SELL')} disabled={busy} style={{
          flex: 1, minHeight: 44, borderRadius: 8, border: 'none',
          cursor: busy ? 'default' : 'pointer', opacity: busy ? .5 : 1,
          background: C.down, color: '#fff', fontSize: FS.small, fontWeight: 800,
        }}>{busy && side === 'SELL' ? '보내는 중…' : '매도'}</button>
      </div>

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
        이 경로는 <b>현금 매수·매도</b>만 냅니다. 공매도·신용은 지원하지 않습니다.
        종목 코드로 시장을 판단하며, 모르는 코드는 주문하지 않고 멈춥니다.
      </div>
    </div>
  );
});
