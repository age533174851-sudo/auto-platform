// ─────────────────────────────────────────────────────────────
// 문의 본문에서 **비밀을 지운다.**
//
// 왜 이 파일이 고객지원의 첫 번째 파일인가
// ────────────────────────────────────────
// 사용자가 버그를 신고할 때 가장 자연스럽게 하는 행동이 **에러 메시지를
// 통째로 붙여넣는 것**이다. 그리고 이 앱의 에러 메시지에는 거래소 요청이
// 섞여 있을 수 있다.
//
//   "주문이 안 돼요. 이렇게 떠요:
//    GET /fapi/v2/account?timestamp=...&signature=9f3c...
//    X-MBX-APIKEY: vmPUZE6mv9SD5V5e14y7Ju91duEh8A..."
//
// 이 문의는 DB에 저장되고, 관리자 화면에 뜨고, 나중에 GitHub Issue로
// 옮겨질 수도 있다. 한 번 새면 되돌릴 수 없다.
//
// 코인 플랫폼에서 더 무서운 것
// ────────────────────────────
// **시드 구문**이다. 사용자는 "지갑 복구가 안 돼요"라며 12단어를 그대로
// 적을 수 있다. 그 순간 그 지갑은 끝이다. API 키는 폐기하면 되지만
// 시드는 폐기할 수 없다.
//
// 규칙 — CLAUDE.md "지문만 비교한다"
// ──────────────────────────────────
// 이 파일은 **찾은 값을 절대 돌려주지 않는다.** 종류와 개수만 돌려준다.
// 반환값에 원문 조각이 들어가면 그것을 로그에 찍는 코드가 언젠가 생긴다.
//
// 막는 쪽으로 틀린다
// ──────────────────
// 애매하면 지운다. 사용자가 "지워졌는데 이거 비밀 아니에요"라고 다시 적는
// 것은 고칠 수 있지만, 샌 비밀은 고칠 수 없다.
// ─────────────────────────────────────────────────────────────

export type SecretKind =
  /** 거래소 API 키·시크릿처럼 긴 무작위 문자열 */
  | 'API_KEY'
  /** Bearer 토큰 · JWT */
  | 'TOKEN'
  /** PEM 개인키 */
  | 'PRIVATE_KEY'
  /** 니모닉 시드 구문 — 폐기할 수 없다 */
  | 'SEED_PHRASE'
  /** 비밀번호를 적은 자리 */
  | 'PASSWORD'
  /** 이메일 주소 */
  | 'EMAIL'
  /** 전화번호 */
  | 'PHONE'
  /** 주민등록번호 */
  | 'KR_RRN';

export interface RedactionHit {
  kind: SecretKind;
  count: number;
}

export interface RedactResult {
  /** 지운 뒤의 글. 원문은 어디에도 남기지 않는다 */
  text: string;
  /** **종류와 개수만.** 값은 담지 않는다 */
  hits: RedactionHit[];
  /** 하나라도 지웠는가 */
  redacted: boolean;
}

/** 자리표시자. 사용자가 무엇이 지워졌는지 알 수 있게 종류를 적는다 */
export const MASK: Record<SecretKind, string> = {
  API_KEY: '[API 키 삭제됨]',
  TOKEN: '[토큰 삭제됨]',
  PRIVATE_KEY: '[개인키 삭제됨]',
  SEED_PHRASE: '[시드 구문 삭제됨]',
  PASSWORD: '[비밀번호 삭제됨]',
  EMAIL: '[이메일 삭제됨]',
  PHONE: '[전화번호 삭제됨]',
  KR_RRN: '[주민등록번호 삭제됨]',
};

/**
 * BIP39 단어 중 **흔한 것들**. 전체 2048개를 넣지 않는 이유는 목록이
 * 커지면 평범한 영어 문장까지 시드로 오인하기 때문이다. 여기 있는 것은
 * 시드 구문에 자주 나오면서 한국어 문의에 섞일 일이 드문 단어들이다.
 *
 * **이 목록이 판정의 전부가 아니다** — 아래 `seedLike`는 "12·15·18·21·24개의
 * 소문자 영단어가 연달아 나오고, 그 중 일부가 이 목록에 있을 것"을 본다.
 */
