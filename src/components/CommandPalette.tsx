'use client';
//
// 빠른 명령 팔레트 (Ctrl/Cmd + K).
//
// 이 파일은 **뷰만** 한다. 무엇을 실행할 수 있는지는 lib/commands/registry,
// 어느 것이 위로 올지는 lib/commands/match이 정한다. 둘 다 테스트가 붙어
// 있고, 이 파일은 그 결과를 그린다.
//
// 위험 등급을 여기서 다시 판단하지 않는 이유
// ─────────────────────────────────────────
// 커맨드를 부르는 창구가 앞으로 여럿(팔레트·단축키·플로팅 버튼)이 된다.
// 창구마다 "이건 확인 받아야 하나"를 판단하면 그중 하나는 반드시 빼먹는다.
// 그래서 needsConfirm(cmd) 하나만 물어본다.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MENU } from '@/lib/menuItems';
import { buildCommands, symbolsToCommands, needsConfirm, type SymbolLike } from '@/lib/commands/registry';
import { searchCommands } from '@/lib/commands/match';
import { choseongOfText } from '@/lib/commands/hangul';
import type { Command, CommandHit } from '@/lib/commands/types';

const DANGER_STYLE: Record<Command['danger'], { label: string; color: string } | null> = {
  safe: null,
  // 확인을 받는다는 것을 미리 알린다. 눌렀더니 확인창이 뜨는 것과
  // 누르기 전에 아는 것은 다르다.
  guarded: { label: '확인 필요', color: '#F59E0B' },
  // 즉시 실행됨을 알린다. 이게 이 커맨드의 값어치다.
  reducing: { label: '즉시 실행', color: '#EF4444' },
};

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 커맨드 실행. 실제 동작은 앱이 안다 */
  onRun: (cmd: Command) => void;
  isAdmin?: boolean;
  /** 종목 목록 (있으면 별도 묶음으로 보여준다) */
  symbols?: SymbolLike[];
}

/** 맞은 구간을 굵게. 없으면 그냥 라벨 */
function Highlight({ text, range }: { text: string; range: CommandHit['range'] }) {
  if (!range) return <>{text}</>;
  const chars = [...text];
  return (
    <>
      {chars.slice(0, range.start).join('')}
      <span style={{ color: 'var(--t-txt)', fontWeight: 800, textDecoration: 'underline', textUnderlineOffset: 2 }}>
        {chars.slice(range.start, range.end).join('')}
      </span>
      {chars.slice(range.end).join('')}
    </>
  );
}

