'use client';
import { useEffect, useState } from 'react';

export interface PWAState {
  isInstalled: boolean;
  isInstallable: boolean;
  isOffline: boolean;
  swRegistered: boolean;
  updateAvailable: boolean;
  promptInstall: () => void;
  dismissUpdate: () => void;
  applyUpdate: () => void;
}

let deferredPrompt: any = null;

export function usePWA(): PWAState {
  const [isInstalled,   setIsInstalled]   = useState(false);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isOffline,     setIsOffline]     = useState(false);
  const [swRegistered,  setSwRegistered]  = useState(false);
  const [updateAvailable,setUpdateAvailable] = useState(false);
  const [swReg, setSwReg] = useState<ServiceWorkerRegistration|null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // ── Detect installed / standalone ──
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true ||
      window.location.search.includes('source=pwa');
    setIsInstalled(isStandalone);

    // ── Online/offline ──
    setIsOffline(!navigator.onLine);
    const handleOnline  = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    // ── Install prompt ──
    const handlePrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
      setIsInstallable(true);
    };
    window.addEventListener('beforeinstallprompt', handlePrompt);

    // ── Installed ──
    window.addEventListener('appinstalled', () => {
      setIsInstalled(true);
      setIsInstallable(false);
      deferredPrompt = null;
    });

    // ── Register Service Worker ──
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => {
          setSwRegistered(true);
          setSwReg(reg);

          // Check for updates
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                setUpdateAvailable(true);
              }
            });
          });

          // Periodic update check (every 30 min)
          setInterval(() => reg.update(), 30 * 60 * 1000);
        })
        .catch(err => console.warn('[TRAIGO] SW registration failed:', err));

      // Reload on controller change (after update)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) { refreshing = true; window.location.reload(); }
      });
    }

    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handlePrompt);
    };
  }, []);

  const promptInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') { setIsInstalled(true); setIsInstallable(false); }
    deferredPrompt = null;
  };

  const applyUpdate = () => {
    if (swReg?.waiting) {
      swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  };

  const dismissUpdate = () => setUpdateAvailable(false);

  return { isInstalled, isInstallable, isOffline, swRegistered, updateAvailable,
           promptInstall, dismissUpdate, applyUpdate };
}
