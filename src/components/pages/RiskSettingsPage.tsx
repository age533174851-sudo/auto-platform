'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { confirmDialog } from '@/lib/confirm/dialog';
import { notifyError } from '@/lib/notify/center';
import {
  Shield, ShieldAlert, ShieldCheck, ShieldOff,
  Edit3, History, TriangleAlert, Lock, Unlock, RotateCcw, Save, X,
} from 'lucide-react';
import { T } from '@/lib/constants';
import { ErrorBoundary } from './ErrorBoundary';
import { IconBox, IC_SIZE, IC_STROKE } from '@/components/ui/Icon';
import { cardStyle, buttonStyle, F, SP, R, PAGE_STYLE } from '@/components/ui/tokens';
import {
  type RiskSettings, type RiskMode, type RiskHistoryEntry,
  RISK_PRESETS, MODE_LABEL, FIELD_LABEL,
  loadSettings, saveSettings, applyPreset, loadHistory, appendHistory,
  diffEntries, clampSetting,
} from '@/lib/risk/store';

const MODE_ICONS: Record<RiskMode, React.ComponentType<{ size?: number; strokeWidth?: number; color?: string }>> = {
  safe:       ShieldCheck,
  standard:   Shield,
  aggressive: ShieldAlert,
  unlimited:  ShieldOff,
};

