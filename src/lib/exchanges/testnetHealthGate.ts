// 서버 환경변수 키를 이용한 진단은 TESTNET 전용이며, 계정 공유 상태를
// 검사하므로 API에서는 이 판정에 앞서 requireAdmin으로 인증해야 한다.
// 이 함수는 URL의 의도만 보고 네트워크나 키에 접근하지 않는다.
export type EnvHealthExchange = 'binance' | 'gate';

export type EnvHealthProbeVerdict = {
  ok: boolean;
  code: 'READY' | 'LIVE_PROBE_FORBIDDEN' | 'UNSUPPORTED_EXCHANGE';
  exchange: EnvHealthExchange | null;
};

export function envHealthProbeVerdict(input: {
  hasLiveQuery: boolean;
  exchange: string | null | undefined;
}): EnvHealthProbeVerdict {
  if (input?.hasLiveQuery !== false) {
    // ?live=0 등도 거부한다. LIVE를 선택하는 스위치 자체가 존재하면 거부.
    return { ok: false, code: 'LIVE_PROBE_FORBIDDEN', exchange: null };
  }
  const raw = String(input.exchange ?? '').trim();
  if (raw && raw !== 'binance' && raw !== 'gate') {
    return { ok: false, code: 'UNSUPPORTED_EXCHANGE', exchange: null };
  }
  return { ok: true, code: 'READY', exchange: raw ? raw as EnvHealthExchange : null };
}
