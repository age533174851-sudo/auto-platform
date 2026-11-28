'use client';
// ─────────────────────────────────────────────────────────────
// 고객지원 — 문제를 알리고, 같은 글 안에서 계속 이야기한다.
//
// 지금까지 TRAIGO에는 사용자가 문제를 알릴 길이 **하나도 없었다.**
// 친구에게 써 보라고 하면 카카오톡으로 받아 사람이 옮겨 적어야 했다.
//
// 이 화면이 지키는 것
// ───────────────────
// ① **지워진 것을 숨기지 않는다.** 비밀이 섞이면 지우고 접수하되,
//    무엇이 지워졌는지 사용자에게 적는다(값은 적지 않는다).
// ② **없는 상태를 보여주지 않는다.** 'AI 분석 중' 같은 칸은 그 일을
//    하는 것이 생긴 뒤에 붙인다.
// ③ **기기가 모드를 정하지 않는다.** 폭은 배치만 바꾼다.
// ─────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { watchAuthToken } from '@/lib/auth/authToken';
import {
  CATEGORIES, CATEGORY_LABEL, STATUS_LABEL, SEVERITY_LABEL,
  mustBePrivate, TITLE_MAX, BODY_MAX, STEPS_MAX, EXPECTED_MAX, ACTUAL_MAX,
  TICKET_OPTIONAL_FIELDS,
  type Category, type Status, type Severity, type TicketOptionalField,
} from '@/lib/feedback/ticket';
import { deviceFromWidth } from '@/lib/feedback/context';
import { F, SP, R, FW, buttonStyle, PAGE_STYLE } from '@/components/ui/tokens';
import { T } from '@/lib/constants';

interface TicketRow {
  id: string; ref: number; category: Category; title: string;
  status: Status; severity: Severity; visibility: 'PRIVATE' | 'PUBLIC';
  created_at: string; updated_at: string;
  // #618의 세 칸. **없을 수 있다** — 예전에 접수된 글에는 비어 있다.
  steps?: string | null; expected?: string | null; actual?: string | null;
}

/**
 * 선택 칸의 화면 문구. **`Record<TicketOptionalField, …>`라서 칸을 더하면
 * 여기가 컴파일 오류가 된다** — 칸만 늘고 입력이 안 생기는 것이 이 묶음의
 * 원래 고장이었다.
 */
const OPTIONAL_UI: Record<TicketOptionalField,
  { label: string; placeholder: string; max: number; rows: number }> = {
  steps: { label: '어떻게 하면 다시 생기나요? (선택)', max: STEPS_MAX, rows: 4,
    placeholder: '1. 자동매매 탭을 엽니다\n2. 시작을 누릅니다\n3. 아무 반응이 없습니다' },
  expected: { label: '원래는 어떻게 돼야 하나요? (선택)', max: EXPECTED_MAX, rows: 2,
    placeholder: '예: 봇이 켜지고 상태가 가동 중으로 바뀐다' },
  actual: { label: '실제로는 어떻게 됐나요? (선택)', max: ACTUAL_MAX, rows: 2,
    placeholder: '예: 버튼만 깜빡이고 상태가 그대로다' },
};
interface MessageRow { id: string; author: 'USER' | 'STAFF' | 'AGENT'; body: string; created_at: string }