export default function CommandPalette({
  open, onClose, onRun, isAdmin = false, symbols,
}: CommandPaletteProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  /** 확인 대기 중인 커맨드 id. guarded는 Enter 두 번이다 */
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // MENU는 상수라 매 렌더 다시 만들 이유가 없다
  const menuCommands = useMemo(() => buildCommands(MENU), []);
  const symbolCommands = useMemo(
    () => (symbols?.length ? symbolsToCommands(symbols) : []),
    [symbols],
  );

  // 종목을 메뉴와 한 배열에 섞지 않는다. 300개가 섞이면 메뉴가 묻히고,
  // 타이핑마다 300개를 매칭해 입력이 늦는다. 따로 검색해 뒤에 붙인다.
  const hits = useMemo(() => {
    const menuHits = searchCommands(menuCommands, q, { isAdmin, limit: 40 });
    const symHits = q.trim()
      ? searchCommands(symbolCommands, q, { isAdmin, limit: 8 })
      : [];
    return [...menuHits, ...symHits];
  }, [menuCommands, symbolCommands, q, isAdmin]);

  // 열 때마다 처음 상태로. 지난 질의가 남아 있으면 Enter를 바로 치는
  // 습관과 겹쳐 엉뚱한 것이 실행된다.
  useEffect(() => {
    if (!open) return;
    setQ(''); setSel(0); setPending(null);
    // 렌더 뒤에 포커스를 준다
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // 결과가 줄면 선택이 목록 밖으로 나간다 → Enter가 아무것도 안 하거나
  // 마지막 항목을 실행한다. 둘 다 사용자가 예상하지 못한다.
  useEffect(() => {
    setSel(s => (hits.length === 0 ? 0 : Math.min(s, hits.length - 1)));
    setPending(null);
  }, [hits.length, q]);

  // 선택된 줄을 보이게 유지
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  const run = useCallback((hit: CommandHit) => {
    const cmd = hit.command;
    if (needsConfirm(cmd) && pending !== cmd.id) {
      // 첫 Enter는 확인 요청이다. 실행하지 않는다.
      setPending(cmd.id);
      return;
    }
    setPending(null);
    onClose();
    onRun(cmd);
  }, [pending, onRun, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(s => (hits.length ? (s + 1) % hits.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(s => (hits.length ? (s - 1 + hits.length) % hits.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[sel];
      if (hit) run(hit);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // 확인 대기 중이면 그것만 취소한다. 팔레트까지 닫으면 취소하려고
      // Esc를 눌렀을 때 처음부터 다시 찾아야 한다.
      if (pending) setPending(null);
      else onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '10vh 16px 16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560, maxHeight: '76vh',
          background: 'var(--t-card)', border: '1px solid var(--t-border)',
          borderRadius: 16, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,.5)',
          fontFamily: "'Sora',sans-serif",
        }}
      >
        {/* 입력 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--t-border)' }}>
          <span style={{ fontSize: 15, opacity: .6 }}>⌘</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="이동·실행·검색   (초성도 됩니다: ㄱㅈㅋ)"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--t-txt)', fontSize: 15, fontWeight: 600,
            }}
          />
          <span style={{ fontSize: 10, color: 'var(--t-muted)', whiteSpace: 'nowrap' }}>
            {hits.length}건
          </span>
        </div>

        {/* 결과 */}
        <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
          {hits.length === 0 && (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--t-muted)', fontSize: 12, lineHeight: 1.7 }}>
              맞는 것이 없습니다.<br />
              <span style={{ fontSize: 11, opacity: .8 }}>
                초성은 이어져야 합니다 — 경제캘린더는 <code>ㄱㅈㅋ</code>이고 <code>ㄱㅋ</code>는 아닙니다.
              </span>
            </div>
          )}

          {hits.map((hit, i) => {
            const cmd = hit.command;
            const badge = DANGER_STYLE[cmd.danger];
            const active = i === sel;
            const confirming = pending === cmd.id;
            return (
              <div
                key={cmd.id}
                data-idx={i}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(hit)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 16px', cursor: 'pointer',
                  background: confirming
                    ? 'rgba(245,158,11,.16)'
                    : active ? 'var(--t-alt, rgba(255,255,255,.05))' : 'transparent',
                  borderLeft: `2px solid ${active ? 'var(--t-acl, #3B82F6)' : 'transparent'}`,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-sub, var(--t-txt))' }}>
                    <Highlight text={cmd.label} range={hit.range} />
                  </div>

                  {confirming ? (
                    // 확인 문구가 설명 자리를 대신 쓴다. 새 줄을 만들면
                    // 목록이 흔들려 다른 항목을 누르게 된다.
                    <div style={{ fontSize: 11, color: '#F59E0B', fontWeight: 700, marginTop: 2 }}>
                      한 번 더 Enter를 누르면 실행됩니다 · Esc로 취소
                    </div>
                  ) : (
                    <div style={{ fontSize: 10.5, color: 'var(--t-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cmd.cat}
                      {cmd.desc ? ` · ${cmd.desc}` : ''}
                      {/* 초성으로 찾았으면 그 패턴을 보여준다 — 다음에 더 짧게 칠 수 있다 */}
                      {hit.field === 'choseong' && (
                        <span style={{ opacity: .75 }}> · {choseongOfText(cmd.label)}</span>
                      )}
                    </div>
                  )}
                </div>

                {badge && (
                  <span style={{
                    fontSize: 9, fontWeight: 800, whiteSpace: 'nowrap',
                    color: badge.color, background: `${badge.color}1F`,
                    border: `1px solid ${badge.color}40`,
                    borderRadius: 99, padding: '2px 7px',
                  }}>
                    {badge.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* 도움말 */}
        <div style={{
          display: 'flex', gap: 12, padding: '8px 16px', borderTop: '1px solid var(--t-border)',
          fontSize: 10, color: 'var(--t-muted)', flexWrap: 'wrap',
        }}>
          <span>↑↓ 이동</span>
          <span>Enter 실행</span>
          <span>Esc 닫기</span>
          <span style={{ marginLeft: 'auto', opacity: .8 }}>초성 검색 지원</span>
        </div>
      </div>
    </div>
  );
}

// 단축키 리스너는 lib/commands/useHotkeys.ts에 있다. 이 파일은 dynamic
// import로 늦게 불러오는데 리스너는 첫 입력부터 들어야 하므로, 같은 파일에
// 둘 수 없다. 키맵은 lib/commands/keymap.ts.
