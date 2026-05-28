// src/lib/auth/useProfile.ts
// Client-side hook: 현재 로그인 사용자의 프로필을 가져오고,
// ADMIN_EMAILS 자동 승급을 트리거합니다.
//
// 사용:
//   const { profile, role, isAdmin, loading, user } = useProfile();
//   if (loading) return null;
//   if (!isAdmin) return <Redirect to="/unauthorized" />;

'use client';
import { useEffect, useState, useCallback } from 'react';

const ADMIN_ROLES = new Set(['admin', 'developer', 'super_admin']);

export interface ProfileData {
  id:           string;
  email:        string | null;
  display_name: string | null;
  avatar_url:   string | null;
  role:         string;
  plan:         string;
  status:       string;
  created_at:   string;
}

export interface UseProfileResult {
  loading:         boolean;
  user:            { id: string; email: string | null } | null;
  profile:         ProfileData | null;
  role:            string | null;
  isAdmin:         boolean;
  isAuthenticated: boolean;
  error:           string | null;
  refresh:         () => Promise<void>;
}

export function useProfile(): UseProfileResult {
  const [loading,         setLoading]         = useState(true);
  const [user,            setUser]            = useState<{ id: string; email: string | null } | null>(null);
  const [profile,         setProfile]         = useState<ProfileData | null>(null);
  const [error,           setError]           = useState<string | null>(null);

  const fetchMe = useCallback(async () => {
    setError(null);
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb) {
        setLoading(false);
        return;
      }
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) {
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const r = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        setError(`status_${r.status}`);
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }
      const d = await r.json();
      setUser(d.user ?? null);
      setProfile(d.profile ?? null);
      setLoading(false);

      // 세션 로깅 (best-effort, 실패해도 무시)
      try {
        const SESSION_KEY = 'tg_session_token_v1';
        let sessionToken = '';
        try { sessionToken = window.localStorage.getItem(SESSION_KEY) || ''; } catch {}
        if (!sessionToken) {
          // UUID v4-like
          sessionToken = 'sess-' + Date.now().toString(36) + '-' +
            Math.random().toString(36).slice(2, 10) +
            Math.random().toString(36).slice(2, 10);
          try { window.localStorage.setItem(SESSION_KEY, sessionToken); } catch {}
        }
        fetch('/api/auth/session-log', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ sessionToken }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {/* silent */});
      } catch {/* silent */}
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown';
      setError(msg);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMe();
    // 로그인/로그아웃 이벤트 감지해서 새로고침
    let unsubscribe: (() => void) | null = null;
    (async () => {
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        const sb = getSupabaseClient();
        if (!sb) return;
        const { data: sub } = sb.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
            fetchMe();
          }
        });
        unsubscribe = () => sub.subscription.unsubscribe();
      } catch { /* ignore */ }
    })();
    return () => { if (unsubscribe) unsubscribe(); };
  }, [fetchMe]);

  const role = profile?.role ?? null;
  return {
    loading,
    user,
    profile,
    role,
    isAdmin:         role ? ADMIN_ROLES.has(role) : false,
    isAuthenticated: !!user,
    error,
    refresh:         fetchMe,
  };
}
