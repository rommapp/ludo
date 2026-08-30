/**
 * The Quick Access Menu panel — Ludo's Deck-only surface.
 *
 * This lives in the plugin rather than in `ui/app/` because there is nothing to
 * share: the QAM is a 240px SteamOS sidebar reached through Decky Loader, drawn
 * with Steam's own `PanelSection` widgets, and the desktop app has no equivalent
 * to render it into. It used to sit in the shared UI anyway, where the PC build
 * bundled it and then threw the descriptor away.
 *
 * So the panel is deliberately thin — a status light and a few ways into the
 * full-screen app, which is where all the actual management lives. It reaches
 * the backend through `callable` like any other caller rather than importing
 * internals from the app; the one thing it does import is
 * `notifyLibraryRefreshed`, because a refresh it starts has to reach the app's
 * mounted views.
 */
import { useState, useEffect, useRef } from "react";
import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  DialogButton,
  Navigation,
  callable,
  toaster,
} from "@ludo/host";
import { FaSync, FaCog, FaGamepad } from "react-icons/fa";
import { BsGearFill } from "react-icons/bs";
import { notifyLibraryRefreshed } from "./app";

const getServiceStatus = callable<[], any>("get_service_status");
const getConfig = callable<[], any>("get_config");
const refreshFromRomm = callable<[boolean], any>("refresh_from_romm");

// Was shared with the app's own refresh button; a copy is cheaper than an
// export, and the two are free to word themselves differently.
function _refreshSummary(res: any): string {
  const r = res?.reconciled;
  if (r && (r.added || r.removed || r.updated)) return res.message || 'Library updated.';
  return 'No changes — your library matches RomM.';
}

export function QuickAccessPanel() {
  // Slim QAM launcher: connection status + entry into the full-screen app.
  // All management (collections, BIOS, settings) now lives in-app — open it
  // with the gear here, or press Select anywhere in the browser.
  const [status, setStatus] = useState<any>({ status: 'loading', message: 'Loading…' });
  const [configured, setConfigured] = useState<boolean | null>(null);
  const configuredRef = useRef<boolean | null>(null);
  const intervalRef = useRef<any>(null);

  const getStatusColor = () => {
    // Prefer the finer-grained connection state: a cached-offline session is a
    // warning (amber), but a true disconnect with nothing to show is an error
    // (red), even though both report status === 'running'.
    switch (status.connection) {
      case 'online': return '#4ade80';
      case 'offline_cached': return '#fbbf24';
      case 'connecting': return '#9ca3af';
      case 'disconnected': return '#f87171';
    }
    switch (status.status) {
      case 'connected': return '#4ade80';
      case 'running': return '#fbbf24';
      case 'stopped': return '#f87171';
      case 'error': return '#f87171';
      default: return '#9ca3af';
    }
  };


  const checkConfigured = async () => {
    try {
      const cfg = await getConfig();
      const isConfigured = cfg?.configured ?? false;
      configuredRef.current = isConfigured;
      setConfigured(isConfigured);
      return isConfigured;
    } catch {
      setConfigured(false);
      return false;
    }
  };

  const refreshStatus = async () => {
    try {
      if (configuredRef.current === false) {
        if (!(await checkConfigured())) return;
      }
      setStatus(await getServiceStatus());
    } catch {
      setStatus({ status: 'error', message: '❌ Plugin error' });
    }
  };

  useEffect(() => {
    checkConfigured().then(refreshStatus);
    intervalRef.current = setInterval(refreshStatus, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  if (configured === null) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ color: '#9ca3af', fontSize: '0.9em' }}>Loading…</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (configured === false) {
    return (
      <PanelSection title="Ludo">
        <PanelSectionRow>
          <div style={{ fontSize: '0.85em', color: '#d1d5db', lineHeight: '1.5' }}>
            Connect your SteamOS device to your RomM server to sync ROMs and saves.
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => { Navigation.Navigate("/romm-sync-setup"); Navigation.CloseSideMenus(); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FaCog size={14} />
              <span>Get Started</span>
            </div>
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <PanelSection>
      <PanelSectionRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85em', padding: '4px 0' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: getStatusColor(), flexShrink: 0 }} />
          <span>{(status.message || '').replace(', ', ' - ')}</span>
        </div>
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <FaGamepad size={14} />
            <span>Open Ludo</span>
          </div>
        </ButtonItem>
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => { Navigation.Navigate("/romm-sync-settings"); Navigation.CloseSideMenus(); }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <FaCog size={14} />
            <span>Settings</span>
          </div>
        </ButtonItem>
      </PanelSectionRow>

      <PanelSectionRow>
        <div style={{ fontSize: '11px', color: '#9ca3af', padding: '4px 2px 0', lineHeight: 1.4 }}>
          Tip: press Select in the browser to open Settings.
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

export function QuickAccessTitle() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      // Call refresh_from_romm to fetch fresh data from server
      const result = await refreshFromRomm(false); // false = incremental refresh
      if (result?.success) {
        console.log('[REFRESH] Successfully refreshed from RomM:', result.message);
        // This button had no completion feedback at all — the icon stopped
        // spinning and that was it, so a refresh that added games looked the
        // same as one that did nothing. Only speak up when something changed;
        // the quiet case is common and a toast every time is noise.
        if (result.reconciled?.added || result.reconciled?.removed) {
          toaster.toast({ title: 'Library refreshed', body: _refreshSummary(result) });
        }
        notifyLibraryRefreshed();
      } else if (result?.busy) {
        console.log('[REFRESH] Skipped — a library fetch is already running');
      } else {
        console.warn('[REFRESH] Refresh returned non-success:', result?.message);
      }
      // Keep spinning for at least 500ms for visual feedback
      setTimeout(() => setIsRefreshing(false), 500);
    } catch (error) {
      console.error('[REFRESH] Failed to refresh from RomM:', error);
      setIsRefreshing(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
      <div style={{ marginRight: 'auto', flex: 0.9 }}>Ludo</div>
      <DialogButton
        style={{ height: '28px', width: '28px', minWidth: 0, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '4px' }}
        onClick={handleRefresh}
        disabled={isRefreshing}
      >
        <FaSync style={{
          display: 'block',
          animation: isRefreshing ? 'spin 1s linear infinite' : 'none'
        }} />
      </DialogButton>
      <DialogButton
        style={{ height: '28px', width: '28px', minWidth: 0, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => {
          Navigation.Navigate("/romm-sync-settings");
          Navigation.CloseSideMenus();
        }}
      >
        <BsGearFill style={{ display: 'block' }} />
      </DialogButton>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
