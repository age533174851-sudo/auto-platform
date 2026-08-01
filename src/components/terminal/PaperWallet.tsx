'use client';
// src/components/terminal/PaperWallet.tsx
//
// 모의 계좌 — 잔고 · 충전 · 초기화.
//
// 왜 '충전'이 있는가
// ──────────────────
// 모의는 연습이다. 한 번 날려 먹으면 연습을 못 하게 되는 연습은 의미가
// 없다. 다만 넣은 돈은 **초기자본에 같이 더해진다** — 안 그러면 넣은 돈이
// 수익으로 잡혀 수익률이 부풀려지고, 그 성적표는 아무것도 말해주지 않는다.
// 화면에도 그렇게 적는다.
import React, { useCallback, useEffect, useState } from 'react';
import { C, FS, NUM, ghostBtn, input, fmtPrice, pnlColor } from './theme';
import { useTerminal } from './TerminalContext';

const PRESETS = [1000, 5000, 10000, 50000];

export interface PaperAccount {
  balance: number;
  available: number;
  usedMargin: number;
  initialBalance: number;
  totalPnl: number;
  tradeCount: number;
  returnPct: number | null;
}

/** 모의 계좌를 읽어 오는 훅. 주문판과 지갑판이 같은 값을 보게 한다 */
export function usePaperAccount(enabled: boolean) {
  const { auth } = useTerminal();
  const [acct, setAcct] = useState<PaperAccount | null>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!enabled || !auth) { setAcct(null); return; }
    try {
      const r = await fetch('/api/paper/account', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        // 조회 실패를 잔고 0으로 그리지 않는다. 0은 '돈이 없다'이고
        // 실패는 '모른다'인데, 화면에서는 둘이 똑같이 보인다.
        setAcct(null);
        setErr(j?.message || j?.error || `조회 실패 (${r.status})`);
        return;
      }
      setErr('');
      setAcct(j.account);
      setPositions(Array.isArray(j.positions) ? j.positions : []);
    } catch (e: any) {
      setAcct(null);
      setErr(`모의 계좌를 읽지 못했습니다 (${e?.message || e})`);
    }
  }, [enabled, auth]);

  useEffect(() => {
    load();
    if (!enabled) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, enabled]);

  return { acct, positions, err, reload: load };
}

