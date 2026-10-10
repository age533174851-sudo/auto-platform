// 사용자 화면에서 읽기 전용 Binance 선물 진단을 제공할 수 있는 연결.
// 서버의 binanceTestnetDiagnoseGate는 별도로 반드시 시행한다.
// '모르겠다'(null/undefined)를 TESTNET으로 간주하지 않는다.
export function showBinanceTestnetDiagnosis(
  exchange: string | null | undefined,
  isTestnet: boolean | null | undefined,
): boolean {
  return exchange === 'binance' && isTestnet === true;
}
