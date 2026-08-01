import { test, eq, assert } from '../../test/harness';
import {
  KIS_HOSTS, KIS_TR, trIdFor, orderTrId,
  parseKisBody, parseTokenBody, tokenNeedsRefresh,
  buildOrderBody, splitAccountNo, priceFrom, holdingsFrom, cashFrom,
} from './kisCore';

export function runKisCoreTests() {
  console.log('[한국투자증권 — 200이 성공이 아니다]');

  // ── 주소·거래ID ─────────────────────────────────────────
  test('실전과 모의는 주소가 다르다', () => {
    assert(KIS_HOSTS.LIVE !== KIS_HOSTS.PAPER, '같은 주소를 쓰고 있습니다');
    assert(KIS_HOSTS.PAPER.includes('vts'), KIS_HOSTS.PAPER);
  });

  test('모의는 tr_id 첫 글자가 V다', () => {
    eq(trIdFor('TTTC0802U', 'PAPER'), 'VTTC0802U');
    eq(trIdFor('TTTC0802U', 'LIVE'), 'TTTC0802U');
    eq(trIdFor('TTTC8434R', 'PAPER'), 'VTTC8434R');
  });

  test('시세 조회는 모의에서도 그대로다', () => {
    // 앞글자만 보고 바꾸면 FHKST…가 VHKST…가 되어 없는 요청이 된다.
    eq(trIdFor(KIS_TR.PRICE, 'PAPER'), 'FHKST01010100');
  });

  test('매수와 매도의 거래ID가 다르다', () => {
    assert(orderTrId('BUY', 'LIVE') !== orderTrId('SELL', 'LIVE'), '같은 ID를 쓰고 있습니다');
    eq(orderTrId('BUY', 'PAPER'), 'VTTC0802U');
    eq(orderTrId('SELL', 'PAPER'), 'VTTC0801U');
  });

  // ── 응답 해석 ───────────────────────────────────────────
  test('rt_cd가 0이어야 성공이다', () => {
    eq(parseKisBody({ rt_cd: '0', msg1: '정상처리' }).ok, true);
    eq(parseKisBody({ rt_cd: '1', msg1: '장운영일이 아닙니다' }).ok, false);
  });

  test('실패 사유를 그대로 올린다 — 뭉개지 않는다', () => {
    // 'API 오류'로 뭉개면 종목코드가 틀린 것인지 장이 닫힌 것인지
    // 잔고가 없는 것인지 구분이 안 된다.
    const r = parseKisBody({ rt_cd: '1', msg_cd: 'APBK0919', msg1: '주문가능금액이 부족합니다' });
    eq(r.ok, false);
    assert(r.message.includes('주문가능금액'), r.message);
    eq(r.code, '1');
  });

  test('rt_cd가 없으면 성공이 아니다', () => {
    // 응답 모양이 바뀐 것을 성공으로 읽으면, 아무것도 안 됐는데
    // 주문이 나간 것으로 기록된다.
    eq(parseKisBody({ output: { stck_prpr: '70000' } }).ok, false);
    eq(parseKisBody({}).ok, false);
    eq(parseKisBody(null).ok, false);
    eq(parseKisBody('그냥 글자' as any).ok, false);
  });

  test('인증 오류 문구를 살린다', () => {
    const r = parseKisBody({ error_description: '유효하지 않은 AppKey입니다' });
    eq(r.ok, false);
    assert(r.message.includes('AppKey'), r.message);
  });

  test('성공이면 output들을 그대로 넘긴다', () => {
    const r = parseKisBody({ rt_cd: '0', msg1: 'OK', output1: [1], output2: [2] });
    eq(r.output1[0], 1);
    eq(r.output2[0], 2);
  });

  // ── 토큰 ────────────────────────────────────────────────
  test('만료 시간을 안 주면 토큰을 안 만든다', () => {
    // 24시간으로 넘겨짚으면 실제로는 만료된 토큰을 계속 쓰다가
    // 하루 종일 인증 실패한다.
    const r = parseTokenBody({ access_token: 'abc' }, 1_000);
    eq(r.token, null);
    assert(r.error!.includes('expires_in'), r.error!);
  });

  test('만료 시각을 지금 기준으로 계산한다', () => {
    const r = parseTokenBody({ access_token: 'abc', expires_in: 86400 }, 1_000);
    eq(r.token!.expiresAtMs, 1_000 + 86_400_000);
    eq(r.token!.accessToken, 'abc');
  });

  test('토큰이 없으면 오류 문구를 살린다', () => {
    const r = parseTokenBody({ error_description: 'invalid appsecret' }, 0);
    eq(r.token, null);
    assert(r.error!.includes('appsecret'), r.error!);
  });

  test('멀쩡한 토큰은 다시 안 받는다', () => {
    // KIS는 재발급 횟수를 제한한다. 매 요청마다 새로 받으면 금방 막히고,
    // 막히면 주문도 조회도 전부 실패한다.
    eq(tokenNeedsRefresh({ accessToken: 'a', expiresAtMs: 10_000_000 }, 1_000), false);
  });

  test('만료가 가까우면 미리 받는다', () => {
    // 요청이 날아가는 도중에 만료되면 그 요청만 조용히 실패한다.
    const exp = 10_000_000;
    eq(tokenNeedsRefresh({ accessToken: 'a', expiresAtMs: exp }, exp - 60_000), true);
    eq(tokenNeedsRefresh({ accessToken: 'a', expiresAtMs: exp }, exp - 20 * 60_000), false);
  });

  test('없거나 이상한 토큰은 받는다', () => {
    eq(tokenNeedsRefresh(null, 0), true);
    eq(tokenNeedsRefresh(undefined, 0), true);
    eq(tokenNeedsRefresh({ accessToken: '', expiresAtMs: 10_000_000 }, 0), true);
    eq(tokenNeedsRefresh({ accessToken: 'a', expiresAtMs: NaN }, 0), true);
  });

  // ── 주문 본문 ───────────────────────────────────────────
  const good = {
    cano: '12345678', acntPrdtCd: '01', symbol: '005930',
    side: 'BUY' as const, quantity: 10, orderType: 'MARKET' as const,
  };

  test('시장가는 구분 01 · 단가 0', () => {
    const p = buildOrderBody(good);
    eq(p.ok, true);
    eq(p.body!.ORD_DVSN, '01');
    eq(p.body!.ORD_UNPR, '0');
    eq(p.body!.PDNO, '005930');
    eq(p.body!.ORD_QTY, '10');
  });

  test('지정가는 구분 00 · 단가 그대로', () => {
    const p = buildOrderBody({ ...good, orderType: 'LIMIT', price: 70000 });
    eq(p.body!.ORD_DVSN, '00');
    eq(p.body!.ORD_UNPR, '70000');
  });

  test('지정가인데 가격이 없으면 본문을 안 만든다', () => {
    // 0으로 채워 보내면 KIS가 그것대로 해석해서 엉뚱한 주문이 나간다.
    eq(buildOrderBody({ ...good, orderType: 'LIMIT' }).body, null);
    eq(buildOrderBody({ ...good, orderType: 'LIMIT', price: 0 }).body, null);
    eq(buildOrderBody({ ...good, orderType: 'LIMIT', price: null }).body, null);
  });

  test('소수 주는 거부한다', () => {
    // 반올림해서 보내면 의도와 다른 수량이 나간다.
    const p = buildOrderBody({ ...good, quantity: 1.5 });
    eq(p.ok, false);
    assert(p.reason.includes('소수점'), p.reason);
  });

  test('수량이 0이거나 음수면 거부한다', () => {
    eq(buildOrderBody({ ...good, quantity: 0 }).ok, false);
    eq(buildOrderBody({ ...good, quantity: -5 }).ok, false);
    eq(buildOrderBody({ ...good, quantity: NaN }).ok, false);
  });

  test('종목코드는 여섯 자리여야 한다', () => {
    // 다섯 자리를 보내면 KIS는 앞을 0으로 채워 주지 않고 거부한다.
    eq(buildOrderBody({ ...good, symbol: '5930' }).ok, false);
    eq(buildOrderBody({ ...good, symbol: 'AAPL' }).ok, false);
    eq(buildOrderBody({ ...good, symbol: '' }).ok, false);
  });

  test('계좌번호가 이상하면 거부한다', () => {
    eq(buildOrderBody({ ...good, cano: '1234' }).ok, false);
    eq(buildOrderBody({ ...good, acntPrdtCd: '1' }).ok, false);
  });

  test('방향이 이상하면 거부한다', () => {
    eq(buildOrderBody({ ...good, side: 'LONG' as any }).ok, false);
    eq(buildOrderBody({ ...good, side: '' as any }).ok, false);
  });

  test('거부할 때는 이유를 적는다', () => {
    const p = buildOrderBody({ ...good, symbol: 'AAPL' });
    assert(p.reason.includes('AAPL'), p.reason);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(buildOrderBody({} as any).ok, false);
    eq(buildOrderBody(null as any).ok, false);
  });

  // ── 계좌번호 ────────────────────────────────────────────
  test('계좌번호를 앞 8 · 뒤 2로 나눈다', () => {
    eq(splitAccountNo('12345678-01')!.cano, '12345678');
    eq(splitAccountNo('12345678-01')!.acntPrdtCd, '01');
    eq(splitAccountNo('1234567801')!.cano, '12345678');
  });

  test('열 자리가 아니면 null이다 — 잘라서 쓰지 않는다', () => {
    eq(splitAccountNo('123456'), null);
    eq(splitAccountNo('123456780123'), null);
    eq(splitAccountNo(''), null);
    eq(splitAccountNo(null), null);
  });

  // ── 시세 ────────────────────────────────────────────────
  test('현재가를 읽는다', () => {
    eq(priceFrom(parseKisBody({ rt_cd: '0', output: { stck_prpr: '70500' } })), 70500);
  });

  test('현재가를 못 읽으면 null이다 — 0이 아니다', () => {
    // 0으로 두면 명목가가 0이 되어 증거금 검사도 손절 계산도 전부 통과한다.
    eq(priceFrom(parseKisBody({ rt_cd: '0', output: {} })), null);
    eq(priceFrom(parseKisBody({ rt_cd: '0', output: { stck_prpr: '' } })), null);
    eq(priceFrom(parseKisBody({ rt_cd: '0', output: { stck_prpr: '0' } })), null);
    eq(priceFrom(parseKisBody({ rt_cd: '1', msg1: '오류' })), null);
  });

  // ── 잔고 ────────────────────────────────────────────────
  test('보유 종목을 읽는다', () => {
    const r = holdingsFrom(parseKisBody({
      rt_cd: '0',
      output1: [{ pdno: '005930', prdt_name: '삼성전자', hldg_qty: '10', pchs_avg_pric: '68000', prpr: '70000', evlu_amt: '700000', evlu_pfls_amt: '20000' }],
    }));
    eq(r!.length, 1);
    eq(r![0].symbol, '005930');
    eq(r![0].quantity, 10);
    eq(r![0].pnl, 20000);
  });

  test('수량 0인 줄은 뺀다', () => {
    // KIS는 당일 전량 매도한 종목도 한동안 0주로 남긴다.
    const r = holdingsFrom(parseKisBody({
      rt_cd: '0',
      output1: [{ pdno: '005930', hldg_qty: '0' }, { pdno: '069500', hldg_qty: '5' }],
    }));
    eq(r!.length, 1);
    eq(r![0].symbol, '069500');
  });

  test('모양이 바뀌면 빈 배열이 아니라 null이다', () => {
    // 응답 모양이 바뀐 것을 '보유 없음'으로 읽으면 자산이 0으로 보인다.
    eq(holdingsFrom(parseKisBody({ rt_cd: '0' })), null);
    eq(holdingsFrom(parseKisBody({ rt_cd: '1', msg1: '오류' })), null);
  });

  test('진짜로 아무것도 없으면 빈 배열이다', () => {
    eq(holdingsFrom(parseKisBody({ rt_cd: '0', output1: [] }))!.length, 0);
  });

  test('주문가능현금을 읽는다', () => {
    eq(cashFrom(parseKisBody({ rt_cd: '0', output2: [{ ord_psbl_cash: '5000000' }] })), 5_000_000);
  });

  test('현금을 못 읽으면 null이다 — 0도 큰 값도 아니다', () => {
    // 0으로 두면 "돈이 없다"가 되어 막히는데, 그건 확인한 사실이 아니다.
    // 반대로 큰 값으로 두면 증거금 검사가 껍데기가 된다.
    eq(cashFrom(parseKisBody({ rt_cd: '0' })), null);
    eq(cashFrom(parseKisBody({ rt_cd: '0', output2: [] })), null);
    eq(cashFrom(parseKisBody({ rt_cd: '0', output2: [{}] })), null);
  });

  test('진짜 0원은 0으로 읽는다', () => {
    // 못 읽은 것과 진짜 0을 섞으면 안 된다.
    eq(cashFrom(parseKisBody({ rt_cd: '0', output2: [{ ord_psbl_cash: '0' }] })), 0);
  });
}
