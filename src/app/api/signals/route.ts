// /api/signals — 방송자 채널과 감지된 포지션 신호
//
// 이 라우트가 지키는 것
// ─────────────────────
// **주문을 만들지 않는다.** 신호를 저장하고 읽기만 한다. 그 경계를
// 라우트 단위로 나눠 둔 이유는, 한 파일 안에 있으면 언젠가 누가
// "여기서 바로 주문 내면 되겠네"를 한다는 것이다.
//
// 그리고 **공개 발언만 받는다.** 어디서 온 텍스트인지는 이 라우트가
// 알 수 없으므로, 화면이 "공개 방송·게시물에서 본 것만 넣으세요"라고
// 적고 사용자가 지킨다. 로그인이 필요한 곳·멤버십 전용·개인 메시지는
// 넣지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { parsePositionSignal, withScreenCheck } from '@/lib/signals/positionParse';
import { scoreTrader, trustTier, type ScoredSignal } from '@/lib/signals/traderScore';
import { computeConsensus, type ConsensusInput } from '@/lib/signals/consensus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function auth(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  const sb = getSupabaseAdmin();
  return { uid, sb };
}

/** 표가 없을 때 무엇을 해야 하는지 알려준다 */
function tableHint(msg: string): string | null {
  return /trader_(channels|signals)/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg)
    ? '마이그레이션 030을 적용하세요'
    : null;
}

