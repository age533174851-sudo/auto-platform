const icons = {
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/>',
  bot: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 7V3m-2 0h4M2 12v4m20-4v4M9 16h6"/><path d="M8 11h.01m8-.01h.01" stroke-width="2.8"/>',
  trade: '<path d="M3 20h18M7 4v3m0 5v4m5-14v5m0 5v3m5-10v4m0 5v3"/><rect x="5.5" y="7" width="3" height="5" rx=".7"/><rect x="10.5" y="7" width="3" height="5" rx=".7"/><rect x="15.5" y="9" width="3" height="5" rx=".7"/>',
  lock: '<rect x="5" y="11" width="14" height="11" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4m-4 5v2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  source: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6"/>',
  wallet: '<path d="M21 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V6m18 6h-5a1 1 0 0 0 0 3h5"/>',
  trophy: '<path d="M8 3h8v7a4 4 0 0 1-8 0zm4 11v5m-4 2h8M8 6H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4"/>',
  flask: '<path d="M9 3h6m-5 0v6l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3M8 14h8"/>',
  trend: '<path d="M3 3v18h18M7 15l4-5 4 3 5-6"/>',
  pulse: '<path d="M2 12h5l3-7 4 14 3-7h5"/>',
  power: '<path d="M12 2v10m5-7a8 8 0 1 1-10 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="m3 10 18-7-7 18-3-8-8-3Zm8 3L21 3"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  shield: '<path d="m12 22 5-3.5a7 7 0 0 0 3-5.7V6l-8-3-8 3v6.8a7 7 0 0 0 3 5.7Z"/><path d="M12 8v4m0 4h.01"/>',
  radar: '<circle cx="12" cy="12" r="9"/><path d="M12 12l6-6m-3.1 3.1a4 4 0 1 0 1 4.9m-3.9-2h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  position: '<rect x="4" y="7" width="16" height="14" rx="2"/><path d="M9 7V4h6v3M4 13h16m-9 0v2h2v-2"/>',
};

const scopes = {
  paper: {
    label: '모의투자', icon: 'wallet', equity: 61258.32, cash: 61258.32, margin: 0, unrealized: 0,
    date: '11.07 기록', accountNote: '11.07 게시 · 시각 미확인',
    returnReason: '입출금 원장 없음', engineReason: '서버 반복 실행 상태를 조회할 수 없습니다.',
  },
  challenge: {
    label: '챌린지', icon: 'trophy', equity: 10000, initial: 10000, target: 12000, floor: 8000,
    date: '11.07 기록', accountNote: '11.07 게시 · 시각 미확인',
    returnReason: '손익 원장 미확인', engineReason: '챌린지 계좌의 반복 상태를 확인할 수 없습니다.',
  },
  testnet: {
    label: '테스트넷', icon: 'flask', date: '11.13 기록', accountNote: '테스트넷 계좌 잔고 미조회',
    returnReason: '계좌 자료 미조회', engineReason: '이전 예약·평가 기록만 확인할 수 있습니다.',
  },
};
const screens = {
  auto: { label: '자동매매', icon: 'bot', description: '계좌 잔고와 자동매매 진행 상태를 확인하세요.' },
  home: { label: '홈', icon: 'home', description: '계좌별 순자산과 손익, 자동매매 상태를 한눈에 확인하세요.' },
  trade: { label: '거래', icon: 'trade', description: '포지션과 주문 상태를 확인하고 모의 주문을 검토하세요.' },
};
const autoTabs = { overview: '개요', strategy: '전략', schedules: '예약', history: '기록', diagnostics: '진단' };
const tradeTabs = { positions: '포지션', pending: '미체결', fills: '체결 내역' };
const ledgerIssue = 'https://github.com/age533174851-sudo/auto-platform/issues/592';
const opsIssue = 'https://github.com/age533174851-sudo/auto-platform/issues/450';
const opsNov = opsIssue + '#issuecomment-6851029888';
const positionSource = 'https://github.com/age533174851-sudo/auto-platform/blob/main/src/components/trading/PositionsOrdersScreen.tsx';
const observation = {
  fullTime: '2026.11.13 19:31:38 KST', isoTime: '2026-11-13T10:31:38.386Z',
  code: 'NO_BREAKOUT', detail: '돌파 조건 미충족',
};
const history = [
  {
    type: 'decision', title: '돌파 조건 미충족', code: 'NO_BREAKOUT',
    time: observation.fullTime, isoTime: observation.isoTime,
    detail: '11월 13일 보고에 기록된 마지막 평가 시각과 결과 예시입니다. 결과의 종목은 보고에서 특정되지 않았습니다.',
  },
  {
    type: 'fill', title: 'ETHUSDT · BUY', code: 'FILLED',
    time: '2026.10.07 09:19:01 KST', isoTime: '2026-10-07T00:19:01Z',
    detail: 'Gate 테스트넷의 TRAIGO 장부 기록입니다. 거래소 체결 원본은 미대조입니다.',
  },
];
const filters = { all: '전체', decision: '판단', attempt: '주문 시도', fill: '체결' };
const formatNumber = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const main = document.querySelector('#main');
const dialog = document.querySelector('#detail-dialog');
let state = readRoute();
let dialogTrigger = null;

