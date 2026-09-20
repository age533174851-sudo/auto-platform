// src/lib/ui/useUiLevel.ts
//
// **지금 어느 밀도인가 — 화면들이 같은 답을 보게 한다.**
//
// 컴포넌트마다 `useState(() => loadPrefs().uiLevel)`을 들면 토글한 쪽만
// 바뀌고 나머지는 옛 값에 갇힌다. `usePaperTarget`이 이미 그 고장을 겪고
// 구독 방식으로 바꿨다 — 여기도 같은 방식이다.
//
// 저장소를 새로 만들지 않는다. 정본은 `preferences.ts`이고 이 파일은
// 그것을 **React에 연결하는 얇은 껍데기**다.

import { useEffect, useState } from 'react';
import {
  getUiLevel, setUiLevel, subscribePrefs, otherUiLevel, type TradeUiLevel,
} from './preferences';

export function useUiLevel(): [TradeUiLevel, (l: TradeUiLevel) => void, () => void] {
  // 서버에서는 localStorage가 없다. 기본값으로 그리고, 붙은 뒤에 맞춘다 —
  // 그래야 hydration에서 두 판이 갈리지 않는다.
  const [level, setLevel] = useState<TradeUiLevel>('BEGINNER');

  useEffect(() => {
    const read = () => setLevel(getUiLevel());
    read();
    return subscribePrefs(read);
  }, []);

  return [level, setUiLevel, () => setUiLevel(otherUiLevel(getUiLevel()))];
}
