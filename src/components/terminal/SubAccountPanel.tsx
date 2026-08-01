'use client';
// src/components/terminal/SubAccountPanel.tsx
//
// 가상 서브계좌 — 배분표를 **한도로 만든다.**
//
// 바로 위 배분표는 계산만 한다. 여기서 만든 바구니는 주문 경로의 체크리스트
// (SUBACCOUNT_LIMIT)가 읽어서 **실제로 막는다.** 그래서 이 화면은 두 가지를
// 반드시 보여줘야 한다:
//
//   · 이 설정이 지금 **켜져 있는지** (바구니가 하나라도 있으면 켜진 것이다)
//   · 이 설정 때문에 **무엇이 막히게 되는지**
//
// 두 번째가 특히 중요하다. USDM 바구니 하나만 만들면 현물 주문은 맡는
// 바구니가 없어서 전부 막힌다. 만들 때는 "선물 한도를 정했다"고 생각하지만
// 실제로는 **현물 매수를 꺼 버린 것**이다. 그 사실을 저장 전에 화면이
// 말해 주지 않으면, 사용자는 다음 주문이 막힌 다음에야 알게 된다.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { C, FS, NUM, ghostBtn, input as inputStyle, chip } from './theme';
import { useTerminal } from './TerminalContext';
import { pickAccount, type SubAccount } from '@/lib/portfolio/subAccount';

const MARKETS: Array<{ id: string; label: string }> = [
  { id: 'SPOT', label: '현물' },
  { id: 'USDM', label: 'USDT 선물' },
  { id: 'COINM', label: 'COIN-M' },
];

interface Row extends SubAccount {
  note?: string | null;
  sortOrder?: number;
}

interface Draft {
  id: string | null;
  name: string;
  allocatedUsd: string;
  markets: string[];
  symbolPrefixes: string;
  note: string;
  sortOrder: string;
}

const emptyDraft = (sortOrder: number): Draft => ({
  id: null, name: '', allocatedUsd: '', markets: [], symbolPrefixes: '',
  note: '', sortOrder: String(sortOrder),
});

const toDraft = (r: Row): Draft => ({
  id: r.id,
  name: r.name,
  // 미설정을 '0'으로 그리지 않는다 — 화면에서 0으로 보이면 저장할 때
  // 진짜 0이 되고, 그 바구니의 주문이 전부 막힌다.
  allocatedUsd: r.allocatedUsd == null ? '' : String(r.allocatedUsd),
  markets: Array.isArray(r.markets) ? [...r.markets] : [],
  symbolPrefixes: (r.symbolPrefixes ?? []).join(', '),
  note: r.note ?? '',
  sortOrder: String(r.sortOrder ?? 0),
});