function icon(name, size = 19) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}
function brand(className = 'brand') {
  return `<a class="${className}" href="${route('auto')}" aria-label="TRAIGO 자동매매"><span class="brand-mark" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M12 6v13M6 14l3-3m6 0 3 3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><span class="wordmark">TRAIGO</span>${className === 'brand' ? '<span class="brand-caption">운용 콘솔</span>' : ''}</span></a>`;
}
function readRoute() {
  const [screen, scope, tab, filter] = location.hash.slice(2).split('/');
  return {
    screen: Object.hasOwn(screens, screen) ? screen : 'auto',
    scope: Object.hasOwn(scopes, scope) ? scope : 'paper',
    auto: Object.hasOwn(autoTabs, tab) ? tab : 'overview',
    trade: Object.hasOwn(tradeTabs, tab) ? tab : 'positions',
    filter: Object.hasOwn(filters, filter) ? filter : 'all',
  };
}
function route(screen = state.screen, scope = state.scope, tab, filter) {
  return `#/${[screen, scope, tab, filter].filter(Boolean).join('/')}`;
}
function account() { return scopes[state.scope]; }
function amount(value) { return value == null ? '미확인' : formatNumber.format(value); }
function chip(label, tone = '', dot = false) {
  return `<span class="chip ${tone}">${dot ? '<span class="dot"></span>' : ''}${label}</span>`;
}
function row(label, value, muted = false) {
  return `<div><dt>${label}</dt><dd${muted ? ' class="muted"' : ''}>${value}</dd></div>`;
}
function section(title, body, { iconName, badge = '', className = '', description = '' } = {}) {
  return `<section class="panel ${className}"><header class="section-head"><div><h2>${iconName ? `<span class="section-icon">${icon(iconName, 18)}</span>` : ''}${title}</h2>${description ? `<p>${description}</p>` : ''}</div>${badge}</header>${body}</section>`;
}
function empty(title, description, iconName = 'radar') {
  return `<div class="empty-box">${icon(iconName, 21)}<strong>${title}</strong><p>${description}</p></div>`;
}
function notice(message) {
  return `<div class="notice">${icon('info', 17)}<span>${message}</span></div>`;
}
function nav() {
  const order = ['home', 'auto', 'trade'];
  return order.map(id => {
    const screen = screens[id];
    return `<a class="nav-link" href="${route(id)}"${state.screen === id ? ' aria-current="page"' : ''}>${icon(screen.icon, 20)}<span>${screen.label}</span></a>`;
  }).join('');
}
function scopeSwitch() {
  const tab = state.screen === 'auto' ? state.auto : state.screen === 'trade' ? state.trade : undefined;
  return `<nav class="scope-switch" aria-label="계좌 선택">${Object.entries(scopes).map(([id, scope]) => `
    <a class="scope-link" href="${route(state.screen, id, tab)}"${state.scope === id ? ' aria-current="true"' : ''}>${icon(scope.icon)}${scope.label}</a>`).join('')}</nav>`;
}
function tabs(items, selected, label) {
  return `<nav class="tabs" aria-label="${label}">${Object.entries(items).map(([id, title]) => `
    <a class="tab" href="${route(state.screen, state.scope, id)}"${selected === id ? ' aria-current="true"' : ''}>${title}</a>`).join('')}</nav>`;
}
function summary() {
  const scope = account();
  const known = scope.equity != null;
  const equityRows = state.scope === 'challenge'
    ? row('초기자본', amount(scope.initial)) + row('목표', amount(scope.target)) + row('실패선', amount(scope.floor))
    : row('현금 잔고', amount(scope.cash), scope.cash == null) + row('사용 증거금', amount(scope.margin), scope.margin == null);
  return `<div class="summary">
    <section class="panel metric-card equity" aria-label="순자산">
      <div class="metric-heading"><h2>${icon('wallet', 18)}순자산</h2><span class="unit">USDT</span></div>
      <div class="big-value ${known ? '' : 'textual'}">${amount(scope.equity)}</div>
      <dl class="metric-details">${equityRows}</dl>
      <p class="metric-note">${scope.accountNote}</p>
    </section>
    <section class="panel metric-card" aria-label="거래 손익">
      <div class="metric-heading"><h2>${icon('trend', 18)}누적 순손익</h2></div>
      <div class="big-value textual">계산 불가</div>
      <dl class="metric-details">${row('오늘 손익', '미확인', true)}${row('미실현', scope.unrealized != null ? '0 USDT' : '미확인', scope.unrealized == null)}</dl>
      <p class="metric-note">수익률 계산 불가 · ${scope.returnReason}</p>
    </section>
  </div>`;
}
function stages() {
  const testnet = state.scope === 'testnet';
  const badgeUnknown = chip('미확인', '', true);
  const stageItems = [
    ['power', '설정', testnet ? '11.13 관측 · 활성 예약 2건' : '서버 반복 실행 설정', testnet ? chip('이전 기록', 'warn', true) : badgeUnknown],
    ['clock', '스케줄 평가', testnet ? '11.13 19:31 KST · 마지막 관측' : '서버 틱 기록 미조회', testnet ? chip('STALE', 'warn', true) : badgeUnknown],
    ['send', '주문 시도', '주문 전송 기록 미조회', badgeUnknown],
    ['check', '체결 확인', '평가에 연결된 체결 기록 미조회', badgeUnknown],
  ];
  const rows = stageItems.map(([symbol, label, detail, badge]) => `
    <li class="stage-row"><span class="stage-icon">${icon(symbol)}</span><div><p class="stage-label">${label}</p><p class="stage-detail">${detail}</p></div>${badge}</li>`).join('');
  return section('엔진 상태', `
    <ol class="stage-list">${rows}</ol>
    <div class="section-foot"><p>${account().engineReason}</p><a href="${route('auto', state.scope, 'diagnostics')}" class="ghost">진단 보기</a></div>`,
    { iconName: 'pulse', badge: chip('현재 미확인', 'warn', true) });
}
function latestDecision() {
  const testnet = state.scope === 'testnet';
  const box = testnet
    ? empty(observation.detail, '보고에서 확인된 결과 예시 · ' + observation.code)
    : empty('판단 기록 미확인', '이 계좌의 마지막 평가 시각과 판단 결과를 조회할 수 없습니다.');
  return section('최근 판단', `
    <div class="latest">${box}<dl class="record-dl">
      ${row('마지막 평가', testnet ? `<time datetime="${observation.isoTime}">11.13 19:31:38 KST</time>` : '미확인', !testnet)}
      ${row('최근 오류', '미확인', true)}
      ${row('킬스위치', '미확인', true)}
    </dl></div>
    <div class="section-foot"><p>${testnet ? '출처 #450 · 과거 관측' : '계좌별 실행 기록'}</p><a href="${route('auto', state.scope, 'history')}" class="ghost">기록 보기</a></div>`,
    { iconName: 'radar', badge: testnet ? chip('STALE', 'warn') : '' });
}
function autoOverview() {
  return `<div class="section-grid">${stages()}${latestDecision()}</div>`;
}
function autoStrategy() {
  const testnet = state.scope === 'testnet';
  const details = testnet
    ? `<div class="empty-box"><strong>Scalp v1</strong><p>11.13 보고에 기록된 테스트넷 예약의 전략입니다.</p></div><dl class="record-dl">${
      row('전략 ID', 'scalp') + row('버전', '1') + row('설정된 주기', '60분') + row('현재 실행', '미확인', true)}</dl>`
    : empty('선택된 전략 미확인', '이 계좌에 등록된 전략과 현재 설정은 조회할 수 없습니다.');
  return section('전략', `<div class="body-pad">${details}<div class="actions"><a class="button" href="${route('auto', state.scope, 'schedules')}">예약 확인</a></div></div>`,
    { iconName: 'layers', badge: testnet ? chip('이전 기록', 'warn') : '' });
}
function autoSchedules() {
  const details = state.scope === 'testnet'
    ? `<div class="empty-box"><strong>활성 예약 2건 관측</strong><p>2026.11.13 기록 · 현재 활성 여부와 다음 실행 시각은 미확인입니다.</p></div>
      <dl class="record-dl">${row('전략', 'Scalp v1')}${row('설정된 주기', '60분')}${row('다음 평가', '미확인', true)}</dl>
      <details class="details"><summary>예약 기록 상세 ${icon('down', 16)}</summary>
        <dl class="record-dl">${row('출처', '#450 · 11.13 관측')}${row('실행 환경', 'TESTNET')}${row('마지막 평가 관측', '11.13 19:31:38 KST')}</dl>
      </details>`
    : empty('예약 목록 미확인', '이 계좌의 반복 실행 설정과 다음 평가 시각을 조회할 수 없습니다.', 'clock');
  return section('실행 예약', `<div class="body-pad">${details}</div>`, { iconName: 'clock' });
}
function eventList(list, emptyTitle, emptyDetail) {
  if (!list.length) return empty(emptyTitle, emptyDetail, 'source');
  return list.map(event => `<article class="event"><div class="chips">${chip(event.code, event.type === 'fill' ? 'good' : '')}</div><h3>${event.title}</h3>
    <time datetime="${event.isoTime}">${event.time}</time><p>${event.detail}</p></article>`).join('');
}
function autoHistory() {
  const available = state.scope === 'testnet' ? history : [];
  const list = available.filter(event => state.filter === 'all' || state.filter === event.type);
  const links = Object.entries(filters).map(([id, title]) =>
    `<a class="filter" href="${route('auto', state.scope, 'history', id)}"${state.filter === id ? ' aria-current="true"' : ''}>${title}</a>`).join('');
  return section('실행 기록', `<div class="body-pad"><nav class="filters" aria-label="기록 필터">${links}</nav>
    ${eventList(list, '기록 미확인', '선택한 계좌와 기록 유형에서 확인 가능한 관측값이 없습니다.')}</div>`, { iconName: 'source' });
}
function autoDiagnostics() {
  const old = state.scope === 'testnet';
  const content = `<div class="body-pad">${notice('이 화면은 저장소에 기록된 자료를 보여줍니다. 현재 상태는 운영 환경에서 확인해야 합니다.')}
    <dl class="record-dl">
      ${row('실행기 상태', 'UNKNOWN', true)}
      ${row('마지막 평가 기록', old ? 'STALE · 11.13 19:31:38 KST' : 'UNKNOWN', !old)}
      ${row('킬스위치', 'UNKNOWN', true)}
      ${row('오류 상세', 'UNKNOWN', true)}
    </dl>
    <details class="details"><summary>상태 표시 기준 ${icon('down', 16)}</summary>
      <p class="muted">STALE은 과거에 수집된 값입니다. UNKNOWN은 현재 표시할 근거가 없다는 뜻입니다.</p>
    </details>
    <div class="actions"><button class="button" type="button" data-dialog="sources">데이터 출처</button></div></div>`;
  return section('시스템 진단', content, { iconName: 'shield' });
}
function auto() {
  const views = { overview: autoOverview, strategy: autoStrategy, schedules: autoSchedules, history: autoHistory, diagnostics: autoDiagnostics };
  return summary() + tabs(autoTabs, state.auto, '자동매매 화면') + views[state.auto]();
}
function home() {
  const label = state.scope === 'testnet' ? '테스트넷 거래 상태' : '모의 주문 검토';
  const shortcuts = `<div class="body-pad">
    <a class="quick-link" href="${route('auto')}"><span class="stage-icon">${icon('bot', 17)}</span><span><strong>자동매매 개요</strong><small>설정 · 평가 · 주문 · 체결</small></span></a>
    <a class="quick-link" href="${route('trade')}"><span class="stage-icon">${icon('trade', 17)}</span><span><strong>${label}</strong><small>${account().label} · 포지션 관리 화면</small></span></a>
  </div>`;
  return summary() + `<div class="section-grid home-content">${stages()}<div class="stack">
    ${section('열린 포지션', `<div class="body-pad">${empty('포지션 미확인', '선택한 계좌의 보유 포지션을 조회할 수 없습니다.', 'position')}</div>`, { iconName: 'position' })}
    ${section('바로가기', shortcuts, { iconName: 'layers' })}</div></div>`;
}
function tradePositions() {
  const messages = {
    positions: ['열린 포지션 미확인', '선택한 계좌의 보유 수량과 진입가를 조회할 수 없습니다.'],
    pending: state.scope === 'testnet'
      ? ['미체결 주문 미확인', '테스트넷 계좌의 미체결 목록을 조회할 수 없습니다.']
      : ['대기 주문 미지원', '모의 장부는 시장가 즉시 체결만 지원합니다.'],
    fills: state.scope === 'testnet'
      ? ['체결 미확인', '선택한 계좌의 체결 목록을 조회할 수 없습니다.']
      : ['체결 내역 조회 미지원', '기존 모의 주문 화면에는 체결 내역을 읽는 경로가 없습니다.'],
  };
  const [title, message] = messages[state.trade];
  return section('포지션 · 주문', `<div class="body-pad">
    ${tabs(tradeTabs, state.trade, '포지션 및 주문')}
    ${empty(title, message, 'position')}
    ${state.scope === 'testnet' && state.trade === 'fills' ? `<div class="actions"><a class="button" href="${route('auto', 'testnet', 'history', 'fill')}">이전 체결 기록 보기</a></div>` : ''}
  </div>`, { className: 'trade-aside', iconName: 'position' });
}
function radio(name, value, label, checked) {
  return `<label class="radio-card"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><span class="radio-face">${label}</span></label>`;
}
function tradeOrder() {
  if (state.scope === 'testnet') {
    return section('테스트넷 주문', `<div class="body-pad">${empty('연결 상태 미확인', '거래소 연결, 실시간 시세와 거래 가능 잔고는 운영 화면에서 확인할 수 있습니다.', 'lock')}
      <div class="actions"><a class="button" href="${route('trade', 'paper')}">모의 주문 검토 열기</a></div></div>`, { iconName: 'trade' });
  }
  return section('모의 주문 검토', `<div class="body-pad">
    <form class="trade-form" id="order-form" novalidate>
      <fieldset><legend>종목 · USDⓈ-M 선물</legend><div class="symbol-picker">
        ${radio('symbol', 'BTCUSDT', '<span class="coin" aria-hidden="true">₿</span>BTCUSDT', true)}
        ${radio('symbol', 'ETHUSDT', '<span class="coin eth" aria-hidden="true">◆</span>ETHUSDT', false)}
      </div></fieldset>
      <fieldset><legend>진입 방향</legend><div class="symbol-picker">
        ${radio('side', 'LONG', '롱 (매수)', true)}
        ${radio('side', 'SHORT', '숏 (매도)', false)}
      </div></fieldset>
      <div><label for="order-amount" class="field-label">주문 명목가</label><div class="amount-wrap">
        <input id="order-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="금액 입력" aria-describedby="amount-error"><span>USDT</span>
      </div><p class="field-error" id="amount-error" aria-live="polite"></p></div>
      <button class="button primary" type="submit">주문 검토</button>
    </form></div>`, { iconName: 'trade', badge: chip('시장가'), description: '입력한 주문 정보를 미리 확인합니다.' });
}
function trade() {
  return summary() + `<div class="section-grid home-content">${tradeOrder()}${tradePositions()}</div>`;
}
function render() {
  const screen = screens[state.screen];
  document.title = `${screen.label} · TRAIGO`;
  document.querySelector('#sidebar').innerHTML = brand() + `<nav class="nav-list" aria-label="주요 화면">${nav()}</nav>
    <div class="sidebar-foot"><strong>${icon('lock', 16)}비공개 프로토타입</strong><p>저장소 기록으로 화면 비교</p></div>`;
  document.querySelector('#mobile-nav').innerHTML = nav();
  document.querySelector('#topbar').innerHTML = `<div class="top-location">${icon('layers', 17)}운용 콘솔</div>${brand('top-brand')}
    <div class="top-actions"><span class="top-status">${icon('lock', 15)}운영 미연결</span>
    <button class="ghost compact" type="button" data-dialog="sources">${icon('source')}출처</button></div>`;
  const views = { auto, home, trade };
  main.innerHTML = `<div class="page-head"><div><h1>${screen.label}</h1><p>${screen.description}</p></div>
    <div class="context-stamp">${icon('clock', 16)}${account().date} · KST</div></div>${scopeSwitch()}${views[state.screen]()}`;
}
function openDialog(title, body, trigger) {
  dialogTrigger = trigger;
  dialog.innerHTML = `<div class="dialog-inner"><header class="dialog-head"><h2 id="dialog-title">${title}</h2>
    <form method="dialog"><button type="submit" class="ghost icon-button" aria-label="닫기">${icon('close', 20)}</button></form></header>${body}</div>`;
  dialog.showModal();
  dialog.querySelector('button').focus();
}
function sources(trigger) {
  openDialog('데이터 출처', `<p>저장소와 이슈에 기록된 관측값을 표시합니다. 계좌 및 엔진의 현재 상태는 운영 화면에서 확인하세요.</p>
  <dl class="record-dl">${
    row('모의투자·챌린지 잔고', '2026.11.07 게시 기록') +
    row('테스트넷 실행기', '2026.11.13 과거 관측') +
    row('현재 계좌·실시간 시세', '미조회', true)}</dl>
  <div class="actions"><a class="source-link" href="${ledgerIssue}" target="_blank" rel="noopener noreferrer">잔고·UI 요구사항 #592</a>
  <a class="source-link" href="${opsNov}" target="_blank" rel="noopener noreferrer">테스트넷 관측 #450</a>
  <a class="source-link" href="${positionSource}" target="_blank" rel="noopener noreferrer">포지션·주문 화면 코드</a></div>`, trigger);
}
function review(event) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const raw = data.get('amount').trim();
  const nominal = Number(raw);
  const input = form.querySelector('#order-amount');
  const error = form.querySelector('#amount-error');
  const valid = /^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(nominal) && nominal > 0;
  if (!valid) {
    error.textContent = '0보다 큰 금액을 숫자로 입력하세요.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  const reviewAmount = raw.replace(/^0+(?=\d)/, '') + ' USDT';
  const symbol = data.get('symbol') === 'ETHUSDT' ? 'ETHUSDT' : 'BTCUSDT';
  const side = data.get('side') === 'SHORT' ? '숏 (매도)' : '롱 (매수)';
  openDialog('모의 주문 검토', `<p>검토용 입력값입니다. 제출·체결 단계는 운영 TRAIGO에서 진행됩니다.</p>
    <dl class="record-dl">
      ${row('대상 계좌', account().label)}
      ${row('시장 · 종목', 'USDⓈ-M · ' + symbol)}
      ${row('진입 방향', side)}
      ${row('주문 유형', '시장가')}
      ${row('입력 명목가', reviewAmount)}
      ${row('가격 · 필요 증거금', '미확인', true)}
    </dl><form method="dialog" class="actions end"><button class="button primary" type="submit">검토 닫기</button></form>`, event.submitter);
}
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-dialog="sources"]');
  if (trigger) sources(trigger);
  if (event.target.closest('.skip-link')) {
    event.preventDefault();
    main.focus();
  }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'order-form') review(event);
});
document.addEventListener('input', event => {
  if (event.target.id === 'order-amount') {
    event.target.removeAttribute('aria-invalid');
    document.querySelector('#amount-error').textContent = '';
  }
});
dialog.addEventListener('click', event => {
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }
});
dialog.addEventListener('close', () => {
  if (dialogTrigger?.isConnected) dialogTrigger.focus({ preventScroll: true });
  dialogTrigger = null;
});
window.addEventListener('hashchange', () => {
  const previous = state;
  if (dialog.open) dialog.close();
  state = readRoute();
  const order = document.querySelector('#order-form');
  const sameTradeAccount = previous.screen === 'trade' && state.screen === 'trade' && previous.scope === state.scope;
  const draft = order && sameTradeAccount ? new FormData(order) : null;
  const focusedRoute = document.activeElement?.getAttribute('href');
  render();
  if (draft) {
    const fields = document.querySelector('#order-form').elements;
    fields.namedItem('symbol').value = draft.get('symbol');
    fields.namedItem('side').value = draft.get('side');
    fields.namedItem('amount').value = draft.get('amount');
  }
  if (previous.screen !== state.screen) {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  } else if (focusedRoute) {
    const replacement = [...document.querySelectorAll('a')].find(link => link.getAttribute('href') === focusedRoute && link.getClientRects().length);
    if (replacement) replacement.focus({ preventScroll: true });
  }
});
render();
