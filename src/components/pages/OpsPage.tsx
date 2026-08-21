'use client';
// src/components/pages/OpsPage.tsx
//
// **사용자는 명령만 한다.**
//
// 지금까지 "지금 성한가"에 답하려면 Supabase · Vercel · Fly · GitHub
// Actions · Gate 다섯 곳을 돌아다녀야 했다. 이 화면은 그 다섯을 없앤다 —
// 버튼 하나에 명령 하나이고, 결과는 서버가 판정해서 준다.
//
// **화면이 판단하지 않는다.** 색과 문장은 `src/lib/ui/opsView.ts`가
// 고르고, 판정은 서버가 한다(`/api/ops/command`). 화면이 다시 계산하면
// 기준이 두 곳에 생기고, 언젠가 서버는 막혔는데 화면은 초록이 된다.
import React, { useCallback, useEffect, useState } from 'react';
import { T } from '@/lib/constants';
import { Card } from './SharedUI';
import { verdictView, stepView, requestView } from '@/lib/ui/opsView';
// **토큰을 한 번 복사해 두지 않는다.** 갱신·복귀·포커스를 따라간다.
import { watchAuthToken } from '@/lib/auth/authToken';

const TONE: Record<string, string> = {
  ok: '#10B981', warn: '#F59E0B', bad: '#EF4444', info: '#3B82F6', muted: '#64748B',
};

/** 사용자가 하는 말. 이것 말고는 없어야 한다 */
const COMMANDS: Array<{ command: string; label: string; desc: string; danger?: boolean }> = [
  { command: 'CHECK_ALL', label: '전체 점검해', desc: '마이그레이션 · 권한 · 배포 · 워커 · 청산 감시 · 거래소 · 주문 · 장부' },
  { command: 'DEPLOY', label: '배포해', desc: '마이그레이션 → 워커 배포 → 검증까지' },
  { command: 'VERIFY_TESTNET', label: '테스트넷 검증해', desc: '읽기 전용 확인 (주문을 내지 않습니다)' },
  { command: 'RECOVER', label: '복구해', desc: '안전한 자동 복구만 — 주문이 있으면 대조가 먼저입니다' },
  {
    command: 'SYNC_SECRETS', label: '시크릿 동기화해',
    desc: 'GitHub Secrets 기준으로 Vercel·Fly에 맞추고 → 재배포 → 지문으로 실제 확인까지. '
      + '값은 어디에도 안 남습니다 (이름·지문만)',
  },
  { command: 'STOP_NOW', label: '지금 중지해', desc: '킬 스위치를 켭니다 (포지션은 자동 청산하지 않습니다)', danger: true },
];