function RiskSettingsInner() {
  const [settings, setSettings] = useState<RiskSettings>(() => loadSettings());
  const [history,  setHistory]  = useState<RiskHistoryEntry[]>(() => loadHistory());
  const [showEdit, setShowEdit] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // ── 프리셋 적용 ────────────────────────────────────────────
  const handlePreset = useCallback(async (mode: RiskMode) => {
    if (typeof window === 'undefined') return;

    // 제한 없음 모드 — 강력한 동의 요구
    if (mode === 'unlimited') {
      const confirm1 = (await confirmDialog('⚠️ 제한 없음 모드 경고\n\n' +
        '리스크 제한을 끄면 큰 손실이 발생할 수 있습니다.\n' +
        '모든 책임은 사용자에게 있습니다.\n\n' +
        '계속 진행하시겠습니까?', { danger: true }));
      if (!confirm1) return;

      const input = window.prompt(
        '확인을 위해 아래 문구를 그대로 입력해주세요:\n\n동의합니다',
        ''
      );
      if (input?.trim() !== '동의합니다') {
        notifyError('확인 문구가 일치하지 않아 모드 변경이 취소되었습니다.');
        return;
      }
    }

    const { next, entries } = applyPreset(mode, settings);
    setSettings(saveSettings(next));
    appendHistory(entries);
    setHistory(loadHistory());
  }, [settings]);

  // ── 직접 편집 저장 ────────────────────────────────────────
  const handleSaveEdit = useCallback((updated: RiskSettings) => {
    const safe = clampSetting(updated);
    const entries = diffEntries(settings, safe, settings.mode);
    setSettings(saveSettings(safe));
    if (entries.length > 0) {
      appendHistory(entries);
      setHistory(loadHistory());
    }
    setShowEdit(false);
  }, [settings]);

  // ── 기본값 복원 ────────────────────────────────────────────
  const handleResetToStandard = useCallback(async () => {
    if (!(await confirmDialog('"기본 모드" 설정으로 복원하시겠습니까?'))) return;
    handlePreset('standard');
  }, [handlePreset]);

  const currentColor = MODE_LABEL[settings.mode].color;
  const ModeIcon = MODE_ICONS[settings.mode];

  return (
    <div style={PAGE_STYLE}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.md }}>
        <IconBox tone="red" size="md"><Shield size={IC_SIZE.md} strokeWidth={IC_STROKE}/></IconBox>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={F.title}>리스크 관리</div>
          <div style={F.caption}>모드 선택 · 항목 편집 · 변경 이력</div>
        </div>
      </div>

      {/* 현재 모드 카드 */}
      <div style={cardStyle({
        marginBottom: SP.md,
        background: currentColor + '10',
        borderColor: currentColor + '40',
        borderLeft: `3px solid ${currentColor}`,
      })}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm, marginBottom: SP.sm }}>
          <ModeIcon size={22} strokeWidth={IC_STROKE} color={currentColor}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...F.section, color: currentColor, fontWeight: 800 }}>
              {MODE_LABEL[settings.mode].label}
            </div>
            <div style={F.muted}>{MODE_LABEL[settings.mode].sub}</div>
          </div>
        </div>

        {/* unlimited 경고 배너 */}
        {settings.mode === 'unlimited' && (
          <div style={{
            background: T.red + '20', border: `1px solid ${T.red}50`,
            borderRadius: R.sm, padding: '8px 10px', marginBottom: SP.sm,
            display: 'flex', alignItems: 'flex-start', gap: 6,
          }}>
            <TriangleAlert size={14} strokeWidth={IC_STROKE} color={T.red} style={{ marginTop: 1, flexShrink: 0 }}/>
            <span style={{ color: T.red, fontSize: 11, lineHeight: 1.5, fontWeight: 700 }}>
              리스크 제한 없음 — 큰 손실 가능성. 모든 책임은 사용자에게 있습니다.
            </span>
          </div>
        )}

        {/* 현재 값 요약 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {[
            { l: '일일 최대 손실', v: settings.dailyMaxLossKRW === null ? '제한 없음'
                : `₩${settings.dailyMaxLossKRW.toLocaleString('ko-KR')}` },
            { l: '최대 드로다운',  v: settings.maxDrawdownPct === null ? '제한 없음' : `${settings.maxDrawdownPct}%` },
            { l: '최대 레버리지',  v: `${settings.maxLeverage}x` },
            { l: '최대 동시 거래', v: `${settings.maxOpenPositions}개` },
            { l: '연속 손실 한도', v: `${settings.consecutiveLossLimit}회` },
            { l: '쿨다운 시간',    v: `${settings.cooldownMinutes}분` },
          ].map(({ l, v }) => (
            <div key={l} style={{
              background: T.alt, padding: '8px 10px', borderRadius: R.sm,
              border: `1px solid ${T.border}`,
            }}>
              <div style={{ ...F.muted, fontSize: 9 }}>{l}</div>
              <div style={{ color: T.txt, fontWeight: 700, fontSize: 12, marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>

        {/* 액션 버튼 */}
        <div style={{ display: 'flex', gap: 6, marginTop: SP.md, flexWrap: 'wrap' }}>
          <button onClick={() => setShowEdit(true)}
            style={{ ...buttonStyle('primary', 'md'), flex: 1, minWidth: 120,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Edit3 size={13} strokeWidth={IC_STROKE}/>
            직접 편집
          </button>
          <button onClick={() => setShowHistory(true)}
            style={{ ...buttonStyle('ghost', 'md'), minWidth: 90,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <History size={13} strokeWidth={IC_STROKE}/>
            이력 ({history.length})
          </button>
        </div>
      </div>

      {/* 모드 프리셋 4개 */}
      <div style={{ ...F.section, marginBottom: SP.sm, color: T.txt }}>모드 빠른 변경</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: SP.md }}>
        {(Object.keys(MODE_LABEL) as RiskMode[]).map(m => {
          const info = MODE_LABEL[m];
          const Ic = MODE_ICONS[m];
          const active = settings.mode === m;
          return (
            <button key={m} onClick={() => handlePreset(m)}
              style={{
                padding: '12px 10px', minHeight: 88,
                background: active ? info.color + '18' : T.card,
                color: T.txt,
                border: `1px solid ${active ? info.color : T.border}`,
                borderRadius: R.md,
                cursor: 'pointer', touchAction: 'manipulation',
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                textAlign: 'left',
                position: 'relative',
              }}>
              <Ic size={18} strokeWidth={IC_STROKE} color={info.color}/>
              <div style={{ fontWeight: 800, fontSize: 12, color: info.color }}>{info.label}</div>
              <div style={{ ...F.muted, fontSize: 10, lineHeight: 1.4 }}>{info.sub}</div>
              {active && (
                <div style={{ position: 'absolute', top: 6, right: 6,
                  background: info.color, color: '#fff',
                  fontSize: 8, fontWeight: 800, padding: '2px 6px', borderRadius: R.pill }}>
                  현재
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* 기본값 복원 */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: SP.md }}>
        <button onClick={handleResetToStandard}
          style={{
            background: 'transparent', color: T.muted,
            border: `1px solid ${T.border}`, borderRadius: R.pill,
            padding: '8px 14px', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', minHeight: 34,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
          <RotateCcw size={12} strokeWidth={IC_STROKE}/>
          기본값으로 복원
        </button>
      </div>

      {/* 편집 모달 */}
      {showEdit && (
        <EditModal
          settings={settings}
          onSave={handleSaveEdit}
          onClose={() => setShowEdit(false)}
        />
      )}

      {/* 이력 모달 */}
      {showHistory && (
        <HistoryModal
          history={history}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 편집 모달 — 직접 값 수정
// ─────────────────────────────────────────────────────────────
function EditModal({
  settings, onSave, onClose,
}: { settings: RiskSettings; onSave: (s: RiskSettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<RiskSettings>(settings);

  const update = <K extends keyof RiskSettings>(key: K, value: RiskSettings[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const fields: Array<{
    key: keyof RiskSettings;
    label: string;
    nullable?: boolean;
    suffix?: string;
    min: number; max: number; step?: number;
    quick?: Array<{ label: string; v: number | null }>;
  }> = [
    {
      key: 'dailyMaxLossKRW', label: '일일 최대 손실 (KRW)',
      nullable: true, min: 10_000, max: 100_000_000, step: 10_000,
      quick: [
        { label: '₩10만',  v: 100_000 },
        { label: '₩100만', v: 1_000_000 },
        { label: '₩1000만',v: 10_000_000 },
        { label: '제한없음', v: null },
      ],
    },
    {
      key: 'maxDrawdownPct', label: '최대 드로다운',
      nullable: true, suffix: '%', min: 1, max: 100, step: 1,
      quick: [
        { label: '5%',  v: 5 },
        { label: '15%', v: 15 },
        { label: '30%', v: 30 },
        { label: '제한없음', v: null },
      ],
    },
    {
      key: 'maxLeverage', label: '최대 레버리지',
      suffix: 'x', min: 1, max: 125, step: 1,
      quick: [
        { label: '1x',   v: 1 },
        { label: '5x',   v: 5 },
        { label: '10x',  v: 10 },
        { label: '25x',  v: 25 },
        { label: '125x', v: 125 },
      ],
    },
    {
      key: 'maxOpenPositions', label: '최대 동시 거래',
      suffix: '개', min: 1, max: 50, step: 1,
      quick: [
        { label: '1개',  v: 1 },
        { label: '3개',  v: 3 },
        { label: '5개',  v: 5 },
        { label: '10개', v: 10 },
        { label: '20개', v: 20 },
      ],
    },
    {
      key: 'consecutiveLossLimit', label: '연속 손실 한도',
      suffix: '회', min: 1, max: 20, step: 1,
      quick: [
        { label: '2회', v: 2 },
        { label: '3회', v: 3 },
        { label: '5회', v: 5 },
      ],
    },
    {
      key: 'cooldownMinutes', label: '쿨다운 시간',
      suffix: '분', min: 0, max: 1440, step: 5,
      quick: [
        { label: '5분',   v: 5 },
        { label: '30분',  v: 30 },
        { label: '60분',  v: 60 },
        { label: '4시간', v: 240 },
      ],
    },
  ];

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}
    onClick={onClose}>
      <div style={{
        background: T.card, borderRadius: '20px 20px 0 0',
        width: '100%', maxWidth: 520, maxHeight: '92vh',
        overflowY: 'auto',
        border: `1px solid ${T.border}`,
        animation: 'slideUp 250ms ease-out',
      }}
      onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 1,
          background: T.card, borderBottom: `1px solid ${T.border}`,
          padding: '14px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ ...F.section, color: T.txt }}>리스크 항목 편집</div>
          <button onClick={onClose} aria-label="닫기"
            style={{ background: T.alt, color: T.txt, border: 'none',
              borderRadius: R.sm, padding: 8, cursor: 'pointer',
              minWidth: 36, minHeight: 36,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} strokeWidth={IC_STROKE}/>
          </button>
        </div>

        {/* Form */}
        <div style={{ padding: 16 }}>
          {/* 안전장치 마스터 스위치 */}
          <div style={cardStyle({ marginBottom: SP.md, padding: SP.md })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...F.body, color: T.txt, fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 5 }}>
                  {draft.safetyEnabled
                    ? <Lock size={13} strokeWidth={IC_STROKE} color={T.grn}/>
                    : <Unlock size={13} strokeWidth={IC_STROKE} color={T.red}/>}
                  안전장치
                </div>
                <div style={{ ...F.muted, marginTop: 2 }}>
                  {draft.safetyEnabled ? '한도 도달 시 자동 정지' : '자동 정지 안함 (사용자 전담)'}
                </div>
              </div>
              <button onClick={async () => {
                  if (draft.safetyEnabled) {
                    if (!(await confirmDialog('안전장치를 끄면 한도 도달 시 자동 정지가 작동하지 않습니다.\n계속하시겠습니까?', { danger: true }))) return;
                  }
                  update('safetyEnabled', !draft.safetyEnabled);
                }}
                aria-label="안전장치 토글"
                style={{
                  width: 56, height: 32, borderRadius: 16,
                  background: draft.safetyEnabled ? T.grn : T.border,
                  border: 'none', cursor: 'pointer', position: 'relative',
                  transition: 'background 200ms', flexShrink: 0,
                }}>
                <div style={{
                  position: 'absolute', top: 3,
                  left: draft.safetyEnabled ? 27 : 3,
                  width: 26, height: 26, borderRadius: 13,
                  background: '#fff', transition: 'left 200ms',
                }}/>
              </button>
            </div>
          </div>

          {/* 항목별 편집 */}
          {fields.map(f => {
            const value = draft[f.key];
            const isNull = value === null;
            const displayValue = isNull ? '' : String(value ?? '');
            return (
              <div key={String(f.key)} style={{ marginBottom: SP.md }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ ...F.caption, color: T.sub }}>{f.label}</span>
                  <span style={{ color: isNull ? T.red : T.acl, fontWeight: 800, fontSize: 13 }}>
                    {isNull ? '제한 없음' : `${displayValue}${f.suffix || ''}`}
                  </span>
                </div>
                <input
                  type="number"
                  value={displayValue}
                  min={f.min} max={f.max} step={f.step ?? 1}
                  disabled={isNull}
                  onChange={e => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) update(f.key, n as any);
                  }}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: T.bg, color: isNull ? T.muted : T.txt,
                    border: `1px solid ${T.border}`, borderRadius: R.sm,
                    padding: '8px 12px', fontSize: 13, fontFamily: 'monospace',
                    outline: 'none', marginBottom: 6,
                  }}/>
                {f.quick && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {f.quick.map(q => (
                      <button key={q.label}
                        onClick={() => update(f.key, q.v as any)}
                        style={{
                          ...buttonStyle('ghost', 'sm'),
                          background: T.alt, color: q.v === null ? T.red : T.muted,
                          fontSize: 10, padding: '4px 9px', minHeight: 30,
                        }}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* 긴급정지 스위치 */}
          <div style={cardStyle({ marginBottom: SP.md, padding: SP.md })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP.sm }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...F.body, color: T.txt, fontWeight: 700 }}>긴급정지 (Kill Switch)</div>
                <div style={{ ...F.muted, marginTop: 2 }}>모든 자동매매를 한 번에 중단하는 비상 스위치</div>
              </div>
              <button onClick={() => update('killSwitchEnabled', !draft.killSwitchEnabled)}
                style={{
                  width: 56, height: 32, borderRadius: 16,
                  background: draft.killSwitchEnabled ? T.red : T.border,
                  border: 'none', cursor: 'pointer', position: 'relative',
                  flexShrink: 0,
                }}>
                <div style={{
                  position: 'absolute', top: 3,
                  left: draft.killSwitchEnabled ? 27 : 3,
                  width: 26, height: 26, borderRadius: 13,
                  background: '#fff',
                }}/>
              </button>
            </div>
          </div>

          {/* 저장 버튼 */}
          <button onClick={() => onSave(draft)}
            style={{
              width: '100%', padding: '14px', minHeight: 50,
              background: T.acc, color: '#fff',
              border: 'none', borderRadius: R.md,
              fontWeight: 800, fontSize: 14, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}>
            <Save size={15} strokeWidth={IC_STROKE}/>
            저장
          </button>
        </div>
      </div>

      <style jsx>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 이력 모달
// ─────────────────────────────────────────────────────────────
function HistoryModal({ history, onClose }: { history: RiskHistoryEntry[]; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}
    onClick={onClose}>
      <div style={{
        background: T.card, borderRadius: '20px 20px 0 0',
        width: '100%', maxWidth: 520, maxHeight: '80vh',
        overflowY: 'auto',
        border: `1px solid ${T.border}`,
      }}
      onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 1,
          background: T.card, borderBottom: `1px solid ${T.border}`,
          padding: '14px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ ...F.section, color: T.txt }}>변경 이력</div>
          <button onClick={onClose} aria-label="닫기"
            style={{ background: T.alt, color: T.txt, border: 'none',
              borderRadius: R.sm, padding: 8, cursor: 'pointer',
              minWidth: 36, minHeight: 36,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={16} strokeWidth={IC_STROKE}/>
          </button>
        </div>

        <div style={{ padding: 16 }}>
          {history.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <History size={28} strokeWidth={2} color={T.muted}/>
              <div style={{ ...F.muted, marginTop: 8 }}>아직 변경 이력이 없습니다</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...history].reverse().map(h => (
                <div key={h.id} style={{
                  background: T.alt, border: `1px solid ${T.border}`,
                  borderRadius: R.sm, padding: '10px 12px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                    <span style={{ color: T.acl, fontWeight: 700, fontSize: 12 }}>
                      {FIELD_LABEL[h.field] || h.field}
                    </span>
                    <span style={{ color: T.muted, fontSize: 9 }}>
                      {new Date(h.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div style={{ color: T.txt, fontSize: 11, fontFamily: 'monospace' }}>
                    <span style={{ color: T.muted, textDecoration: 'line-through' }}>{h.fromVal}</span>
                    {' → '}
                    <span style={{ color: T.grn, fontWeight: 700 }}>{h.toVal}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RiskSettingsPage() {
  return <ErrorBoundary><RiskSettingsInner/></ErrorBoundary>;
}
