# TRAIGO Worker

브라우저를 닫아도 도는 실행기. Fly.io에 별도로 올린다.

```
Vercel (웹 · HTTP API)        Supabase (runtime_jobs · ticks · leases · 장부)
        │                              ▲
        └──────────────────────────────┤
                                       │
                        Fly.io Tokyo — traigo-worker
                        (10초 폴링 · 임대 · 심장박동 · 실행)
                                       │
                                       ├── Gate
                                       └── Binance
```

## 왜 웹과 분리하는가

Vercel 함수는 요청이 올 때만 돈다. 요청이 없으면 아무것도 안 돈다 —
그래서 "브라우저를 닫아도 자동매매가 계속된다"를 Vercel만으로는 만들 수 없다.
Worker는 계속 살아 있는 프로세스여야 한다.

## 왜 Fly에 묶지 않는가

**판정은 `src/lib/runtime/workerPlan.ts`에 있고, 그 파일은 Fly를 모른다.**
`fetch`도 `process`도 쓰지 않는 순수 함수뿐이다.

호스트는 바뀐다. 전략이 늘어 초 단위가 필요해지거나 서울 리전이 필요해지면
Railway나 Cloud Run으로 옮긴다. 그때 **판정까지 같이 옮겨 쓰면 옮기는 김에
규칙이 조금씩 달라지고**, "재시작 후 중복 주문 없음"을 새 호스트에서 처음부터
다시 증명해야 한다.

그래서 이 디렉터리에는 껍데기만 둔다 — 프로세스, 시그널, 배포 설정.

## 배포 (컴퓨터에서 한 번만)

Fly는 CLI가 필요하다. 휴대폰에서는 안 된다.

```bash
# 1) flyctl 설치
curl -L https://fly.io/install.sh | sh

# 2) 로그인
fly auth login

# 3) 앱 만들기 (이 저장소 루트에서)
fly launch --no-deploy --name traigo-worker --region nrt

# 4) 비밀값 넣기 — 값은 직접 입력한다
fly secrets set SUPABASE_URL=...
fly secrets set SUPABASE_SERVICE_ROLE_KEY=...

# 5) 배포
fly deploy

# 6) 로그 확인
fly logs
```

### 고정 outbound IP (거래소 API 키 화이트리스트용)

거래소 키에 IP 제한을 걸려면 Worker의 나가는 IP가 고정이어야 한다.

```bash
fly ips allocate-v4
fly ips list      # 여기 나온 IPv4를 거래소 키 화이트리스트에 넣는다
```

Machine이 교체돼도 **앱 단위 egress IP는 유지된다.**

## 비밀값

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL` | DB 주소 |
| `SUPABASE_SERVICE_ROLE_KEY` | DB 쓰기 (RLS 우회) |

**이 값들을 채팅에 붙여넣지 마세요.** `fly secrets set`으로 직접 넣으면 됩니다.

거래소 키는 Worker가 DB(`exchange_connections`)에서 읽는다 — Fly에 따로 넣지 않는다.
키가 두 곳에 있으면 한쪽만 갱신되는 일이 생긴다.

## 지금 상태

**심장박동까지만 구현했다.** 실제 판단·주문은 아직 붙지 않았다.

이유: 붙이기 전에 열 가지가 실제로 검증돼야 한다 (배포 → 심장박동 → UI HEALTHY
→ 임대 획득 → 브라우저 종료 후 지속 → 재시작 복구 → 두 Worker 동시 기동 →
주문 중복 0건). 그것을 확인하기 전에 주문 경로를 붙이면, 무엇이 깨졌는지 모르는
채로 실주문이 나간다.

`더보기 → 테스트넷 준비`가 이 순서를 관문으로 들고 있다.
