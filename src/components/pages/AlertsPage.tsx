'use client';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { T } from '@/lib/constants';
import { ASSETS } from '@/data/assets';
import type { Asset } from '@/types';
import { Card } from './SharedUI';
import { safeNumber, formatKRW, safePercent } from '@/lib/format';

type AlertCond  = 'above' | 'below' | 'pct_up' | 'pct_down';
type AlertType  = 'price' | 'pump' | 'dump' | 'news' | 'econ';

interface AlertRule {
  id:        string;
  type:      AlertType;
  assetId:   string;
  assetName: string;
  condition: AlertCond;
  value:     number;     // price target OR percent threshold
  active:    boolean;
  createdAt: number;
  triggered?: boolean;
  triggeredAt?: number;
  triggerPrice?: number;
}

const STORE_KEY    = 'tg_alerts_v1';
const FIRED_KEY    = 'tg_alerts_fired_v1';
const CHECK_MS     = 15000; // poll every 15s

const COND_LABEL: Record<AlertCond, string> = {
  above:    '≥ 도달',
  below:    '≤ 도달',
  pct_up:   '% 급등',
  pct_down: '% 급락',
};

const TYPE_LABEL: Record<AlertType, string> = {
  price: '가격', pump: '급등', dump: '급락', news: '뉴스', econ: '경제지표',
};

