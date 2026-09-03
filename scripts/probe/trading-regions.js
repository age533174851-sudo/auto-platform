// 영역 식별 — base(속성 없음)와 head(속성 있음) 양쪽에서 동작해야 한다.
// data-region이 있으면 그것을 쓰고, 없으면 화면 내용으로 찾는다.
// 이 함수가 영역을 못 찾으면 "겹침 0"이 아니라 **측정 실패**로 보고한다.
window.__findRegions = function () {
  const cs = getComputedStyle;
  const vis = e => { const s = cs(e); const b = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && b.width > 1 && b.height > 1; };
  const txt = e => (e.textContent || '').trim();
  const byAttr = n => document.querySelector(`[data-region="${n}"]`);

  const mc = document.querySelector('.mc');
  const found = { menu: document.querySelector('.sb'), newsRail: document.querySelector('.rp'), center: mc };
  const how = {};

  // 지금 어떤 배치인가. 태블릿·모바일에 데스크톱 계약(주문 340px 상주)을
  // 적용하면 통과할 수 없는 조건을 요구하게 된다.
  const shell = document.querySelector('[data-region="tradingShell"]');
  const kind = shell ? (shell.getAttribute('data-mode') || 'mobile') : 'desktop';

  for (const n of ['market', 'chart', 'order', 'info']) {
    const a = byAttr(n);
    if (a && vis(a)) { found[n] = a; how[n] = 'attr'; }
  }

  if (!mc) return { found, how, ok: false, reason: '.mc 없음' };

  // 앵커에서 위로 올라가며 "가로 열"을 찾는다: .mc의 자손 중 높이가 크고
  // 폭이 .mc보다 뚜렷이 좁은 블록
  const columnOf = (anchor) => {
    let n = anchor;
    while (n && n !== mc) {
      const b = n.getBoundingClientRect();
      const mb = mc.getBoundingClientRect();
      if (b.height > mb.height * 0.35 && b.width < mb.width * 0.75 && b.width > 80) return n;
      n = n.parentElement;
    }
    return null;
  };

  if (!found.order) {
    const btn = [...mc.querySelectorAll('button')].find(e => vis(e) && /롱 진입|매수|Buy/.test(txt(e)));
    const col = btn && columnOf(btn);
    if (col) { found.order = col; how.order = 'anchor:롱 진입'; }
  }
  if (!found.market) {
    const inp = [...mc.querySelectorAll('input')].find(e => vis(e) && /종목|검색/.test(e.placeholder || ''));
    const col = inp && columnOf(inp);
    if (col) { found.market = col; how.market = 'anchor:종목 검색'; }
  }
  if (!found.chart) {
    // 차트는 시장/주문 사이에 남는 가장 넓은 블록
    const mb = mc.getBoundingClientRect();
    const cands = [...mc.querySelectorAll('div')].filter(e => {
      if (!vis(e)) return false;
      const b = e.getBoundingClientRect();
      if (b.height < mb.height * 0.3 || b.width < 120) return false;
      if (found.order && (found.order.contains(e) || e.contains(found.order))) return false;
      if (found.market && (found.market.contains(e) || e.contains(found.market))) return false;
      return true;
    });
    cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    if (cands[0]) { found.chart = cands[0]; how.chart = 'anchor:잔여 최대폭'; }
  }
  // 상단바 — 표식이 없는 base에서도 재야 전후 비교가 된다.
  if (!found.topbar) {
    const a = document.querySelector('[data-region="topbar"]');
    if (a && vis(a)) { found.topbar = a; how.topbar = 'attr'; }
    else if (mc) {
      const mb = mc.getBoundingClientRect();
      const bar = [...mc.querySelectorAll('div')].find(e => {
        if (!vis(e)) return false;
        const b = e.getBoundingClientRect();
        return b.height >= 44 && b.height <= 64 && b.width > mb.width * 0.9 && b.top < mb.top + 80;
      });
      if (bar) { found.topbar = bar; how.topbar = 'anchor:상단 52px 줄'; }
    }
  }

  if (kind !== 'desktop') {
    // 단일 열 배치다. 상주 주문/종목 열이 **없는 것이 정상**이다.
    return { found: { ...found, chart: found.chart || shell }, how, kind, ok: true, reason: '' };
  }
  const ok = !!(found.order && found.market && found.chart);
  return { found, how, kind, ok, reason: ok ? '' : `못 찾음: ${['order','market','chart'].filter(k=>!found[k]).join(',')}` };
};
