// src/lib/mock.ts
// Shared mock data — used by HedgeOSPage, WunderPage, and other infra pages.
// Safe to import in client components.

export interface ExchangeHealth {
  name:       string;
  icon:       string;
  status:     'ok' | 'slow' | 'error' | 'maintenance' | 'unknown';
  latency:    number;
  wsStatus:   boolean;
  lastCheck:  string;
}

export interface RecoveryEvent {
  id:       string;
  type:     string;
  desc:     string;
  action:   string;
  time:     string;
  resolved: boolean;
}

export const MOCK_EXCHANGE_HEALTH: ExchangeHealth[] = [
  { name:'Binance', icon:'🟡', status:'ok',          latency:142, wsStatus:true,  lastCheck:'방금' },
  { name:'Upbit',   icon:'🔵', status:'ok',          latency:88,  wsStatus:true,  lastCheck:'방금' },
  { name:'Gate.io', icon:'🔵', status:'slow',        latency:892, wsStatus:true,  lastCheck:'1분 전' },
  { name:'Bithumb', icon:'🟢', status:'ok',          latency:203, wsStatus:true,  lastCheck:'방금' },
  { name:'Bybit',   icon:'🟡', status:'maintenance', latency:0,   wsStatus:false, lastCheck:'10분 전' },
];

export const MOCK_RECOVERY: RecoveryEvent[] = [
  { id:'r1', type:'WS 재연결',   desc:'Binance WebSocket 연결 끊김',  action:'3초 후 자동 재연결 성공', time:'09:32',     resolved:true  },
  { id:'r2', type:'API 타임아웃', desc:'Gate.io API 응답 지연 892ms', action:'폴링 모드로 전환',       time:'08:15',     resolved:true  },
  { id:'r3', type:'포지션 불일치',desc:'SOL 포지션 0.1 단위 불일치 감지',action:'수동 확인 필요',       time:'어제 22:00', resolved:false },
];

export default { MOCK_EXCHANGE_HEALTH, MOCK_RECOVERY };