const BIP39_SAMPLE = new Set([
  'abandon','ability','able','about','above','absent','absorb','abstract','absurd','abuse',
  'access','accident','account','accuse','achieve','acid','acoustic','acquire','across','act',
  'addict','address','adjust','admit','adult','advance','advice','aerobic','affair','afford',
  'ahead','aim','air','airport','aisle','alarm','album','alcohol','alert','alien',
  'zebra','zero','zone','zoo','young','youth','yellow','wrong','wrist','write',
  'wolf','woman','wonder','wood','wool','word','work','world','worry','worth',
  'legal','lemon','lend','length','lens','leopard','lesson','letter','level','liar',
  'media','melody','melt','member','memory','mention','menu','mercy','merge','merit',
  'rocket','romance','roof','rookie','room','rose','rotate','rough','round','route',
  'satisfy','satoshi','sauce','sausage','save','say','scale','scan','scare','scatter',
  'tornado','tortoise','toss','total','tourist','toward','tower','town','toy','track',
  'vacant','vacuum','vague','valid','valley','valve','van','vanish','vapor','various',
]);

/** 문자열에 같은 치환을 적용하고 몇 번 바꿨는지 센다 */
function sub(text: string, re: RegExp, mask: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(re, () => { count += 1; return mask; });
  return { text: out, count };
}

/**
 * 연속된 소문자 영단어 **12개 이상**을 시드 구문 후보로 본다.
 *
 * 단어 수가 맞는 것만으로는 부족하다 — 영어 문장도 12단어가 된다. 그래서
 * **BIP39 표본에 둘 이상 걸릴 것**을 함께 본다.
 *
 * ★ 단어 수를 "정확히 12·15·18·21·24"로 보지 않는다. 예전에는 그렇게 봤고,
 *   시드 뒤에 `thanks`·`please help` 한두 단어만 붙어도 줄 전체가 13·14단어가
 *   되어 **12단어 시드가 통째로 남았다.** 줄 길이에 상한(24)을 두면 앞에
 *   영어 문장이 붙은 시드의 뒤쪽 단어가 다음 조각으로 넘어가 남는다.
 *   시드는 폐기할 수 없으므로 시드를 품을 수 있는 줄은 통째로 지운다.
 *   (입력은 `BODY_MAX` 8,000자로 잘려 들어온다 — 상한 없는 반복의 비용 한계)
 */
function maskSeedPhrases(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/\b(?:[a-z]{3,8}[ \t]+){11,}[a-z]{3,8}\b/g, (m) => {
    const words = m.trim().split(/[ \t]+/);
    if (words.length < 12) return m;
    const known = words.filter((w) => BIP39_SAMPLE.has(w)).length;
    if (known < 2) return m;
    count += 1;
    return MASK.SEED_PHRASE;
  });
  return { text: out, count };
}

/**
 * 비밀을 지운다.
 *
 * **순서가 규칙이다.** 넓은 규칙(긴 무작위 문자열)을 먼저 돌리면 JWT가
 * `API_KEY`로 잡혀 종류가 틀린다. 좁고 모양이 뚜렷한 것부터 지운다.
 */