export function SubAccountPanel() {
  const { auth } = useTerminal();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveErr, setSaveErr] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!auth) { setErr('로그인이 필요합니다'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/portfolio/sub-accounts', { headers: { Authorization: auth } });
      const j = await r.json();
      if (!r.ok || !j?.ok) {
        // 조회 실패를 '바구니 없음'으로 그리지 않는다. 빈 목록은 "이 기능을
        // 안 쓴다"는 뜻인데, 못 읽은 것도 화면에서는 똑같이 비어 보인다.
        setRows(null);
        setErr(j?.message || j?.error || `조회 실패 (${r.status})`);
        return;
      }
      setErr('');
      setRows(Array.isArray(j.accounts) ? j.accounts : []);
    } catch (e: any) {
      setRows(null);
      setErr(`서브계좌를 읽지 못했습니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  }, [auth]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!draft || !auth) return;
    setBusy(true); setSaveErr('');
    try {
      const body = {
        id: draft.id ?? undefined,
        name: draft.name,
        allocatedUsd: draft.allocatedUsd,
        markets: draft.markets,
        symbolPrefixes: draft.symbolPrefixes.split(',').map(s => s.trim()).filter(Boolean),
        note: draft.note,
        sortOrder: draft.sortOrder,
      };
      const r = await fetch('/api/portfolio/sub-accounts', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setSaveErr(j?.message || j?.error || `저장 실패 (${r.status})`); return; }
      setDraft(null);
      await load();
    } catch (e: any) {
      setSaveErr(`저장하지 못했습니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  };

  const del = async (id: string) => {
    if (!auth) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/portfolio/sub-accounts?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Authorization: auth },
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(j?.message || j?.error || `삭제 실패 (${r.status})`); return; }
      setConfirmDel(null);
      await load();
    } catch (e: any) {
      setErr(`삭제하지 못했습니다 (${e?.message || e})`);
    } finally { setBusy(false); }
  };

  // 저장하면 **무엇이 막히는가**. 목록이 아니라 결과를 보여준다.
  //
  // 편집 중이면 편집본을 목록에 얹어서 계산한다 — "저장 후에 이렇게 된다"를
  // 저장 전에 보여줘야 의미가 있다.
  const blocked = useMemo(() => {
    if (!rows) return [];
    const list: SubAccount[] = rows.map(r => ({
      id: r.id, name: r.name, allocatedUsd: r.allocatedUsd,
      markets: r.markets, symbolPrefixes: r.symbolPrefixes,
    }));
    if (draft) {
      const d: SubAccount = {
        id: draft.id ?? '__new__', name: draft.name || '(새 계정)',
        allocatedUsd: draft.allocatedUsd === '' ? null : Number(draft.allocatedUsd),
        markets: draft.markets,
        symbolPrefixes: draft.symbolPrefixes.split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      };
      const i = list.findIndex(x => x.id === d.id);
      if (i >= 0) list[i] = d; else list.push(d);
    }
    if (list.length === 0) return [];
    // 시장마다 대표 종목 하나로 물어본다. 맡는 바구니가 없으면 그 시장의
    // 진입 주문은 전부 'unassigned'로 막힌다.
    const probe: Array<[string, string, string]> = [
      ['SPOT', 'BTCUSDT', '현물'],
      ['USDM', 'BTCUSDT', 'USDT 선물'],
      ['COINM', 'BTCUSD_PERP', 'COIN-M'],
    ];
    return probe.filter(([m, s]) => !pickAccount(list, m, s)).map(([, , label]) => label);
  }, [rows, draft]);

  const noLimit = useMemo(
    () => (rows ?? []).filter(r => r.allocatedUsd == null).map(r => r.name),
    [rows]);

  if (err) {
    return (
      <div style={{ padding: '10px 0' }}>
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: C.warnBg, color: C.warn, fontSize: FS.small, lineHeight: 1.55,
        }}>{err}</div>
        <button onClick={load} style={{ ...ghostBtn(), marginTop: 8, minHeight: 30 }}>다시 시도</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* 켜졌는가 / 꺼졌는가. 안전장치는 상태가 먼저 보여야 한다 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <span style={chip(
          rows && rows.length > 0 ? C.up : C.dim,
          rows && rows.length > 0 ? undefined : undefined)}>
          {rows == null ? '확인 중' : rows.length > 0 ? `한도 작동 중 · ${rows.length}개` : '사용 안 함'}
        </span>
        <span style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.5 }}>
          바구니를 하나라도 만들면 주문 전 검사에 한도가 걸립니다.
        </span>
      </div>

      {/* **저장하면 무엇이 막히는가.** 이 경고가 이 화면의 핵심이다 */}
      {blocked.length > 0 && (
        <div style={{
          padding: '9px 11px', borderRadius: 7,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>{blocked.join(' · ')}</b> 진입이 막힙니다 — 이 시장을 맡는 바구니가 없습니다.<br/>
          시장을 하나도 고르지 않은 바구니를 하나 두면 나머지를 전부 받습니다.
        </div>
      )}
      {noLimit.length > 0 && (
        <div style={{
          padding: '9px 11px', borderRadius: 7,
          background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.6,
        }}>
          <b>{noLimit.join(' · ')}</b>에 배정 금액이 없습니다 — 금액을 정할 때까지
          그 바구니의 진입은 '확인 못 함'으로 막힙니다. (빈 값은 한도 없음이 아니라 미설정입니다)
        </div>
      )}

      {/* 목록 */}
      {(rows ?? []).map(r => (
        <div key={r.id} style={{
          background: C.raised, borderRadius: 8, padding: '9px 11px',
          border: `1px solid ${r.allocatedUsd == null ? `${C.warn}55` : C.hair}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: C.text, fontSize: FS.small, fontWeight: 700 }}>{r.name}</span>
            <span style={{ ...NUM, fontSize: FS.small, fontWeight: 700, color: r.allocatedUsd == null ? C.warn : C.text }}>
              {r.allocatedUsd == null ? '금액 미설정' : `${r.allocatedUsd.toLocaleString()} USDT`}
            </span>
          </div>
          <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>
            {(r.markets ?? []).length ? (r.markets ?? []).map(m => MARKETS.find(x => x.id === m)?.label ?? m).join(' · ') : '모든 시장'}
            {' / '}
            {(r.symbolPrefixes ?? []).length ? (r.symbolPrefixes ?? []).join(' · ') : '모든 종목'}
            {r.note ? ` · ${r.note}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
            <button onClick={() => { setSaveErr(''); setDraft(toDraft(r)); }}
              style={{ ...ghostBtn(), minHeight: 28 }}>고치기</button>
            {confirmDel === r.id ? (
              <>
                <button onClick={() => del(r.id)} disabled={busy}
                  style={{ ...ghostBtn(), minHeight: 28, color: C.down, borderColor: `${C.down}55` }}>
                  정말 지웁니다
                </button>
                <button onClick={() => setConfirmDel(null)} style={{ ...ghostBtn(), minHeight: 28 }}>취소</button>
              </>
            ) : (
              <button onClick={() => setConfirmDel(r.id)} style={{ ...ghostBtn(), minHeight: 28 }}>지우기</button>
            )}
          </div>
        </div>
      ))}

      {/* 편집 */}
      {draft ? (
        <div style={{
          background: C.panel, border: `1px solid ${C.hair2}`, borderRadius: 9, padding: 11,
          display: 'flex', flexDirection: 'column', gap: 9,
        }}>
          <Field label="이름">
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="성장 / 안정 / 실험" style={inputStyle}/>
          </Field>

          <Field label="배정 금액 (USDT)"
            hint="비워 두면 '미설정'입니다 — 한도 없음이 아니라, 정할 때까지 그 바구니의 진입이 막힙니다.">
            <input value={draft.allocatedUsd} inputMode="decimal"
              onChange={e => setDraft({ ...draft, allocatedUsd: e.target.value })}
              placeholder="예: 6000" style={inputStyle}/>
          </Field>

          <Field label="맡을 시장" hint="아무것도 고르지 않으면 모든 시장을 받습니다.">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {MARKETS.map(m => {
                const on = draft.markets.includes(m.id);
                return (
                  <button key={m.id} type="button" onClick={() => setDraft({
                    ...draft,
                    markets: on ? draft.markets.filter(x => x !== m.id) : [...draft.markets, m.id],
                  })} style={{ ...ghostBtn(on), minHeight: 30 }}>{m.label}</button>
                );
              })}
            </div>
          </Field>

          <Field label="맡을 종목 접두사"
            hint="쉼표로 구분합니다 (BTC, ETH). 비워 두면 모든 종목. 종목까지 정한 바구니가 시장만 정한 것보다 우선합니다.">
            <input value={draft.symbolPrefixes}
              onChange={e => setDraft({ ...draft, symbolPrefixes: e.target.value })}
              placeholder="BTC, ETH" style={inputStyle}/>
          </Field>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label="메모">
                <input value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })}
                  style={inputStyle}/>
              </Field>
            </div>
            <div style={{ width: 92 }}>
              <Field label="순서" hint="작을수록 먼저">
                <input value={draft.sortOrder} inputMode="numeric"
                  onChange={e => setDraft({ ...draft, sortOrder: e.target.value })}
                  style={inputStyle}/>
              </Field>
            </div>
          </div>

          {saveErr && (
            <div style={{
              padding: '8px 10px', borderRadius: 7,
              background: C.warnBg, color: C.warn, fontSize: FS.micro, lineHeight: 1.55,
            }}>{saveErr}</div>
          )}

          <div style={{ display: 'flex', gap: 7 }}>
            <button onClick={save} disabled={busy}
              style={{ ...ghostBtn(true), flex: 1, minHeight: 34, opacity: busy ? 0.5 : 1 }}>
              {busy ? '저장 중…' : draft.id ? '저장' : '만들기'}
            </button>
            <button onClick={() => { setDraft(null); setSaveErr(''); }}
              style={{ ...ghostBtn(), minHeight: 34 }}>취소</button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setSaveErr(''); setDraft(emptyDraft((rows ?? []).length)); }}
          style={{ ...ghostBtn(), minHeight: 32 }}>+ 서브계좌 추가</button>
      )}

      <div style={{ color: C.faint, fontSize: FS.micro, lineHeight: 1.6 }}>
        세는 것은 <b>증거금</b>입니다 — 명목가가 아닙니다. 5배로 100을 열면 20을 쓴 것으로 셉니다.
        사용액은 주문 직전에 열린 포지션으로 계산합니다.
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: C.dim, fontSize: FS.micro, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ color: C.faint, fontSize: FS.micro, marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}