export default function OpsPage() {
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState('');
  const [requests, setRequests] = useState<any[]>([]);

  // ── 토큰은 canonical 세션에서 온다 ──
  //
  // 예전에는 `localStorage.getItem('sb_access_token')`을 한 번 읽어
  // 들고 있었다. access token은 1시간짜리라 갱신돼도 복사본은 안 바뀐다 —
  // 한 시간 뒤부터 모든 운영 명령이 401이고, 사용자에게는
  // **"가만히 있었는데 로그아웃됐다"** 로 보인다.
  const [auth, setAuth] = useState<string | null>(null);
  useEffect(() => watchAuthToken(setAuth), []);
  const headers: Record<string, string> = auth
    ? { 'Content-Type': 'application/json', Authorization: auth }
    : { 'Content-Type': 'application/json' };

  const loadRequests = useCallback(async () => {
    try {
      const r = await fetch('/api/ops/command', { headers });
      const j = await r.json();
      setRequests(Array.isArray(j?.requests) ? j.requests : []);
    } catch { /* 목록을 못 읽어도 명령은 낼 수 있다 */ }
  }, [auth]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const run = useCallback(async (command: string) => {
    setBusy(command); setErr('');
    try {
      const r = await fetch('/api/ops/command', {
        method: 'POST', headers, body: JSON.stringify({ command }),
      });
      const j = await r.json();
      if (!j?.ok) {
        setResult(null);
        setErr(String(j?.message || j?.error || `명령이 실패했습니다 (${r.status})`));
        return;
      }
      setResult(j);
      loadRequests();
    } catch (e: any) {
      setResult(null);
      // **못 부른 것을 '이상 없음'으로 그리지 않는다.**
      setErr(`명령을 보내지 못했습니다 — 정상이라는 뜻이 아닙니다 (${e?.message || e})`);
    } finally { setBusy(''); }
  }, [auth, loadRequests]);

  const v = result ? verdictView(result.verdict) : null;

  return (
    <div style={{ padding: '16px 14px 80px', maxWidth: 720, margin: '0 auto' }}>
      <div style={{ marginBottom: 4, color: T.txt, fontSize: 18, fontWeight: 800 }}>운영</div>
      <div style={{ marginBottom: 14, color: T.muted, fontSize: 12, lineHeight: 1.7 }}>
        명령만 내리면 됩니다. 마이그레이션 · 시크릿 확인 · 배포 · 워커 재시작 · SHA 대조 ·
        스키마 확인 · 포지션 대조는 시스템이 합니다.
      </div>

      {/* ── 명령 ── */}
      <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {COMMANDS.map(c => (
          <button
            key={c.command}
            onClick={() => run(c.command)}
            disabled={!!busy}
            style={{
              textAlign: 'left', padding: '12px 14px', borderRadius: 12,
              border: `1px solid ${c.danger ? '#EF444455' : T.border}`,
              background: c.danger ? '#EF44440D' : T.surf,
              color: T.txt, cursor: busy ? 'wait' : 'pointer', opacity: busy && busy !== c.command ? 0.5 : 1,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 14, color: c.danger ? '#EF4444' : T.txt }}>
              {busy === c.command ? '확인 중…' : c.label}
            </div>
            <div style={{ marginTop: 3, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>{c.desc}</div>
          </button>
        ))}
      </div>

      {err && (
        <Card style={{ padding: 14, marginBottom: 12, border: '1px solid #EF444455' }}>
          <div style={{ color: '#EF4444', fontSize: 13, fontWeight: 700 }}>{err}</div>
        </Card>
      )}

      {/* ── 결과 ── */}
      {v && (
        <Card style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>{v.glyph}</span>
            <span style={{ color: TONE[v.tone], fontWeight: 800, fontSize: 15 }}>{v.title}</span>
          </div>
          <div style={{ marginTop: 6, color: T.txt, fontSize: 13, lineHeight: 1.7 }}>{result.summary}</div>
          <div style={{ marginTop: 4, color: T.muted, fontSize: 11, lineHeight: 1.6 }}>{v.note}</div>

          {/* 접수와 실행은 다르다 */}
          {result.queued && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: T.alt,
              color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
              요청을 접수했습니다 — {result.next}
            </div>
          )}
          {result.stopped && (
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: T.alt,
              color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
              연결 {result.stopped.connections}개 중 {result.stopped.activated}개를 중지했습니다.
              포지션은 자동으로 청산하지 않았습니다 — 닫는 것은 별개의 결정입니다.
            </div>
          )}
          {result.queueError && (
            <div style={{ marginTop: 8, color: '#F59E0B', fontSize: 11, lineHeight: 1.6 }}>
              {result.queueError}
            </div>
          )}

          {/* 단계별 */}
          <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
            {(result.steps || []).map((s: any, i: number) => {
              const sv = stepView(s);
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: TONE[sv.tone], fontSize: 12, width: 14, flexShrink: 0 }}>{sv.glyph}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{sv.label}</div>
                    <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.6, wordBreak: 'break-word' }}>
                      {sv.detail}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 자동으로 못 한 것 — 여기가 비어 있어야 완성이다 */}
          {(result.needsHuman || []).length > 0 && (
            <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10,
              background: '#F59E0B12', border: '1px solid #F59E0B33' }}>
              <div style={{ color: '#F59E0B', fontSize: 11, fontWeight: 800, marginBottom: 4 }}>
                자동으로 처리하지 못한 것
              </div>
              {result.needsHuman.map((h: string, i: number) => (
                <div key={i} style={{ color: T.sub, fontSize: 11, lineHeight: 1.7 }}>· {h}</div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ── 복구 센터 ── */}
      {result?.recovery && (
        <Card style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ color: T.sub, fontSize: 11, fontWeight: 800, marginBottom: 8 }}>복구</div>
          <div style={{ color: T.txt, fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}>
            {result.recovery.summary}
          </div>

          {/* 시스템이 이미 한 것 — 누를 것이 없다 */}
          {(result.recovery.handled || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: '#10B981', fontSize: 11, fontWeight: 800, marginBottom: 6 }}>
                시스템이 처리했습니다
              </div>
              {result.recovery.handled.map((h: any) => (
                <div key={h.id} style={{ marginBottom: 6 }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{h.label}</div>
                  <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.6 }}>
                    {h.detail}
                    {(h.did || []).length > 0 && ` — ${h.did.join(' · ')}`}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 사람의 결정이 필요한 것 — **여기가 비어 있어야 완성이다** */}
          {(result.recovery.decisions || []).length > 0 ? (
            <div style={{ padding: '10px 12px', borderRadius: 10,
              background: '#F59E0B12', border: '1px solid #F59E0B33' }}>
              <div style={{ color: '#F59E0B', fontSize: 11, fontWeight: 800, marginBottom: 6 }}>
                결정이 필요합니다
              </div>
              {result.recovery.decisions.map((d: any) => (
                <div key={d.id} style={{ marginBottom: 8 }}>
                  <div style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>
                    {d.label}
                    {d.kind === 'NEVER_AUTO' && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: '#EF4444', fontWeight: 800 }}>
                        자동 처리 안 함
                      </span>
                    )}
                  </div>
                  <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.6 }}>{d.detail}</div>
                  {d.needed && (
                    <div style={{ marginTop: 2, color: T.sub, fontSize: 11, lineHeight: 1.6 }}>
                      → {d.needed}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: T.muted, fontSize: 11 }}>결정이 필요한 것은 없습니다.</div>
          )}

          {result.recovery.canTrade === false && (
            <div style={{ marginTop: 10, color: '#EF4444', fontSize: 11, lineHeight: 1.7 }}>
              지금은 새 진입이 막혀 있습니다. 이미 열린 포지션의 청산·보호주문 정리는 계속 동작합니다.
            </div>
          )}
        </Card>
      )}

      {/* ── 보낸 요청 ── */}
      {requests.length > 0 && (
        <Card style={{ padding: 14 }}>
          <div style={{ color: T.sub, fontSize: 11, fontWeight: 800, marginBottom: 8 }}>보낸 명령</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {requests.map((r: any) => {
              const rv = requestView(r);
              return (
                <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: TONE[rv.tone], fontSize: 12, width: 14, flexShrink: 0 }}>{rv.glyph}</span>
                  <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.6, minWidth: 0, wordBreak: 'break-word' }}>
                    {rv.text}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
