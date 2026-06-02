// src/lib/auth/parseUA.ts
// User-Agent 문자열에서 device/browser/OS 추정.
// 외부 라이브러리 의존 없이 정규식만 사용. 완벽한 파싱은 아니지만 99% 케이스 커버.

export interface ParsedUA {
  deviceName: string;
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  browser:    string;
  os:         string;
}

export function parseUserAgent(ua: string): ParsedUA {
  const u = (ua || '').trim();
  if (!u) {
    return { deviceName: 'Unknown', deviceType: 'unknown', browser: 'Unknown', os: 'Unknown' };
  }

  // ── OS 판별 ───────────────────────────────────────────────
  let os = 'Unknown';
  const iosMatch     = u.match(/iPhone OS (\d+)[_\.](\d+)/);
  const ipadOsMatch  = u.match(/iPad.*OS (\d+)[_\.](\d+)/);
  const androidMatch = u.match(/Android (\d+)/);
  const macMatch     = u.match(/Mac OS X (\d+)[_\.](\d+)/);
  const winMatch     = u.match(/Windows NT (\d+\.\d+)/);

  if (iosMatch)         os = `iOS ${iosMatch[1]}.${iosMatch[2]}`;
  else if (ipadOsMatch) os = `iPadOS ${ipadOsMatch[1]}.${ipadOsMatch[2]}`;
  else if (androidMatch)os = `Android ${androidMatch[1]}`;
  else if (macMatch)    os = `macOS ${macMatch[1]}.${macMatch[2]}`;
  else if (winMatch)    {
    const winVer = winMatch[1];
    os = winVer === '10.0' ? 'Windows 10/11'
       : winVer === '6.3'  ? 'Windows 8.1'
       : winVer === '6.1'  ? 'Windows 7'
       : `Windows ${winVer}`;
  }
  else if (/Linux/i.test(u))    os = 'Linux';
  else if (/CrOS/.test(u))      os = 'ChromeOS';

  // ── Browser 판별 (순서 중요: Edge → Chrome → Safari) ────────
  let browser = 'Unknown';
  // Edge (Chromium)
  if (/Edg\//.test(u))                  browser = 'Edge';
  else if (/OPR\/|Opera/.test(u))       browser = 'Opera';
  else if (/SamsungBrowser/.test(u))    browser = 'Samsung Internet';
  else if (/FxiOS/.test(u))             browser = 'Firefox';
  else if (/Firefox/.test(u))           browser = 'Firefox';
  else if (/CriOS/.test(u))             browser = 'Chrome';   // iOS Chrome
  else if (/Chrome/.test(u))            browser = 'Chrome';
  else if (/Safari/.test(u) && /Version\//.test(u)) browser = 'Safari';

  // ── Device type ───────────────────────────────────────────
  let deviceType: ParsedUA['deviceType'] = 'desktop';
  if (/iPad/.test(u) || (/Android/.test(u) && !/Mobile/.test(u))) deviceType = 'tablet';
  else if (/Mobile|iPhone|Android.*Mobile/.test(u))                deviceType = 'mobile';
  else if (/Windows|Macintosh|Linux/.test(u))                      deviceType = 'desktop';

  // ── Device name ────────────────────────────────────────────
  let deviceName = '';
  if (/iPhone/.test(u))      deviceName = 'iPhone';
  else if (/iPad/.test(u))   deviceName = 'iPad';
  else if (/Macintosh/.test(u)) deviceName = 'Mac';
  else if (/Windows/.test(u))   deviceName = 'Windows PC';
  else if (/Android/.test(u)) {
    // Android - 모델명 추출 시도 (예: "; SM-S928N Build/...")
    const m = u.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|;|\))/);
    if (m && m[1]) {
      const name = m[1].trim()
        .replace(/^SM-/, 'Samsung ')
        .replace(/wv$/, '')
        .trim();
      deviceName = name.length > 30 ? 'Android Device' : (name || 'Android Device');
    } else {
      deviceName = 'Android Device';
    }
  }
  else if (/Linux/.test(u))     deviceName = 'Linux PC';
  else                          deviceName = 'Unknown Device';

  return { deviceName, deviceType, browser, os };
}
