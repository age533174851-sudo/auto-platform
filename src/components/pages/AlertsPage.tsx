'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, CURRENCIES, LANGS, I18N, WORLD_MARKETS, MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';
import { cvt, fmt, fmtPct, clamp, tr, gS, sS, uid } from '@/lib/utils';
import { ASSETS, TYPE_LABEL, TYPE_COLOR } from '@/data/assets';
import type { Asset } from '@/types';
import { Card, Dot, Spark, Pill, Bdg, Logo, getBgColor } from './SharedUI';

function AlertsPage({ prices }: { prices: Asset[] }) {
  const [alerts, setAlerts] = React.useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem('tg_alerts_v1') || '[]'); } catch { return []; }
  });
  const [form, setForm] = React.useState({ assetId: 'BTC', condition: 'above', value: '' });

  const save = () => {
    if (!form.value) return;
    const a = { id: Date.now().toString(), assetId: form.assetId,
                condition: form.condition, value: parseFloat(form.value), active: true };
    const next = [a, ...alerts];
    setAlerts(next);
    try { localStorage.setItem('tg_alerts_v1', JSON.stringify(next)); } catch {}
    setForm(f => ({ ...f, value: '' }));
  };

  const remove = (id: string) => {
    const next = alerts.filter(a => a.id !== id);
    setAlerts(next);
    try { localStorage.setItem('tg_alerts_v1', JSON.stringify(next)); } catch {}
  };

  const toggle = (id: string) => {
    const next = alerts.map(a => a.id === id ? { ...a, active: !a.active } : a);
    setAlerts(next);
    try { localStorage.setItem('tg_alerts_v1', JSON.stringify(next)); } catch {}
  };

  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 15, color: T.txt, marginBottom: 12 }}>🔔 가격 알림</div>
      <Card style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>새 알림 설정</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select value={form.assetId} onChange={e => setForm(f => ({ ...f, assetId: e.target.value }))}
            style={{ flex: 1, minWidth: 80, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8, color: T.txt, padding: '6px 8px', fontSize: 11 }}>
            {prices.slice(0, 20).map(p => <option key={p.id} value={p.id}>{p.nameKr}</option>)}
          </select>
          <select value={form.condition} onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}
            style={{ width: 80, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8, color: T.txt, padding: '6px 8px', fontSize: 11 }}>
            <option value="above">이상</option>
            <option value="below">이하</option>
          </select>
          <input type="number" placeholder="가격" value={form.value}
            onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
            style={{ width: 100, background: T.alt, border: `1px solid ${T.border}`, borderRadius: 8, color: T.txt, padding: '6px 8px', fontSize: 11 }} />
          <button onClick={save}
            style={{ background: T.acg, border: `1px solid ${T.acl}`, borderRadius: 8, color: T.acl, padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            추가
          </button>
        </div>
      </Card>
      {alerts.length === 0 && (
        <div style={{ textAlign: 'center', color: T.muted, fontSize: 12, padding: '32px 0' }}>설정된 알림이 없습니다</div>
      )}
      {alerts.map(a => (
        <Card key={a.id} style={{ padding: '10px 14px', marginBottom: 6, opacity: a.active ? 1 : 0.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ color: T.txt, fontSize: 12, fontWeight: 700 }}>{a.assetId}</span>
              <span style={{ color: T.muted, fontSize: 11, marginLeft: 6 }}>{a.condition === 'above' ? '≥' : '≤'} ₩{Number(a.value).toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => toggle(a.id)}
                style={{ background: a.active ? T.acg : T.alt, border: `1px solid ${T.border}`, borderRadius: 6, color: a.active ? T.acl : T.muted, padding: '3px 10px', fontSize: 10, cursor: 'pointer' }}>
                {a.active ? 'ON' : 'OFF'}
              </button>
              <button onClick={() => remove(a.id)}
                style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6, color: T.muted, padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>
                삭제
              </button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

export default AlertsPage;