export function redact(input: unknown): RedactResult {
  if (typeof input !== 'string' || input === '') {
    return { text: typeof input === 'string' ? input : '', hits: [], redacted: false };
  }
  let text = input;
  const hits: RedactionHit[] = [];
  const push = (kind: SecretKind, count: number) => { if (count > 0) hits.push({ kind, count }); };

  // ① PEM 개인키 — 모양이 가장 뚜렷하다
  {
    const r = sub(text, /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, MASK.PRIVATE_KEY);
    text = r.text; push('PRIVATE_KEY', r.count);
  }
  // ② 시드 구문 — 폐기할 수 없으므로 토큰·키보다 먼저 본다
  {
    const r = maskSeedPhrases(text);
    text = r.text; push('SEED_PHRASE', r.count);
  }
  // ③ JWT (eyJ…) — 거래소 토큰·Supabase 키가 이 모양이다
  {
    const r = sub(text, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MASK.TOKEN);
    text = r.text; push('TOKEN', r.count);
  }
  // ④ 이름표가 붙은 비밀 — `apiKey: xxx` · `X-MBX-APIKEY: xxx` · `signature=xxx`
  {
    const r = sub(text,
      /\b(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|x-mbx-apikey|access[_-]?key|private[_-]?key|signature|authorization|bearer)\b\s*[:=]?\s*["']?[A-Za-z0-9+/_.\-]{16,}["']?/gi,
      MASK.API_KEY);
    text = r.text; push('API_KEY', r.count);
  }
  // ⑤ 비밀번호를 적은 자리 — 짧아도 지운다.
  //
  // **영문 이름표와 한글 이름표를 나눠 쓴다.** `\b`는 `[A-Za-z0-9_]`를
  // 기준으로 하므로 `\b비밀번호`는 **영원히 맞지 않는다** — 공백과 `비`
  // 사이에는 단어 경계가 생기지 않는다. 시험이 이것을 잡았다.
  {
    const r = sub(text, /\b(?:password|passwd|pwd)\b\s*[:=]\s*["']?\S{3,}["']?/gi, MASK.PASSWORD);
    text = r.text; push('PASSWORD', r.count);
  }
  {
    const r = sub(text, /(?:비밀번호|암호|패스워드)\s*[:=]\s*["']?\S{3,}["']?/g, MASK.PASSWORD);
    text = r.text; push('PASSWORD', r.count);
  }
  // ⑥ 이름표 없는 긴 무작위 문자열 — 거래소 키는 보통 32자 이상이다.
  //    **영문자와 숫자가 섞여 있을 것**을 함께 본다. 그러지 않으면 긴 한글
  //    없는 영어 단어나 16진수 해시 설명까지 지운다.
  {
    const r = sub(text, /\b(?=[A-Za-z0-9]{32,})(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}\b/g, MASK.API_KEY);
    text = r.text; push('API_KEY', r.count);
  }
  // ⑦ 주민등록번호
  {
    const r = sub(text, /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/g, MASK.KR_RRN);
    text = r.text; push('KR_RRN', r.count);
  }
  // ⑧ 이메일 — 작성자는 user_id로 알 수 있으므로 본문에 둘 이유가 없다
  {
    const r = sub(text, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, MASK.EMAIL);
    text = r.text; push('EMAIL', r.count);
  }
  // ⑨ 전화번호 (한국 휴대폰·일반)
  {
    const r = sub(text, /\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, MASK.PHONE);
    text = r.text; push('PHONE', r.count);
  }

  // 같은 종류가 여러 규칙에서 걸렸으면 합친다
  const merged = new Map<SecretKind, number>();
  for (const h of hits) merged.set(h.kind, (merged.get(h.kind) ?? 0) + h.count);
  const final = [...merged].map(([kind, count]) => ({ kind, count }));
  return { text, hits: final, redacted: final.length > 0 };
}

/** 사용자에게 보여 줄 한 줄. **값은 적지 않는다** */
export function redactionNotice(hits: RedactionHit[]): string | null {
  if (hits.length === 0) return null;
  const names: Record<SecretKind, string> = {
    API_KEY: 'API 키', TOKEN: '인증 토큰', PRIVATE_KEY: '개인키',
    SEED_PHRASE: '시드 구문', PASSWORD: '비밀번호', EMAIL: '이메일',
    PHONE: '전화번호', KR_RRN: '주민등록번호',
  };
  const parts = hits.map((h) => `${names[h.kind]} ${h.count}건`);
  return `안전을 위해 ${parts.join(' · ')}을(를) 지우고 접수합니다 — 원문은 저장하지 않습니다.`;
}