// ── 읽기 ─────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { uid, sb } = await auth(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  try {
    const { data: chans, error: cErr } = await (sb as any)
      .from('trader_channels').select('*').eq('user_id', uid).order('created_at', { ascending: true });
    if (cErr) throw new Error(cErr.message);

    const since = Date.now() - 90 * 24 * 3_600_000;
    const { data: sigs, error: sErr } = await (sb as any)
      .from('trader_signals').select('*')
      .eq('user_id', uid).gte('detected_at', new Date(since).toISOString())
      .order('detected_at', { ascending: false }).limit(500);
    if (sErr) throw new Error(sErr.message);

    const channels = Array.isArray(chans) ? chans : [];
    const rows = Array.isArray(sigs) ? sigs : [];
    const nameOf = new Map(channels.map((c: any) => [c.id, c.name]));

    // 채점용 모양으로 바꾼다. **못 구한 값은 null 그대로 둔다** —
    // 여기서 채우면 성적이 실제와 달라진다.
    const scored: ScoredSignal[] = rows
      .filter((r: any) => r.side === 'LONG' || r.side === 'SHORT')
      .map((r: any) => ({
        trader: String(nameOf.get(r.channel_id) || '—'),
        symbol: String(r.symbol || ''),
        side: r.side,
        confidence: r.confidence,
        detectedAtMs: Date.parse(String(r.detected_at)) || 0,
        entryPrice: r.market_price != null ? Number(r.market_price) : null,
        exitPrice: r.exit_price != null ? Number(r.exit_price) : null,
        exitAtMs: r.exit_at ? Date.parse(String(r.exit_at)) : null,
      }));

    const traders = channels.map((c: any) => {
      const st = scoreTrader(c.name, scored);
      const t = trustTier(st);
      return { channel: c, stats: st, tier: t.tier, tierReason: t.reason };
    });

    // 종목별 합의. 진입·추가만 본다 — 청산 발언은 방향이 없거나
    // 반대 뜻이라 같이 세면 결과가 뒤집힌다.
    const now = Date.now();
    const bySymbol = new Map<string, ConsensusInput[]>();
    for (const r of rows) {
      if (!r.symbol || (r.action !== 'ENTRY' && r.action !== 'ADD')) continue;
      if (r.side !== 'LONG' && r.side !== 'SHORT') continue;
      const name = String(nameOf.get(r.channel_id) || '—');
      const st = traders.find(t => t.channel.name === name)?.stats ?? null;
      const list = bySymbol.get(r.symbol) || [];
      list.push({ trader: name, side: r.side, confidence: r.confidence,
                  atMs: Date.parse(String(r.detected_at)) || 0, stats: st });
      bySymbol.set(r.symbol, list);
    }
    const consensus = [...bySymbol.entries()].map(([sym, v]) => computeConsensus(sym, v, now));

    return NextResponse.json({
      ok: true,
      channels, traders, consensus,
      signals: rows.slice(0, 100).map((r: any) => ({ ...r, trader: nameOf.get(r.channel_id) || null })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return NextResponse.json({ ok: false, error: 'read_failed', message: msg, hint: tableHint(msg) },
      { status: 500 });
  }
}

// ── 쓰기 ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { uid, sb } = await auth(req);
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const action = String(body.action || '');

  try {
    // ── 채널 추가 ──
    if (action === 'add_channel') {
      const name = String(body.name || '').trim();
      if (!name) return NextResponse.json({ ok: false, error: 'name_required' }, { status: 400 });
      const { data, error } = await (sb as any).from('trader_channels').insert({
        user_id: uid, name,
        platform: String(body.platform || 'manual'),
        channel_url: String(body.channelUrl || '').trim() || null,
        kind: String(body.kind || 'live_position'),
      }).select('id').single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, id: data?.id });
    }

    if (action === 'remove_channel') {
      const { error } = await (sb as any).from('trader_channels')
        .delete().eq('id', String(body.id || '')).eq('user_id', uid);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    // ── 발언 넣기 ──
    //
    // 텍스트를 넣으면 파싱해서 저장한다. **파싱이 실패하면 저장하지
    // 않는다** — 매매 발언이 아닌 것까지 쌓이면 성적 계산이 망가진다.
    if (action === 'add_signal') {
      const channelId = String(body.channelId || '');
      const text = String(body.text || '');
      if (!channelId) return NextResponse.json({ ok: false, error: 'channel_required' }, { status: 400 });

      const parsed = parsePositionSignal(text);
      if (!parsed) {
        return NextResponse.json({
          ok: false, error: 'not_a_signal',
          message: '매매 발언으로 읽히지 않습니다. 방향(롱/숏)과 실제로 한 행동(잡았다·정리했다)이 들어가야 합니다',
        }, { status: 400 });
      }
      // 화면을 봤는지 **사용자가 직접** 표시한다. 안 넘기면 null이고,
      // null이면 신뢰도가 그대로 유지된다(올리지도 내리지도 않는다).
      const screen = body.screenMatches === true ? true
                   : body.screenMatches === false ? false : null;
      const sig = withScreenCheck(parsed, screen)!;

      // ── 장부에 필요한 값들 ──
      //
      // 이 셋이 없으면 반입(creatorIntake)에서 전부 막힌다. 예전에는
      // 넣지 않았고, 그래서 **저장은 되는데 장부는 한 건도 안 만들어지는**
      // 상태였다 — 만들어 놓고 배선을 안 한 그 모양이다.
      const { confidenceFromTier, kindFromAction, msOf } = await import('@/lib/signals/creatorIntake');

      // 발언 시각. **감지 시각으로 대신 채우지 않는다** — 그러면 지연이
      // 0초가 되고, 그 신호는 성적이 가장 좋게 나오는 칸에 앉는다.
      // 사용자가 안 넣었으면 null로 두고, 검수할 때 채우게 한다.
      const saidAt = msOf(body.saidAt);

      // 발언 종류는 파서가 추정하고 사람이 검수할 때 고친다.
      // 명시적으로 넘어온 값이 있으면 그쪽이 우선이다.
      const kind = String(body.utteranceKind || '').trim().toUpperCase()
        || kindFromAction(sig.action);

      const { error } = await (sb as any).from('trader_signals').insert({
        user_id: uid, channel_id: channelId,
        symbol: sig.symbol, side: sig.side, action: sig.action,
        entry_price: sig.entryPrice, leverage: sig.leverage,
        stop_loss: sig.stopLoss, take_profit: sig.takeProfit,
        confidence: sig.confidence,
        // 등급 → 숫자. 변환은 creatorIntake 한 곳에만 있다.
        extract_confidence: confidenceFromTier(sig.confidence),
        utterance_kind: kind,
        said_at: saidAt != null ? new Date(saidAt).toISOString() : null,
        // 검수 전이다. 기본을 approved로 두면 아무도 검수하지 않는다.
        review_status: 'pending',
        evidence: sig.evidence,
        source_url: String(body.sourceUrl || '').trim() || null,
        // 신호 당시 시장가. 화면이 알면 넘기고, 모르면 null이다 —
        // 나중에 지금 가격으로 채우면 채점이 통째로 틀어진다.
        market_price: Number.isFinite(Number(body.marketPrice)) && Number(body.marketPrice) > 0
          ? Number(body.marketPrice) : null,
        detected_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);

      return NextResponse.json({ ok: true, parsed: sig });
    }

    // ── 검수 ──
    //
    // 신호 자체는 읽기 전용이다(진 신호를 지워 성적을 좋게 만들 수 없게).
    // 그런데 검수 상태와 발언 시각은 **고칠 수 있어야 한다** — 둘 다
    // 나중에 사람이 채우는 값이고, 못 고치면 장부가 영원히 안 만들어진다.
    //
    // 고칠 수 있는 것을 여기 적힌 넷으로 못박는다. 손익에 영향을 주는
    // 값(방향·손절가·진입가)은 여기서 못 바꾼다 — 바꿀 수 있으면
    // 성적을 좋게 만들 수 있고, 그러면 이 기록의 존재 이유가 사라진다.
    if (action === 'review') {
      const id = String(body.signalId || '').trim();
      const status = String(body.status || '').trim().toLowerCase();
      if (!id) return NextResponse.json({ ok: false, error: 'missing_signalId' }, { status: 400 });
      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return NextResponse.json({ ok: false, error: 'bad_status',
          message: "status는 pending·approved·rejected 중 하나여야 합니다" }, { status: 400 });
      }

      const { msOf } = await import('@/lib/signals/creatorIntake');
      const patch: any = {
        review_status: status,
        reviewed_at: new Date().toISOString(),
      };
      if (body.reviewNote != null) patch.review_note = String(body.reviewNote).slice(0, 500);
      if (body.utteranceKind) patch.utterance_kind = String(body.utteranceKind).toUpperCase();
      if (body.regime) patch.regime = String(body.regime).toUpperCase();
      // 발언 시각을 여기서 채운다. **못 읽으면 안 바꾼다** — 지금 시각으로
      // 떨어뜨리면 지연이 음수가 되고, 그건 기록이 깨진 것이다.
      if (body.saidAt != null) {
        const t = msOf(body.saidAt);
        if (t == null) {
          return NextResponse.json({ ok: false, error: 'bad_saidAt',
            message: '발언 시각을 읽지 못했습니다 — 지금 시각으로 대신 채우지 않습니다' }, { status: 400 });
        }
        patch.said_at = new Date(t).toISOString();
      }

      // **승인하려면 발언 시각이 있어야 한다.** 없이 승인하면 반입에서
      // 막히고, 화면에는 '승인됨'이라고 뜬 채 장부는 안 만들어진다.
      if (status === 'approved' && patch.said_at == null) {
        const { data: cur } = await (sb as any).from('trader_signals')
          .select('said_at').eq('id', id).eq('user_id', uid).single();
        if (!cur?.said_at) {
          return NextResponse.json({ ok: false, error: 'said_at_required',
            message: '발언 시각 없이는 승인할 수 없습니다 — 지연을 모르면 '
                   + '볼 수 없었던 가격에 체결한 성과가 나옵니다',
            hint: 'saidAt을 함께 넘기세요' }, { status: 400 });
        }
      }

      const { error } = await (sb as any).from('trader_signals')
        .update(patch).eq('id', id).eq('user_id', uid);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, signalId: id, status });
    }

    // ── 미리보기 (저장 안 함) ──
    //
    // 넣기 전에 무엇으로 읽히는지 보여준다. 저장하고 나서 틀린 것을
    // 발견하면 지울 수 없다(신호는 읽기 전용이다).
    if (action === 'preview') {
      const parsed = parsePositionSignal(String(body.text || ''));
      return NextResponse.json({ ok: true, parsed });
    }

    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (e: any) {
    const msg = String(e?.message || e);
    return NextResponse.json({ ok: false, error: 'write_failed', message: msg, hint: tableHint(msg) },
      { status: 500 });
  }
}
