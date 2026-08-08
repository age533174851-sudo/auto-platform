// src/lib/risk/killSwitchGate.test.ts
//
// 막으려는 것:
//  1. **조회 실패를 '꺼져 있음'으로 치는 것.** 예전에는
//     `catch { return { active: false } }`였다. DB가 한 번 흔들리면
//     킬스위치가 조용히 없어지고, 화면에는 여전히 '발동 중'이라고
//     떠 있는 채로 주문이 나간다. 계좌를 지키라고 켠 장치가 정작
//     지켜야 할 때 없다
//  2. 행이 없는 것을 실패로 오해하는 것 — 킬스위치를 한 번도 안 켠
//     계좌는 정상적으로 꺼진 상태다. 이걸 막으면 아무도 주문을 못 낸다
//  3. `if (ks.active)` 한 줄로 끝내는 것 — 그러면 readOk가 통과로 샌다
import { test, assert, eq } from '../../test/harness';
import { isKillSwitchActive, killSwitchGate } from './killSwitch';

/** 응답을 흉내 내는 최소 supabase */
const sbOf = (res: any) => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        limit: () => ({ maybeSingle: async () => res }),
      }),
    }),
  }),
});

const sbThrows = {
  from: () => { throw new Error('연결 끊김'); },
};

export function runKillSwitchGateTests() {
  console.log('[킬 스위치 — 못 읽은 것을 꺼진 것으로 치지 않는다]');

  test('조회가 실패하면 주문을 막는다', async () => {
    // 여기가 이 파일이 있는 이유다.
    const g = await killSwitchGate(sbOf({ data: null, error: { message: 'timeout' } }), 'c1');
    eq(g.allowed, false);
    eq(g.error, 'kill_switch_unknown');
    eq(g.status, 503);
    assert(g.message.includes('꺼진 것이 아닙니다'), g.message);
  });

  test('예외가 나도 막는다', async () => {
    const g = await killSwitchGate(sbThrows as any, 'c1');
    eq(g.allowed, false);
    eq(g.error, 'kill_switch_unknown');
  });

  test('켜져 있으면 막는다', async () => {
    const g = await killSwitchGate(sbOf({ data: { active: true, trigger_reason: '일손실 한도' }, error: null }), 'c1');
    eq(g.allowed, false);
    eq(g.error, 'kill_switch_active');
    eq(g.status, 423);
    assert(g.message.includes('일손실 한도'), g.message);
  });

  test('행이 없는 것은 실패가 아니다', async () => {
    // 킬스위치를 한 번도 안 켠 계좌다. 이걸 막으면 아무도 주문을 못 낸다.
    const g = await killSwitchGate(sbOf({ data: null, error: null }), 'c1');
    eq(g.allowed, true);
    eq(g.error, '');
  });

  test('꺼져 있으면 통과한다', async () => {
    const g = await killSwitchGate(sbOf({ data: { active: false, trigger_reason: null }, error: null }), 'c1');
    eq(g.allowed, true);
  });

  console.log('[킬 스위치 — 세 가지 사실을 구분한다]');

  test('켜짐·꺼짐·확인불가가 서로 다르다', async () => {
    const on = await isKillSwitchActive(sbOf({ data: { active: true, trigger_reason: 'x' }, error: null }), 'c');
    eq(on.active, true); eq(on.readOk, true);

    const off = await isKillSwitchActive(sbOf({ data: { active: false, trigger_reason: null }, error: null }), 'c');
    eq(off.active, false); eq(off.readOk, true);

    const unknown = await isKillSwitchActive(sbOf({ data: null, error: { message: 'boom' } }), 'c');
    eq(unknown.active, false, '확인 못 한 것을 켜졌다고도 하지 않는다');
    eq(unknown.readOk, false, '**이 칸이 없으면 확인불가가 꺼짐과 구분되지 않는다**');
  });

  test('확인 불가일 때 active만 보면 통과로 샌다', async () => {
    // `if (ks.active) block` 한 줄로 끝내면 이렇게 된다.
    // killSwitchGate를 쓰라는 이유가 이것이다.
    const ks = await isKillSwitchActive(sbOf({ data: null, error: { message: 'boom' } }), 'c');
    eq(ks.active, false, 'active만 보면 통과한다');
    const g = await killSwitchGate(sbOf({ data: null, error: { message: 'boom' } }), 'c');
    eq(g.allowed, false, '관문은 막는다');
  });
}