// **`Record<Status, …>`라서 상태를 더하면 여기가 컴파일 오류가 된다.**
// 그게 이 타입을 쓴 이유다 — 색을 안 채운 상태가 조용히 기본색으로
// 그려지면, 화면만 보고는 빠진 줄을 영원히 못 찾는다.
const STATUS_TONE: Record<Status, string> = {
  RECEIVED: T.sub, REVIEWING: T.acc, NEEDS_INFO: T.ylw,
  IN_PROGRESS: T.acc,
  VERIFYING: T.acc,          // 아직 진행 중이다 — 해결과 같은 색을 쓰지 않는다
  RESOLVED: T.grn,
  ON_HOLD: T.muted,          // 멈춰 둔 것
  DUPLICATE: T.muted,        // 다른 글로 합쳐진 것
  CANNOT_REPRODUCE: T.ylw,   // 더 알려 줘야 하는 것 — 주의색
  CLOSED: T.muted,
};
const when = (v: string) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toLocaleString('ko-KR',
    { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '확인 불가';
};

export default function FeedbackPage({ screen }: { screen?: string } = {}) {
  const [auth, setAuth] = useState<string | null>(null);
  useEffect(() => watchAuthToken(setAuth), []);

  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    // **배치만 바꾼다.** Easy/Pro는 이 폭에서 나오지 않는다.
    const mq = window.matchMedia('(min-width: 1100px)');
    const apply = () => setWide(mq.matches);
    apply(); mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const [tab, setTab] = useState<'new' | 'mine'>('new');
  const [category, setCategory] = useState<Category>('BUG');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // 세 칸을 따로 두지 않고 한 묶음으로 둔다 — 칸이 늘 때 상태 변수를
  // 하나 빠뜨리는 일이 없다.
  const [extra, setExtra] = useState<Record<TicketOptionalField, string>>(
    { steps: '', expected: '', actual: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [listError, setListError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [reply, setReply] = useState('');

  /**
   * **인증 세대.** 로그인한 사람이 바뀌면 올라간다.
   *
   * 왜 필요한가 — 이 화면은 `tickets`·`openId`·`messages`·`reply`를 상태로
   * 들고 있고, 토큰은 `watchAuthToken`으로 **화면을 다시 그리지 않고도**
   * 바뀐다(토큰 갱신·다른 계정 로그인). 그때 들고 있던 것을 비우지 않으면
   * **이전 사람의 문의가 다음 사람 화면에 남는다.**
   *
   * 브라우저로 실제로 재서 확인했다(`scripts/probe/feedback-auth-isolation.mjs`):
   * A 로 문의를 열어 둔 뒤 인증을 B 로 바꾸고 B 의 목록 응답을 늦추면
   *
   *   · A 의 문의 제목이 그대로 보였다
   *   · A 에게만 보낸 직원 답장이 그대로 보였다
   *   · '답장 보내기'가 **B 의 Authorization 으로 A 의 ticket id 에 POST** 했다
   *
   * 세 번째가 가장 나쁘다. 서버가 소유자를 확인해 거절해도, 화면은 다른
   * 사람의 글에 쓰려고 한 것이다.
   *
   * 세대를 쓰는 이유는 비우는 것만으로는 **늦게 오는 응답**을 못 막기
   * 때문이다. 비운 뒤에도 이전 세대의 `fetch`가 돌아와 `setTickets`를
   * 부르면 같은 자리로 돌아간다. 그래서 응답을 쓸 때마다 "내가 떠날 때의
   * 세대가 지금 세대와 같은가"를 본다.
   */
  const authGen = useRef(0);
  useEffect(() => {
    // 이 effect 는 아래 목록 읽기보다 **먼저** 선언돼 있어야 한다 —
    // 같은 커밋에서 비우기가 먼저 돌아야 이전 사람의 것이 한 프레임도
    // 남지 않는다.
    authGen.current += 1;
    setTickets(null); setOpenId(null); setMessages(null);
    setReply(''); setListError('');
  }, [auth]);

  const loadList = useCallback(async () => {
    if (!auth) { setTickets(null); return; }
    const gen = authGen.current;
    try {
      const res = await fetch('/api/feedback/reports', { headers: { Authorization: auth }, cache: 'no-store' });
      const d = await res.json();
      if (gen !== authGen.current) return;   // 그 사이 사람이 바뀌었다
      if (!res.ok || !d.ok) throw new Error(d.message || '문의 목록을 확인하지 못했습니다');
      setTickets(d.tickets); setListError('');
    } catch (e) {
      if (gen !== authGen.current) return;
      // **값을 지우지 않는다.** 못 읽은 것과 없는 것은 다르다.
      setListError(e instanceof Error ? e.message : '문의 목록을 확인하지 못했습니다');
    }
  }, [auth]);
  useEffect(() => { void loadList(); }, [loadList]);

  const openTicket = useCallback(async (id: string) => {
    setOpenId(id); setMessages(null);
    if (!auth) return;
    const gen = authGen.current;
    try {
      const res = await fetch(`/api/feedback/reports/${id}`, { headers: { Authorization: auth }, cache: 'no-store' });
      const d = await res.json();
      if (gen !== authGen.current) return;
      if (!res.ok || !d.ok) throw new Error(d.message || '문의를 확인하지 못했습니다');
      setMessages(d.messages);
    } catch (e) {
      if (gen !== authGen.current) return;
      setListError(e instanceof Error ? e.message : '문의를 확인하지 못했습니다');
    }
  }, [auth]);

  /** 앱이 아는 것만 담는다 — 서버가 다시 허용 목록으로 거른다 */
  function collect() {
    if (typeof window === 'undefined') return {};
    const w = window.innerWidth, h = window.innerHeight;
    return {
      screen: screen ?? 'feedback',
      device: deviceFromWidth(w) ?? undefined,
      viewport: `${w}x${h}`,
      occurredAt: new Date().toISOString(),
    };
  }

  async function submit() {
    if (!auth || busy) return;
    setBusy(true); setError(''); setNotice(null);
    try {
      const res = await fetch('/api/feedback/reports', {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
        // 빈 칸은 **보내지 않는다.** 서버가 빈 문자열을 null로 바꾸지만,
        // 보내지 않는 쪽이 "적지 않았다"는 뜻을 그대로 옮긴다.
        body: JSON.stringify({
          category, title, body, context: collect(),
          ...Object.fromEntries(TICKET_OPTIONAL_FIELDS
            .map(f => [f, extra[f].trim()])
            .filter(([, v]) => v !== '')),
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.ok) throw new Error(d?.message || `접수 실패 (${res.status})`);
      setTitle(''); setBody(''); setExtra({ steps: '', expected: '', actual: '' });
      setNotice(d.redactionNotice ?? '접수됐습니다. 내 문의에서 진행 상황을 볼 수 있어요.');
      setTab('mine'); await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : '접수 실패'); }
    finally { setBusy(false); }
  }

  async function sendReply() {
    if (!auth || busy || openId == null) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/feedback/reports/${openId}`, {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: reply }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.ok) throw new Error(d?.message || `답장 실패 (${res.status})`);
      setReply(''); if (d.redactionNotice) setNotice(d.redactionNotice);
      await openTicket(openId); await loadList();
    } catch (e) { setError(e instanceof Error ? e.message : '답장 실패'); }
    finally { setBusy(false); }
  }

  const titleOver = title.length > TITLE_MAX;
  const bodyOver = body.length > BODY_MAX;
  // 선택 칸도 상한을 넘으면 서버가 거절한다. **보내기 전에 막는다.**
  const extraOver = TICKET_OPTIONAL_FIELDS.filter(f => extra[f].length > OPTIONAL_UI[f].max);
  const canSend = !!auth && !busy && title.trim() !== '' && body.trim() !== ''
    && !titleOver && !bodyOver && extraOver.length === 0;
  const field: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: SP.md, borderRadius: R.md,
    border: `1px solid ${T.border}`, background: T.bg, color: T.txt, fontSize: 15,
  };

  return <div style={{ ...PAGE_STYLE, padding: SP.lg, display: 'grid', gap: SP.md }}>
    <div>
      <div style={F.title}>고객지원</div>
      <div style={{ ...F.muted, marginTop: 2 }}>문제를 알려 주시면 같은 글에서 진행 상황을 적어 드려요.</div>
    </div>

    {!auth && <div role="status" style={{ ...F.caption, padding: SP.md, borderRadius: R.md,
      border: `1px solid ${T.border}`, color: T.sub }}>로그인하면 문의를 남길 수 있어요.</div>}

    {/* 탭 — 두 개뿐이다. 없는 기능으로 가는 버튼을 만들지 않는다 */}
    <div role="tablist" style={{ display: 'flex', gap: SP.sm }}>
      {([['new', '문의하기'], ['mine', '내 문의']] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id}
          onClick={() => setTab(id)}
          style={{ ...buttonStyle(tab === id ? 'primary' : 'ghost', 'md'), flex: wide ? '0 0 160px' : 1 }}>
          {label}{id === 'mine' && tickets ? ` (${tickets.length})` : ''}
        </button>)}
    </div>

    {notice && <div role="status" data-testid="feedback-notice"
      style={{ ...F.caption, padding: SP.md, borderRadius: R.md, color: T.txt,
        background: `${T.grn}14`, border: `1px solid ${T.grn}` }}>{notice}</div>}
    {error && <div role="alert" style={{ ...F.caption, color: T.red }}>{error}</div>}

    {tab === 'new' && <div data-testid="feedback-new" style={{ display: 'grid', gap: SP.md,
      ...(wide ? { maxWidth: 720 } : {}) }}>
      <label style={{ display: 'grid', gap: SP.xs }}>
        <span style={F.caption}>어떤 문제인가요?</span>
        <select value={category} aria-label="문의 유형" disabled={busy}
          onChange={e => setCategory(e.target.value as Category)} style={field}>
          {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        {/* 공개 여부가 분류에서 정해진다는 것을 **미리** 알린다 */}
        <span style={F.muted}>
          {mustBePrivate(category)
            ? '이 유형은 비공개로 접수돼요 — 나와 관리자만 볼 수 있어요.'
            : '이 유형은 공개 제안으로 올릴 수 있어요 (공개 게시판은 준비 중이라 지금은 비공개로 접수돼요).'}
        </span>
      </label>

      <label style={{ display: 'grid', gap: SP.xs }}>
        <span style={F.caption}>한 줄로 요약하면?</span>
        <input value={title} disabled={busy} maxLength={TITLE_MAX + 10}
          onChange={e => setTitle(e.target.value)} aria-label="제목"
          placeholder="예: 봇 실행 버튼을 눌러도 반응이 없어요"
          style={{ ...field, borderColor: titleOver ? T.red : T.border }} />
        <span style={{ ...F.muted, color: titleOver ? T.red : T.muted }}>
          {title.length} / {TITLE_MAX}
        </span>
      </label>

      <label style={{ display: 'grid', gap: SP.xs }}>
        <span style={F.caption}>자세히 적어 주세요</span>
        <textarea value={body} disabled={busy} rows={wide ? 8 : 6}
          onChange={e => setBody(e.target.value)} aria-label="내용"
          placeholder="무엇을 하려다가 어떻게 됐는지 적어 주세요."
          style={{ ...field, resize: 'vertical', borderColor: bodyOver ? T.red : T.border }} />
        <span style={{ ...F.muted, color: bodyOver ? T.red : T.muted }}>
          {body.length} / {BODY_MAX}
        </span>
      </label>

      {/* #618의 세 칸. **선택이다** — 버그가 아닌 문의에는 해당이 없고,
          억지로 채우게 하면 사용자가 아무 글자나 넣는다. */}
      {TICKET_OPTIONAL_FIELDS.map(f => {
        const ui = OPTIONAL_UI[f];
        const over = extra[f].length > ui.max;
        return <label key={f} style={{ display: 'grid', gap: SP.xs }}>
          <span style={F.caption}>{ui.label}</span>
          <textarea value={extra[f]} disabled={busy} rows={wide ? ui.rows + 2 : ui.rows}
            onChange={e => setExtra(prev => ({ ...prev, [f]: e.target.value }))}
            aria-label={ui.label} data-testid={`feedback-${f}`}
            placeholder={ui.placeholder}
            style={{ ...field, resize: 'vertical', borderColor: over ? T.red : T.border }} />
          <span style={{ ...F.muted, color: over ? T.red : T.muted }}>
            {extra[f].length} / {ui.max}
          </span>
        </label>;
      })}

      {/* 비밀이 지워진다는 것을 **보내기 전에** 알린다 */}
      <div style={{ ...F.muted, padding: SP.sm, borderRadius: R.sm, border: `1px dashed ${T.border}` }}>
        안전을 위해 API 키 · 비밀번호 · 시드 구문 · 연락처가 섞여 있으면
        <b> 저장하기 전에 지웁니다.</b> 지운 종류는 접수 뒤에 알려 드려요.
      </div>

      <button type="button" disabled={!canSend} onClick={() => void submit()}
        data-testid="feedback-submit"
        style={{ ...buttonStyle('primary', 'lg'), opacity: canSend ? 1 : 0.5 }}>
        {busy ? '접수 중…' : '문의 보내기'}
      </button>
    </div>}

    {tab === 'mine' && <div data-testid="feedback-mine" style={{ display: 'grid', gap: SP.sm }}>
      {listError && <div role="alert" style={{ ...F.caption, color: T.ylw }}>
        {listError} — 아래 목록은 마지막으로 읽은 값일 수 있어요.
      </div>}
      {tickets == null && !listError && <div style={F.muted}>불러오는 중…</div>}
      {tickets != null && tickets.length === 0 && <div style={F.muted}>아직 남긴 문의가 없어요.</div>}
      {(tickets ?? []).map(t => {
        const open = openId === t.id;
        return <article key={t.id} data-testid={`feedback-report-${t.ref}`}
          style={{ display: 'grid', gap: SP.xs, padding: SP.md, borderRadius: R.md,
            background: T.card, border: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP.xs, flexWrap: 'wrap' }}>
            <span style={{ ...F.btnSm, padding: '2px 7px', borderRadius: R.pill, whiteSpace: 'nowrap',
              color: STATUS_TONE[t.status], border: `1px solid ${STATUS_TONE[t.status]}` }}>
              {STATUS_LABEL[t.status]}
            </span>
            <span style={{ ...F.btnSm, padding: '2px 7px', borderRadius: R.sm,
              color: T.sub, border: `1px dashed ${T.border}` }}>{CATEGORY_LABEL[t.category]}</span>
            <span style={{ ...F.muted, marginLeft: 'auto' }}>#{t.ref}</span>
          </div>
          <div title={t.title} style={{ ...F.body, fontWeight: FW.bold,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
          <div style={F.muted}>
            {when(t.created_at)} 접수 · 심각도 {SEVERITY_LABEL[t.severity]}
            {t.visibility === 'PRIVATE' ? ' · 비공개' : ' · 공개'}
          </div>
          <button type="button" aria-expanded={open}
            onClick={() => open ? setOpenId(null) : void openTicket(t.id)}
            style={{ ...buttonStyle('ghost', 'md') }}>{open ? '접기' : '대화 보기'}</button>

          {open && <div style={{ display: 'grid', gap: SP.sm, paddingTop: SP.sm,
            borderTop: `1px solid ${T.border}` }}>
            {/* 적어 보낸 세 칸을 **되돌려 보여 준다.** 보이지 않으면
                사용자는 자기가 보낸 것이 남았는지 알 수 없다. 가림이
                지운 자리도 여기서 보인다. */}
            {TICKET_OPTIONAL_FIELDS.some(f => (t[f] ?? '') !== '')
              && <div style={{ display: 'grid', gap: SP.xs, padding: SP.sm, borderRadius: R.sm,
                border: `1px dashed ${T.border}` }}>
                {TICKET_OPTIONAL_FIELDS.filter(f => (t[f] ?? '') !== '').map(f =>
                  <div key={f} style={{ display: 'grid', gap: 2 }}>
                    <div style={F.muted}>{OPTIONAL_UI[f].label.replace(' (선택)', '')}</div>
                    <div data-testid={`feedback-detail-${f}`}
                      style={{ ...F.caption, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {t[f]}
                    </div>
                  </div>)}
              </div>}
            {messages == null && <div style={F.muted}>불러오는 중…</div>}
            {messages?.map(m => <div key={m.id}
              style={{ display: 'grid', gap: 2, padding: SP.sm, borderRadius: R.sm,
                background: m.author === 'USER' ? 'transparent' : `${T.acc}10`,
                border: `1px solid ${m.author === 'USER' ? T.border : T.acc}` }}>
              <div style={F.muted}>{m.author === 'USER' ? '나' : '지원팀'} · {when(m.created_at)}</div>
              <div style={{ ...F.caption, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
            </div>)}
            {t.status === 'CLOSED'
              ? <div style={F.muted}>종료된 문의예요. 더 하실 말씀이 있으면 새 문의를 남겨 주세요.</div>
              : <>
                  <textarea value={reply} rows={3} disabled={busy} aria-label="답장"
                    onChange={e => setReply(e.target.value)}
                    placeholder="추가로 알려 주실 내용이 있나요?"
                    style={{ ...field, resize: 'vertical' }} />
                  <button type="button" disabled={busy || reply.trim() === ''}
                    onClick={() => void sendReply()}
                    style={{ ...buttonStyle('primary', 'md'),
                      opacity: (busy || reply.trim() === '') ? 0.5 : 1 }}>
                    {busy ? '보내는 중…' : '답장 보내기'}
                  </button>
                </>}
          </div>}
        </article>;
      })}
    </div>}
  </div>;
}