export default function AlertsPage({
  prices,
  onNav,
  onOpenAsset,
}: {
  prices?: Asset[];
  onNav?: (t: string) => void;
  onOpenAsset?: (a: any, dest?: string) => void;
}) {
  const [alerts, setAlerts]   = useState<AlertRule[]>([]);
  const [mounted, setMounted] = useState(false);
  const [permStatus, setPermStatus] = useState<NotificationPermission | 'unsupported'>('default');
  const [toast, setToast]     = useState('');

  // Form
  const [type,    setType]      = useState<AlertType>('price');
  const [assetId, setAssetId]   = useState('BTC');
  const [cond,    setCond]      = useState<AlertCond>('above');
  const [value,   setValue]     = useState('');

  const firedRef = useRef<Set<string>>(new Set());

  /* Load on mount */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setAlerts(Array.isArray(arr) ? arr : []);
    } catch { setAlerts([]); }

    try {
      const raw = localStorage.getItem(FIRED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) firedRef.current = new Set(arr);
    } catch {}

    if (typeof Notification === 'undefined') {
      setPermStatus('unsupported');
    } else {
      setPermStatus(Notification.permission);
    }
    setMounted(true);
  }, []);

  const showToast = useCallback((m: string) => {
    setToast(m); setTimeout(() => setToast(''), 2500);
  }, []);

  const persist = useCallback((next: AlertRule[]) => {
    setAlerts(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
  }, []);

  const persistFired = useCallback(() => {
    try { localStorage.setItem(FIRED_KEY, JSON.stringify([...firedRef.current])); } catch {}
  }, []);

  /* Source assets + price lookup */
  const sourceAssets = useMemo(() => {
    const src = Array.isArray(prices) && prices.length > 0 ? prices : ASSETS;
    return Array.isArray(src) ? src : [];
  }, [prices]);

  const priceLookup = useMemo(() => {
    const m = new Map<string, Asset>();
    sourceAssets.forEach(a => m.set(a.id, a));
    return m;
  }, [sourceAssets]);

  /* Permission request */
  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      showToast('이 브라우저는 알림 미지원');
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setPermStatus(result);
      if (result === 'granted') showToast('✅ 알림 허용됨');
      else showToast('알림 차단됨 — 브라우저 설정에서 허용해주세요');
    } catch {
      showToast('알림 권한 요청 실패');
    }
  }, [showToast]);

  /* Fire notification */
  const fireNotify = useCallback((rule: AlertRule, current: Asset) => {
    const title = `TRAIGO · ${rule.assetName}`;
    const body = (() => {
      const cur = safeNumber(current.p, 0);
      if (rule.type === 'price') {
        return `${rule.assetName} ${rule.condition === 'above' ? '≥' : '≤'} ${formatKRW(rule.value)} 도달 (현재 ${formatKRW(cur)})`;
      }
      if (rule.type === 'pump') return `${rule.assetName} +${safePercent(safeNumber(current.c, 0))} 급등!`;
      if (rule.type === 'dump') return `${rule.assetName} ${safePercent(safeNumber(current.c, 0))} 급락!`;
      return `${rule.assetName} 조건 충족`;
    })();
    // Browser notification
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, icon: '/icon-192.png', tag: rule.id });
      } catch {}
    }
    // In-app toast
    showToast('' + body.slice(0, 60));
  }, [showToast]);

  /* Polling check */
  useEffect(() => {
    if (!mounted || alerts.length === 0) return;

    const check = () => {
      let changed = false;
      const updated = alerts.map(rule => {
        if (!rule.active || rule.triggered) return rule;
        const a = priceLookup.get(rule.assetId);
        if (!a) return rule;
        const curP = safeNumber(a.p, 0);
        const curC = safeNumber(a.c, 0);
        let matched = false;
        if (rule.type === 'price') {
          if (rule.condition === 'above' && curP >= rule.value) matched = true;
          if (rule.condition === 'below' && curP <= rule.value) matched = true;
        } else if (rule.type === 'pump') {
          if (curC >= rule.value) matched = true;
        } else if (rule.type === 'dump') {
          if (curC <= -Math.abs(rule.value)) matched = true;
        }
        if (matched && !firedRef.current.has(rule.id)) {
          firedRef.current.add(rule.id);
          persistFired();
          fireNotify(rule, a);
          changed = true;
          return { ...rule, triggered: true, triggeredAt: Date.now(), triggerPrice: curP };
        }
        return rule;
      });
      if (changed) persist(updated);
    };

    check();
    const id = setInterval(check, CHECK_MS);
    return () => clearInterval(id);
  }, [alerts, mounted, priceLookup, fireNotify, persist, persistFired]);

  /* Form actions */
  const addAlert = useCallback(() => {
    const v = safeNumber(value, 0);
    if (v <= 0) { showToast('값을 입력하세요'); return; }
    const a = sourceAssets.find(x => x.id === assetId);
    if (!a) { showToast('종목을 선택하세요'); return; }

    const rule: AlertRule = {
      id:        'a-' + Date.now().toString(36),
      type,
      assetId:   a.id,
      assetName: a.nameKr || a.id,
      condition: type === 'pump' ? 'pct_up' : type === 'dump' ? 'pct_down' : cond,
      value:     v,
      active:    true,
      createdAt: Date.now(),
    };
    persist([rule, ...alerts]);
    setValue('');
    showToast('✅ 알림 추가됨');
    if (permStatus === 'default') requestPermission();
  }, [type, assetId, cond, value, sourceAssets, alerts, persist, showToast, permStatus, requestPermission]);

  const removeAlert = useCallback((id: string) => {
    persist(alerts.filter(a => a.id !== id));
    firedRef.current.delete(id);
    persistFired();
    showToast('🗑 삭제됨');
  }, [alerts, persist, persistFired, showToast]);

  const toggleAlert = useCallback((id: string) => {
    const next = alerts.map(a => a.id === id ? { ...a, active: !a.active, triggered: false } : a);
    persist(next);
    firedRef.current.delete(id);
    persistFired();
  }, [alerts, persist, persistFired]);

  const resetAlert = useCallback((id: string) => {
    const next = alerts.map(a => a.id === id ? { ...a, triggered: false, triggeredAt: undefined, triggerPrice: undefined } : a);
    persist(next);
    firedRef.current.delete(id);
    persistFired();
    showToast('알림 재활성화');
  }, [alerts, persist, persistFired, showToast]);

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', top: 16, left:'50%', transform:'translateX(-50%)',
          background: T.acl, color:'#fff', padding:'10px 18px', borderRadius: 12,
          fontSize: 13, fontWeight: 700, zIndex: 999 }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: T.txt, fontWeight: 900, fontSize: 17 }}>알림센터</div>
        <div style={{ color: T.muted, fontSize: 10 }}>
          {alerts.filter(a => a.active && !a.triggered).length}개 활성 · 15초마다 자동 체크
        </div>
      </div>

      {/* Permission banner */}
      {permStatus === 'default' && (
        <Card style={{ marginBottom: 10, background: T.acl+'10', border:`1px solid ${T.acl}40` }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap: 10 }}>
            <div>
              <div style={{ color: T.txt, fontSize: 12, fontWeight: 700, marginBottom: 2 }}>
                푸시 알림을 활성화하시겠습니까?
              </div>
              <div style={{ color: T.muted, fontSize: 10 }}>
                앱이 닫혀 있어도 가격 알림을 받을 수 있습니다
              </div>
            </div>
            <button type="button" onClick={requestPermission}
              style={{ background: T.acl, color:'#fff', border:'none',
                borderRadius: 8, padding:'8px 14px', minHeight: 36,
                fontSize: 11, fontWeight: 700, cursor:'pointer' }}>
              허용
            </button>
          </div>
        </Card>
      )}
      {permStatus === 'denied' && (
        <Card style={{ marginBottom: 10, background: T.red+'10', border:`1px solid ${T.red}30` }}>
          <div style={{ color: T.red, fontSize: 11, fontWeight: 700 }}>
            ⚠️ 알림이 차단되어 있습니다. 브라우저 설정에서 알림을 허용해주세요.
          </div>
        </Card>
      )}

      {/* Add form */}
      <Card style={{ marginBottom: 10 }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 10 }}>+ 새 알림</div>

        {/* Type */}
        <div style={{ display:'flex', gap: 4, marginBottom: 10, overflowX:'auto', paddingBottom: 4 }}>
          {(['price','pump','dump'] as AlertType[]).map(t => (
            <button key={t} type="button" onClick={() => setType(t)}
              style={{ flexShrink: 0, padding:'7px 12px', minHeight: 34,
                background: type === t ? T.acg : T.alt,
                border:`1px solid ${type === t ? T.acl : T.border}`,
                color: type === t ? T.acl : T.muted,
                borderRadius: 16, fontSize: 11, fontWeight: 700, cursor:'pointer' }}>
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        {/* Asset select */}
        <select value={assetId} onChange={e => setAssetId(e.target.value)}
          style={{ width:'100%', boxSizing:'border-box', background: T.bg,
            border:`1px solid ${T.border}`, borderRadius: 10, padding:'10px 12px',
            color: T.txt, fontSize: 12, outline:'none', marginBottom: 8 }}>
          {sourceAssets.slice(0, 30).map(a => (
            <option key={a.id} value={a.id}>{a.nameKr} ({a.sym || a.id})</option>
          ))}
        </select>

        {/* Condition + value */}
        <div style={{ display:'flex', gap: 6 }}>
          {type === 'price' && (
            <select value={cond} onChange={e => setCond(e.target.value as AlertCond)}
              style={{ width: 100, boxSizing:'border-box', background: T.bg,
                border:`1px solid ${T.border}`, borderRadius: 10, padding:'10px 8px',
                color: T.txt, fontSize: 11, outline:'none' }}>
              <option value="above">≥ 이상</option>
              <option value="below">≤ 이하</option>
            </select>
          )}
          <input type="text" inputMode="decimal"
            value={value}
            onChange={e => setValue(e.target.value.replace(/[^\d.,]/g, ''))}
            placeholder={type === 'price' ? '가격 (KRW)' : '% 임계값 (예: 5)'}
            style={{ flex: 1, boxSizing:'border-box', background: T.bg,
              border:`1px solid ${T.border}`, borderRadius: 10, padding:'10px 12px',
              color: T.txt, fontSize: 12, fontFamily:'Inter,monospace',fontVariantNumeric:'tabular-nums', outline:'none' }}/>
          <button type="button" onClick={addAlert}
            style={{ padding:'10px 16px', minHeight: 42,
              background: T.acl, color:'#fff', border:'none',
              borderRadius: 10, fontWeight: 700, fontSize: 12, cursor:'pointer' }}>
            추가
          </button>
        </div>
      </Card>

      {/* Alert list */}
      {alerts.length === 0 ? (
        <Card style={{ padding:'40px 20px', textAlign:'center' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔕</div>
          <div style={{ color: T.muted, fontSize: 13 }}>설정된 알림이 없습니다</div>
        </Card>
      ) : (
        <Card style={{ overflow:'hidden', padding: 0 }}>
          {(Array.isArray(alerts) ? alerts : []).map((a, i) => (
            <div key={a.id} style={{ padding:'12px 14px',
              borderBottom: i < alerts.length - 1 ? `1px solid ${T.border}` : 'none',
              opacity: a.active ? 1 : 0.5,
              background: a.triggered ? T.grn + '08' : 'transparent' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap: 5, marginBottom: 3 }}>
                    <span style={{ background: T.alt, color: T.muted,
                      fontSize: 9, fontWeight: 700, padding:'2px 6px', borderRadius: 4 }}>
                      {TYPE_LABEL[a.type]}
                    </span>
                    {a.triggered && (
                      <span style={{ background: T.grn + '20', color: T.grn,
                        fontSize: 9, fontWeight: 700, padding:'2px 6px', borderRadius: 4 }}>
                        ✓ 발동됨
                      </span>
                    )}
                  </div>
                  <div style={{ color: T.txt, fontSize: 13, fontWeight: 700 }}>
                    {a.assetName}
                  </div>
                  <div style={{ color: T.muted, fontSize: 11 }}>
                    {a.type === 'price' && `${a.condition === 'above' ? '≥' : '≤'} ${formatKRW(a.value)}`}
                    {a.type === 'pump' && `▲ +${a.value}% 이상 상승`}
                    {a.type === 'dump' && `▼ ${a.value}% 이상 하락`}
                  </div>
                  {a.triggered && a.triggeredAt && (
                    <div style={{ color: T.grn, fontSize: 9, marginTop: 2 }}>
                      {new Date(a.triggeredAt).toLocaleString('ko-KR')}
                      {a.triggerPrice && ` · ${formatKRW(a.triggerPrice)}`}
                    </div>
                  )}
                </div>
                <div style={{ display:'flex', gap: 4, flexShrink: 0 }}>
                  {a.triggered && (
                    <button type="button" onClick={() => resetAlert(a.id)}
                      style={{ padding:'6px 10px', minHeight: 32, background: T.acg,
                        border:`1px solid ${T.acl}40`, borderRadius: 6, color: T.acl,
                        fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
                      재활성
                    </button>
                  )}
                  <button type="button" onClick={() => toggleAlert(a.id)}
                    style={{ padding:'6px 10px', minHeight: 32,
                      background: a.active ? T.acg : T.alt,
                      border:`1px solid ${a.active ? T.acl : T.border}`,
                      borderRadius: 6, color: a.active ? T.acl : T.muted,
                      fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
                    {a.active ? 'ON' : 'OFF'}
                  </button>
                  <button type="button" onClick={() => removeAlert(a.id)}
                    style={{ padding:'6px 8px', minHeight: 32, background:'transparent',
                      border:`1px solid ${T.red}30`, borderRadius: 6, color: T.red,
                      fontSize: 10, fontWeight: 700, cursor:'pointer' }}>
                    🗑
                  </button>
                </div>
              </div>
              {onOpenAsset && (
                <button type="button" onClick={() => {
                  const asset = sourceAssets.find(x => x.id === a.assetId);
                  if (asset) onOpenAsset(asset, 'trading');
                }}
                  style={{ width:'100%', padding:'6px', marginTop: 4,
                    background: T.alt, border:`1px solid ${T.border}`,
                    borderRadius: 6, color: T.muted, fontSize: 10, fontWeight: 700,
                    cursor:'pointer', minHeight: 30 }}>
                  종목 상세
                </button>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* Help */}
      <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.6,
        padding:'10px 12px', background: T.alt, borderRadius: 10, marginTop: 10 }}>
        알림은 앱이 열려 있을 때 15초마다 자동 체크됩니다.
        브라우저 알림 권한을 허용하면 백그라운드 상태에서도 푸시 알림을 받을 수 있습니다.
      </div>
    </div>
  );
}
