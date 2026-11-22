// src/lib/ui/reportSource.test.ts
//
// 인텔리전스 → 손익리포트 탭은 `/api/intel?action=tax`가 **지어낸** 월별
// 손익·수수료·예상 세금(`source: 'mock'`)을 "손익 · 세금 리포트"라는 제목
// 아래 그대로 그렸다. 같은 파일의 온체인 탭은 `source === 'mock'`이면
// "모의 데이터"라고 적는데 이 탭만 적지 않았다 — 사용자는 그 숫자를 자기
// 거래 기록과 세금 추정으로 읽는다.
import { test, assert, eq } from '../../test/harness';
import { readFileSync, existsSync } from 'node:fs';
import { taxReportSourceNotice } from './reportSource';

export function runReportSourceTests() {
  console.log('[손익리포트 — 지어낸 숫자를 내 기록처럼 그리지 않는다]');

  test('★ source가 mock이면 모의 데이터라고 말한다', () => {
    const n = taxReportSourceNotice('mock');
    assert(n != null, '모의 데이터인데 고지가 없습니다');
    assert(n!.includes('모의'), n!);
    assert(n!.includes('실제 거래 기록이 아닙니다'), n!);
  });

  test('★ source를 못 읽으면 실제 기록으로 적지 않는다', () => {
    for (const s of [undefined, null, '', '  ', 42, {}]) {
      const n = taxReportSourceNotice(s);
      assert(n != null, `출처 ${JSON.stringify(s)}를 실제 기록으로 취급했습니다`);
      assert(n!.includes('확인하지 못했습니다'), n!);
    }
  });

  test('출처가 실제 장부로 적혀 있으면 고지를 띄우지 않는다', () => {
    eq(taxReportSourceNotice('ledger'), null);
  });

  test('★ 손익리포트 화면이 이 고지를 실제로 부른다', () => {
    const p = 'src/components/IntelligencePage.tsx';
    const src = existsSync(p) ? readFileSync(p, 'utf8') : null;
    assert(src != null, `${p}를 읽지 못했습니다 (통과로 적지 않습니다)`);
    const tax = src!.slice(src!.indexOf('function TaxTab'), src!.indexOf('function SimulatorTab'));
    assert(tax.length > 0, 'TaxTab을 찾지 못했습니다');
    assert(tax.includes('taxReportSourceNotice(data'),
      'TaxTab이 출처 고지를 부르지 않습니다 — 모의 손익을 실제 기록처럼 그립니다');
  });
}