export function PaperWallet({ dense, acct, err, onChanged }: {
  dense?: boolean;
  acct: PaperAccount | null;
  err?: string;
  onChanged: () => void;
}) {
  const { auth } = useTerminal();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const post = async (payload: Record<string, any>) => {
    if (!auth) { setMsg({ ok: false, text: '로그인이 필요합니다' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/paper/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      setMsg({ ok: !!j?.ok, text: j?.message || j?.error || `실패 (${r.status})` });
      if (j?.ok) { setAmount(''); onChanged(); }
    } catch (e: any) {
      setMsg({ ok: false, text: `실패 (${e?.message || e})` });
    } finally { setBusy(false); }
  };

  const reset = async () => {
    const { confirmDialog } = await import('@/lib/confirm/dialog');
    const okToGo = await confirmDialog(
      [
        '모의 계좌를 10,000 USDT로 초기화합니다.',
        '',
        '잔고·누적손익·거래 횟수가 전부 0에서 다시 시작합니다.',
        '지금까지의 모의 성적은 사라집니다.',
      ].join('\n'), { danger: true });
    if (okToGo) await post({ action: 'reset' });
  };

  return (
    <div style={{
      background: C.raised, borderRadius: 8,
      padding: dense ? '5px 9px' : '10px 12px',
    }}>
      {/* 한 줄 요약 + [＋].
          좁은 화면(dense)에서는 이 한 줄과 오차 표시만 남긴다. 잔고·증거금·
          수익률·충전·초기화를 늘 펼쳐 두면 150px을 먹는데, 그만큼이 아래
          포지션 칸에서 빠진다. 정작 주문 직전에 필요한 값은 '가용' 하나다. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: C.faint, fontSize: FS.micro }}>모의 가용</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{
            ...NUM, color: acct ? C.text : C.warn,
            fontSize: dense ? FS.small : FS.body, fontWeight: 700,
          }}>
            {acct ? `${fmtPrice(acct.available)} USDT` : '확인 불가'}
          </span>
          <button onClick={() => setOpen(v => !v)} title="충전 · 초기화"
            style={{
              width: 26, height: dense ? 24 : 26, borderRadius: 7, flexShrink: 0, lineHeight: 1,
              background: open ? C.accentBg : C.panel,
              color: open ? C.accent : C.dim,
              border: `1px solid ${open ? `${C.accent}55` : C.hair}`,
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}>{open ? '×' : '＋'}</button>
        </div>
      </div>

      {acct && !dense && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: FS.micro }}>
          <span style={{ color: C.faint }}>
            잔고 {fmtPrice(acct.balance)} · 증거금 {fmtPrice(acct.usedMargin)}
          </span>
          <span style={{ ...NUM, color: pnlColor(acct.returnPct) }}>
            {acct.returnPct == null ? '—'
              : `${acct.returnPct >= 0 ? '+' : ''}${acct.returnPct.toFixed(2)}%`}
          </span>
        </div>
      )}

      {/* 오류는 접지 않는다. '확인 불가'만 보이고 이유가 안 보이면
          사용자가 할 수 있는 일이 없어진다. */}
      {err && (
        <div style={{ marginTop: 5, color: C.warn, fontSize: FS.micro, lineHeight: 1.5 }}>{err}</div>
      )}

      {open && (
        <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
          <button onClick={reset} disabled={busy}
            style={{ ...ghostBtn(), flex: 1, minHeight: 28, fontSize: FS.micro }}>
            초기화
          </button>
          {dense && acct && (
            <span style={{
              flex: 1.4, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              ...NUM, fontSize: FS.micro, color: pnlColor(acct.returnPct),
            }}>
              누적 {acct.returnPct == null ? '—'
                : `${acct.returnPct >= 0 ? '+' : ''}${acct.returnPct.toFixed(2)}%`}
            </span>
          )}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 7 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            {PRESETS.map(v => (
              <button key={v} onClick={() => setAmount(String(v))}
                style={{ ...ghostBtn(amount === String(v)), flex: 1, minHeight: 28,
                         fontSize: FS.micro, ...NUM }}>
                {v >= 1000 ? `${v / 1000}k` : v}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <input value={amount} onChange={e => setAmount(e.target.value)}
              inputMode="decimal" placeholder="금액 (USDT)"
              style={{ ...input, flex: 1, minHeight: 32, fontSize: FS.small }}/>
            <button onClick={() => post({ action: 'deposit', amount: Number(amount) })}
              disabled={busy || !(Number(amount) > 0)}
              style={{
                minWidth: 66, minHeight: 32, borderRadius: 7,
                background: C.accentBg, color: C.accent,
                border: `1px solid ${C.accent}55`,
                fontSize: FS.small, fontWeight: 700,
                cursor: busy || !(Number(amount) > 0) ? 'default' : 'pointer',
                opacity: busy || !(Number(amount) > 0) ? 0.5 : 1,
              }}>
              {busy ? '…' : '넣기'}
            </button>
          </div>
          {/* 이 한 줄이 없으면 충전한 돈이 수익으로 보인다 */}
          <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 6, lineHeight: 1.5 }}>
            가상 자금입니다. 넣은 금액은 <b>초기자본에도 더해져</b> 수익률이
            부풀려지지 않습니다.
          </div>
        </div>
      )}

      {msg && (
        <div style={{
          marginTop: 7, padding: '7px 9px', borderRadius: 7,
          background: msg.ok ? C.upBg : C.downBg, color: msg.ok ? C.up : C.down,
          fontSize: FS.micro, lineHeight: 1.5,
        }}>{msg.text}</div>
      )}
    </div>
  );
}
