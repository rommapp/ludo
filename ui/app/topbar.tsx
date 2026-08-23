import { useEffect, useRef, useState } from "react";
import { Focusable, GamepadButton, ModalRoot, host, showModal, toaster } from "@ludo/host";
import { V2 } from "./theme";
import { FaBookmark, FaChartBar, FaCheck, FaChevronDown, FaCog, FaDownload, FaExternalLinkAlt, FaGamepad, FaHome, FaMicrochip, FaPlay, FaPowerOff, FaPuzzlePiece, FaRegClock, FaSearch, FaSync, FaTrash } from "react-icons/fa";
import { getAccountUsername, getAvatar, getImage, getRetrodeckButtonEnabled, getRetrodeckLogo, refreshFromRomm } from "./rpc";
import { MODAL_SCRIM_INSET, _clearStale } from "./index";
import { NavId, libNavigate } from "./nav";
import { Bumper, ProgressRing, UserMenuRow } from "./kit";
import { useDownloadGlimpse } from "./status";
import { _forceGamepadFocus } from "./shell";
import { _broadcastLibRefresh } from "./events";
import { V2_FOCUS_STYLE } from "./focus";
import { BiosDetailModal } from "./pages/bios";
import { _lsAvail } from "./storage";
// The bar across the top of the library, and the menus it opens.
//
// It is one component rather than per-page chrome because it has to stay put
// while the page under it changes — the tab pill keeps gamepad focus across a
// tab switch, and the download chip keeps counting while you browse.
//
// useWideTopBar is the concession to two very different screens: a Deck at
// 1280x800 and a desktop window that can be much wider, where the same layout
// would leave the pill stranded in the middle of nowhere.

// Everything the top-bar chrome needs (brand marks, account identity, RetroDECK
// launch button state). Lifted into a hook so the owning page (LibraryGroupsPage)
// can drive both the V2NavBar rendering AND the controller shortcuts / footer
// hints from one fetch, instead of the nav bar owning state the page can't reach.
// Remembered account identity (username / role / avatar data URI), mirrored to
// localStorage the same way the browse caches are. The identity is the same on
// every launch, so serving last session's copy paints the real pill on the first
// frame instead of a placeholder; the fetch below still runs and overwrites it, so
// a renamed account or a new avatar corrects itself as soon as the answer lands.
// No TTL — a revalidation happens every launch by construction. Cleared on logout
// (see handleLogout) so the next user never sees the previous one's pill.
type NavIdentity = { username: string; role: string; avatar: string | null };

function readIdentity(): NavIdentity | null {
  if (!_lsAvail) return null;
  try {
    const o = JSON.parse(localStorage.getItem(_LS_IDENTITY) || 'null');
    if (o && typeof o.username === 'string' && o.username)
      return { username: o.username, role: typeof o.role === 'string' ? o.role : '', avatar: o.avatar || null };
  } catch { }
  return null;
}

function writeIdentity(id: NavIdentity) {
  if (!_lsAvail) return;
  // An avatar is a data URI; a huge one would blow the quota and take the browse
  // caches down with it, so skip persisting anything oversized (the pill just
  // falls back to the initial for one frame, then the fetched image lands).
  const avatar = id.avatar && id.avatar.length < 512 * 1024 ? id.avatar : null;
  try { localStorage.setItem(_LS_IDENTITY, JSON.stringify({ ...id, avatar })); } catch { }
}

const _LS_IDENTITY = 'romm:identity:v1';

// Not exported: this is the plugin's rollup ENTRY, and decky's config declares
// output.exports "default". A second named export off the entry fails the whole
// bundle ("default" was specified … has the following exports: clearIdentityCache
// and default), which is why the Decky zip stopped building. Both callers are in
// this file, so the keyword bought nothing.
export function clearIdentityCache() {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_IDENTITY); } catch { }
}

// What a refresh actually did, for the completion toast. The backend already
// phrases the counts ("12 added, 1 removed"); this only supplies the wording for
// the quiet case, which is by far the common one.
//
// "Up to date." used to be shown unconditionally, which is the message that
// makes a refresh that silently found nothing indistinguishable from one that
// worked — the same reason argosy-launcher reports added/updated/removed rather
// than a bare success.
function _refreshSummary(res: any): string {
  const r = res?.reconciled;
  if (r && (r.added || r.removed || r.updated)) return res.message || 'Library updated.';
  return 'No changes — your library matches RomM.';
}

export type NavChrome = {
  iso: string | null; word: string | null;
  username: string; role: string; avatar: string | null;
  rdEnabled: boolean; rdIcon: string | null;
};

// RomM AppNav — fixed glass top bar: logo (left) · centered tab pill
// (Home/Platforms/Collections/Search) · right cluster. Geometry is grid
// 1fr/auto/1fr so the pill stays viewport-centered (AppNav.vue). The tab
// pill is RSliderBtnGroup's "tab" variant: surface bg + strong border, pill
// radius, and the ACTIVE tab is a solid white (--r-color-fg) pill with dark
// (--r-color-bg) text.
// Compact labeled pill for the top bar's optional "Launch RetroDECK" action.
// Sits beside the 32px brand mark: app icon + short label so the action reads
// clearly (vs. a bare glyph). Fully controller-focusable.
export function NavLaunchButton({ iconSrc, label, onActivate }:
  { iconSrc: string | null; label?: string; onActivate: () => void }) {
  const [active, setActive] = useState(false);
  return (
    <Focusable noFocusRing
      onActivate={onActivate} onClick={onActivate}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        height: '34px', padding: iconSrc ? '0 7px 0 5px' : '0 10px',
        borderRadius: V2.radiusPill, cursor: 'pointer',
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        color: active ? V2.fg : V2.fg2,
        fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        transition: 'background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {iconSrc
        ? <img src={iconSrc} style={{ width: '26px', height: '26px', display: 'block', flexShrink: 0, borderRadius: '50%' }} />
        : <FaExternalLinkAlt size={13} style={{ marginLeft: '3px' }} />}
      <FaPlay size={11} style={{ flexShrink: 0 }} />
      {label && <span>{label}</span>}
    </Focusable>
  );
}

export function useNavChrome(): NavChrome {
  const [iso, setIso] = useState<string | null>(null);
  const [word, setWord] = useState<string | null>(null);
  // Last session's identity if we have one, else empty — NOT 'Guest': the fetch
  // answers a beat after first paint, and seeding the real default made every
  // cold launch flash "Guest" + a "G" avatar before snapping to the actual
  // account. While empty the pill renders a neutral placeholder, and 'Guest' is
  // only set once we know there's no account to show.
  const cached = useRef(readIdentity()).current;
  const [username, setUsername] = useState<string>(cached?.username || '');
  const [role, setRole] = useState<string>(cached?.role || '');
  const [avatar, setAvatar] = useState<string | null>(cached?.avatar || null);
  const [rdEnabled, setRdEnabled] = useState<boolean>(false);
  const [rdIcon, setRdIcon] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // The fetched values are authoritative over the cached seed above, and
    // whatever they resolve to becomes next launch's seed. `fresh` starts from
    // the cache so a failed leg keeps the remembered value rather than
    // persisting a blank over a good one.
    const fresh: NavIdentity = {
      username: cached?.username || '', role: cached?.role || '', avatar: cached?.avatar || null,
    };
    // Identity runs as its own chain, started in the same tick as the brand /
    // RetroDECK art rather than after it. These were one serial await chain, so
    // the account pill sat on its placeholder for five round-trips (two SVGs +
    // the RetroDECK flag + its logo) before the username fetch even began.
    const identity = (async () => {
      // `connected` distinguishes "signed out" from "the backend hasn't
      // finished connecting yet" — see get_account_username. Only the former
      // may paint 'Guest' or invalidate the cache.
      // Retried because "not connected yet" is transient: auto-connect's login
      // round-trip routinely finishes after first paint, and without this the
      // pill would hold the cached seed (or the placeholder) until something
      // remounted it. ~30s of patience, then we stop asking.
      let known = false;
      for (let attempt = 0; alive && !known && attempt < 20; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1500));
        try {
          const acc = await getAccountUsername();
          if (!acc?.connected) continue;
          known = true;
          fresh.username = acc?.username || 'Guest';
          fresh.role = acc?.role || '';
          if (alive) { setUsername(fresh.username); setRole(fresh.role); }
        } catch { if (alive && !fresh.username) setUsername('Guest'); }
      }
      if (!alive) return;
      // Avatar fetched raw by the backend (get_avatar) — keeps transparency and
      // logs a wrong path/404 instead of silently showing the initial fallback.
      // Skipped when we never reached the account: a null here would blank a
      // perfectly good cached avatar on a slow connect.
      if (known) {
        try {
          const av = await getAvatar();
          fresh.avatar = av?.data_uri || null;
          if (alive) setAvatar(fresh.avatar);
        } catch { }
      }
      // Only remember a real identity: 'Guest' means signed out, and caching it
      // would paint "Guest" on the next launch before the fetch corrects it —
      // exactly the flash this cache exists to remove.
      if (known && fresh.username && fresh.username !== 'Guest') writeIdentity(fresh);
      else if (known) clearIdentityCache();
    })();
    const chrome = (async () => {
      try { const a = await getImage('/assets/isotipo.svg'); if (alive) setIso(a?.data_uri || null); } catch { }
      try { const b = await getImage('/assets/logotipo.svg'); if (alive) setWord(b?.data_uri || null); } catch { }
      await readRd();
    })();
    void Promise.all([identity, chrome]);
    // Settings can flip the toggle while this page is still mounted, and the
    // fetch above only runs once — without this the button (or its removal)
    // waited for the next launch. Same window-event pattern as 'romm:toastpos'.
    const onRdChange = () => { void readRd(); };
    try { window.addEventListener('romm:rdbutton', onRdChange); } catch { /* ignore */ }
    return () => {
      alive = false;
      try { window.removeEventListener('romm:rdbutton', onRdChange); } catch { /* ignore */ }
    };

    // Declared last (hoisted) so the two chains above read top-to-bottom.
    // The logo is fetched the first time the button turns on and kept after —
    // re-enabling shouldn't cost another round-trip, and a stale icon behind a
    // hidden button is harmless.
    async function readRd() {
      try {
        const on = await getRetrodeckButtonEnabled();
        if (!alive) return;
        setRdEnabled(!!on);
        if (on) {
          const r = await getRetrodeckLogo();
          if (alive) setRdIcon(r?.data_uri || null);
        }
      } catch { /* leave whatever we last knew */ }
    }
  }, []);
  return { iso, word, username, role, avatar, rdEnabled, rdIcon };
}

export function V2NavBar({ active, onTab, activeRef, chrome, onLaunchRd }:
  { active: NavId; onTab: (id: NavId) => void; activeRef?: React.MutableRefObject<any>;
    chrome: NavChrome; onLaunchRd: () => void }) {
  const { iso, word, username, role, avatar, rdEnabled, rdIcon } = chrome;
  const wideBar = useWideTopBar();
  const tabs: { id: NavId; label: string; Icon: any }[] = [
    { id: 'home', label: 'Home', Icon: FaHome },
    { id: 'platforms', label: 'Platforms', Icon: FaGamepad },
    { id: 'collections', label: 'Collections', Icon: FaBookmark },
    { id: 'search', label: 'Search', Icon: FaSearch },
  ];

  // Sliding active indicator (RSliderBtnGroup): one white pill whose left/width
  // animates between the active tab's measured position, instead of toggling a
  // background per button.
  const btnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const [shown, setShown] = useState(false); // drives the first-load grow/fade-in
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const activeIdx = tabs.findIndex((t) => t.id === active);
  // Drop any lingering focus tint when the active tab changes: on an LB/RB
  // switch the old panel's unmount can leave focusedIdx pointing at the
  // previous tab (its blur never fires), which kept that tab looking
  // highlighted. A genuinely focused pill re-tints via its own onFocus.
  useEffect(() => { setFocusedIdx(null); }, [active]);
  useEffect(() => {
    const el = btnRefs.current[activeIdx];
    if (el) {
      setInd({ left: el.offsetLeft, width: el.offsetWidth });
      // Next frame: flip from the collapsed/transparent initial state to full so
      // the indicator animates into place on first paint.
      requestAnimationFrame(() => setShown(true));
    }
  }, [activeIdx]);

  return (
    // Horizontal-flow Focusable so the three clusters (RetroDECK launch · nav
    // tabs · user pill) navigate with LEFT/RIGHT. Without this the row is a plain
    // div inside the page's vertical-flow Focusable, so Steam stacked the three
    // as a vertical list and you had to press UP/DOWN to reach the side clusters.
    <Focusable noFocusRing flow-children="horizontal" style={{
      position: 'sticky', top: 0, zIndex: 50, height: '58px',
      display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center',
      padding: '0 20px', background: 'rgba(7,7,15,0.78)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderBottom: `1px solid ${V2.border}`,
    }}>
      {/* Left cluster: brand mark + wordmark. When the RetroDECK launch button
          is enabled, the wordmark gives way to the button so the left column
          stays compact on small (Deck) screens — mark + button, never both
          the wordmark and the button. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {iso && <img src={iso} style={{ width: '32px', height: '32px', display: 'block' }} />}
        {rdEnabled
          ? <NavLaunchButton iconSrc={rdIcon} onActivate={onLaunchRd} />
          : (word && <img src={word} style={{ height: '22px', width: 'auto', display: 'block' }} />)}
      </div>
      <div style={{ justifySelf: 'center', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Bumper label="L1" />
        {/* shim-topnav marks the tabs pill so the desktop gamepad shim, when an
            Up move enters the sticky top bar, always lands INSIDE this pill (the
            column-nearest tab) rather than on the side clusters — matching the
            Deck, where Up into the nav always lands on a nav tab. Harmless on the
            Deck (just an extra class). */}
        <Focusable noFocusRing className="shim-topnav" flow-children="horizontal" style={{
          position: 'relative', display: 'flex', gap: '2px', padding: '4px',
          background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
        }}>
          {/* Sliding indicator */}
          {ind && (
            <div style={{
              position: 'absolute', top: '4px', bottom: '4px',
              left: `${ind.left}px`, width: `${ind.width}px`,
              background: V2.fg, borderRadius: V2.radiusPill, zIndex: 0,
              opacity: shown ? 1 : 0,
              transform: shown ? 'scaleX(1)' : 'scaleX(0.6)', transformOrigin: 'center',
              transition: 'left 0.28s cubic-bezier(0.22,1,0.36,1), width 0.28s cubic-bezier(0.22,1,0.36,1), opacity 0.28s ease, transform 0.28s cubic-bezier(0.22,1,0.36,1)',
            }} />
          )}
          {tabs.map(({ id, label, Icon }, i) => {
            const on = active === id;
            return (
              <Focusable noFocusRing key={id} ref={on && activeRef ? activeRef : undefined}
                className={on ? 'shim-navtab-active' : undefined}
                onActivate={() => onTab(id)} onClick={() => onTab(id)}
                onFocus={() => setFocusedIdx(i)} onBlur={() => setFocusedIdx(null)}
                onMouseEnter={() => setFocusedIdx(i)} onMouseLeave={() => setFocusedIdx(null)}>
                <div ref={(el) => { btnRefs.current[i] = el; }}
                  style={{
                    position: 'relative', zIndex: 1,
                    display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 18px',
                    borderRadius: V2.radiusPill, fontSize: '13.5px', cursor: 'pointer',
                    fontWeight: on ? 600 : 500, color: on ? V2.bg : V2.fg2,
                    // Focus affordance is the brand ring, shown whenever a pill is
                    // focused — including the ALREADY-ACTIVE one, so the controller
                    // highlight is visible on the selected tab (it rides on top of
                    // the white sliding indicator). Inactive pills also get a tint;
                    // the active pill's white indicator is tint enough on its own.
                    background: (!on && focusedIdx === i) ? 'rgba(255,255,255,0.10)' : 'transparent',
                    boxShadow: (focusedIdx === i) ? `inset 0 0 0 1.5px ${V2.brand}` : 'none',
                    transition: 'color 0.2s ease, background 0.15s ease, box-shadow 0.15s ease',
                  }}>
                  <Icon size={12} /><span>{label}</span>
                </div>
              </Focusable>
            );
          })}
        </Focusable>
        <Bumper label="R1" />
      </div>
      {/* User pill — RomM AppShell/UserMenu.vue's .r-v2-user, copied 1:1:
          avatar(30) + username + chevron, pill radius, surface bg + strong
          border, tight 3px padding on the avatar side. Opens the account menu
          (Stats / Settings for now). */}
      <div style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Wide top bars get a dedicated download chip; on the Deck the same
            glimpse collapses onto the user pill's avatar (no extra width). */}
        <NavDownloadGlimpse />
        <UserPill username={username} role={role} avatar={avatar} glimpse={!wideBar} />
      </div>
    </Focusable>
  );
}

// Renders the chip only when wide AND something is downloading — kept as its
// own component so the glimpse polling doesn't re-render the whole nav bar.
export function NavDownloadGlimpse() {
  const wide = useWideTopBar();
  const dl = useDownloadGlimpse();
  if (!wide || dl.count === 0) return null;
  return <DownloadChip count={dl.count} pct={dl.pct} />;
}

// Circular avatar — real RomM avatar when uploaded, else the RAvatar fallback
// (surface circle with the user's initial). Shared by the pill and the menu.
export function UserAvatar({ username, avatar, size }: { username: string; avatar: string | null; size: number }) {
  return (
    <div style={{
      width: `${size}px`, height: `${size}px`, borderRadius: '50%', flexShrink: 0,
      background: V2.bgElevated, border: `1px solid ${V2.borderStrong}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: `${Math.round(size * 0.43)}px`, fontWeight: 700, color: V2.fg2, overflow: 'hidden',
    }}>
      {/* No initial while the username is still unknown — an empty circle reads
          as "loading", a letter reads as a real (wrong) account. */}
      {avatar
        ? <img src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : username.slice(0, 1).toUpperCase()}
    </div>
  );
}

// RomM UserMenu, rebuilt in the v2 design language (matches RestoreModal's
// chrome): a glass panel anchored top-right (RomM's location="bottom end"),
// with the identity header card over Stats / Settings / Log out.
export function UserMenuModal({ username, role, avatar, closeModal }:
  { username: string; role: string; avatar: string | null; closeModal?: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  const [refreshing, setRefreshing] = useState(false);
  // Live count badge for the Downloads row (registry + collection auto-sync).
  const dlGlimpse = useDownloadGlimpse();

  // In-library view when the library route hosts us (keeps the tabs tree
  // mounted underneath), real navigation otherwise.
  const go = (route: string) => { closeModal?.(); libNavigate(route); };
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await refreshFromRomm(false); // incremental
      if (res?.success) {
        toaster.toast({ title: 'Library refreshed', body: _refreshSummary(res) });
        // A manual refresh IS the update the stale banner was offering, so it
        // dismisses it — otherwise the banner survives the very thing that
        // resolved it and reads as a failure.
        _clearStale();
        _broadcastLibRefresh();
      } else if (res?.busy) {
        // Not a failure — a fetch is already doing exactly what was asked.
        toaster.toast({ title: 'Already refreshing', body: 'A library fetch is in progress.' });
      } else {
        toaster.toast({ title: 'Refresh failed', body: res?.message ?? 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Refresh failed', body: String(e) });
    } finally {
      setRefreshing(false);
    }
  };
  // Only a shell that owns its own process can be exited from in-app; inside a
  // plugin host, quitting would mean closing someone else's application. Logout
  // lives in Settings.
  const canExit = host.capabilities.exit;
  // Quit is one keypress away from killing a session, so it arms on the first
  // activate and only exits on the second (same arm → confirm shape as
  // CollectionActionsModal's "Remove downloaded"), disarming after 4s.
  const [quitArmed, setQuitArmed] = useState(false);
  useEffect(() => { if (!quitArmed) return; const t = setTimeout(() => setQuitArmed(false), 4000); return () => clearTimeout(t); }, [quitArmed]);
  const doQuit = () => {
    if (!quitArmed) { setQuitArmed(true); return; }
    setQuitArmed(false);
    closeModal?.();
    host.app.quit();
  };

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        {/* Click-away scrim */}
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '260px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Identity header card — RomM UserMenu __header. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px 12px', minWidth: 0 }}>
            <UserAvatar username={username} avatar={avatar} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '13px', fontWeight: 700, color: V2.fg, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{username}</div>
              {role && <div style={{
                fontSize: '10.5px', fontWeight: 600, textTransform: 'capitalize',
                color: V2.fgMuted, marginTop: '2px', whiteSpace: 'nowrap',
              }}>{role}</div>}
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow icon={<FaChartBar size={15} />} label="Stats" onSelect={() => go("/romm-sync-stats")} />
          <UserMenuRow icon={<FaPuzzlePiece size={15} />} label="Emulator Cores" onSelect={() => go("/romm-sync-cores")} />
          <UserMenuRow icon={<FaMicrochip size={15} />} label="Firmware / BIOS" onSelect={() => go("/romm-sync-bios")} />
          <UserMenuRow icon={<FaCog size={15} />} label="Settings" onSelect={() => go("/romm-sync-settings")} />
          <UserMenuRow
            icon={<FaSync size={15} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />}
            label={refreshing ? 'Refreshing…' : 'Refresh library'} disabled={refreshing} onSelect={doRefresh} />
          <UserMenuRow icon={<FaDownload size={15} />}
            label={`Downloads${dlGlimpse.count > 0 ? ` (${dlGlimpse.count})` : ''}`}
            onSelect={() => go("/romm-sync-downloads")} />
          {canExit && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow icon={quitArmed ? <FaCheck size={15} /> : <FaPowerOff size={15} />}
                label={quitArmed ? 'Confirm quit' : 'Quit'} danger armed={quitArmed} onSelect={doQuit} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Collection / platform actions menu, in the same v2 glass chrome as the
// account dropdown (UserMenuModal). Opened from the games-count rail. Holds
// "Sync/Download missing" and the destructive "Remove downloaded" (arm →
// confirm, matching the game-tile delete affordance).
export function CollectionActionsModal({ title, isCollection, isVirtual, isSynced, missing, downloaded, syncing, platformSlug, onSyncMissing, onToggleSync, onRemove, closeModal }:
  {
    title: string; isCollection: boolean; isVirtual: boolean; isSynced: boolean;
    missing: number; downloaded: number; syncing: boolean; platformSlug?: string;
    onSyncMissing: () => void; onToggleSync: () => void; onRemove: () => void; closeModal?: () => void;
  }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);

  const syncDisabled = syncing || missing === 0;
  const removeDisabled = downloaded === 0;
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '270px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Header — collection/platform name. */}
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow
            icon={syncing ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaDownload size={14} />}
            label={`Download missing${missing ? ` (${missing})` : ''}`}
            disabled={syncDisabled}
            onSelect={() => { if (syncDisabled) return; closeModal?.(); onSyncMissing(); }} />
          <UserMenuRow icon={<FaRegClock size={14} />} label="View downloads"
            onSelect={() => { closeModal?.(); libNavigate("/romm-sync-downloads"); }} />
          {/* Platforms only — BIOS is a property of the platform, and a
              collection spans several. Opens this platform's panel in place
              rather than navigating: the answer is three lines long, and the
              user is mid-browse in the grid underneath. */}
          {platformSlug && (
            <UserMenuRow icon={<FaMicrochip size={14} />} label="Firmware / BIOS"
              onSelect={() => {
                closeModal?.();
                showModal(<BiosDetailModal slug={platformSlug} platformName={title} />);
              }} />
          )}
          {/* Auto-sync toggle — collections only (platforms have no continuous
              sync). Virtual collections sync too, keyed by their base64 id. */}
          {isCollection && (
            <UserMenuRow
              icon={<FaSync size={14} />}
              label={isSynced ? 'Disable auto-sync' : 'Enable auto-sync'}
              onSelect={() => { closeModal?.(); onToggleSync(); }} />
          )}
          {!isVirtual && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow
                icon={armed ? <FaCheck size={14} /> : <FaTrash size={14} />}
                label={armed ? 'Confirm remove' : `Remove downloaded${downloaded ? ` (${downloaded})` : ''}`}
                danger disabled={removeDisabled}
                onSelect={() => {
                  if (removeDisabled) return;
                  if (!armed) { setArmed(true); return; }
                  setArmed(false); closeModal?.(); onRemove();
                }} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// True on viewports with top-bar room to spare (external monitor / desktop Big
// Picture). The Deck's 1280×800 stays false — there the download glimpse must
// not add width, so it lives on the avatar instead of a separate chip.
export function useWideTopBar(): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia('(min-width: 1440px)').matches; } catch { return false; }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia('(min-width: 1440px)');
      const l = (e: any) => setWide(e.matches);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    } catch { /* ignore */ }
    // Explicit: with no matchMedia there is nothing to tear down. React
    // treats a missing return the same way, but noImplicitReturns wants the
    // two paths to agree.
    return undefined;
  }, []);
  return wide;
}

// Wide-viewport download glimpse: a dedicated pill next to the user pill with a
// progress ring, active count and aggregate percent. Opens the Downloads page.
// Only rendered while something is downloading (and only on wide top bars).
export function DownloadChip({ count, pct }: { count: number; pct: number | null }) {
  const [active, setActive] = useState(false);
  const open = () => libNavigate("/romm-sync-downloads");
  return (
    <Focusable noFocusRing onActivate={open} onClick={open}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        borderRadius: V2.radiusPill, padding: '3px 12px 3px 5px',
        color: V2.fg, cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      }}>
      <ProgressRing pct={pct} size={26} stroke={2.5}>
        <FaDownload size={10} style={{ color: V2.fg2 }} />
      </ProgressRing>
      <span style={{ fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {count}{pct != null ? ` · ${Math.round(pct)}%` : ''}
      </span>
    </Focusable>
  );
}

// The account menu pill. Click/A opens the RomM-styled account dropdown.
// `glimpse` false suppresses the avatar download ring (a separate DownloadChip
// is showing it instead on wide top bars).
export function UserPill({ username, role, avatar, glimpse = true }:
  { username: string; role: string; avatar: string | null; glimpse?: boolean }) {
  const [active, setActive] = useState(false);
  // Download glimpse: while anything is downloading, the avatar gains an
  // aggregate progress ring + count dot — zero extra top-bar width (the Deck's
  // bar is too tight for a separate chip).
  const dlRaw = useDownloadGlimpse();
  const dl = glimpse ? dlRaw : { count: 0, pct: null };
  const openMenu = () => showModal(
    <UserMenuModal username={username} role={role} avatar={avatar} />,
  );
  return (
    <Focusable noFocusRing onActivate={openMenu} onClick={openMenu}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        // Verified on-device: the old white tint was indistinguishable from the
        // resting surface on the Deck panel, so focus landing here (UP from the
        // first grid row) read as "selection disappeared". Brand ring instead.
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        borderRadius: V2.radiusPill, padding: '3px 12px 3px 3px',
        color: V2.fg, cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {dl.count > 0 ? (
          <ProgressRing pct={dl.pct} size={30} stroke={2.5}>
            <UserAvatar username={username} avatar={avatar} size={24} />
          </ProgressRing>
        ) : (
          <UserAvatar username={username} avatar={avatar} size={30} />
        )}
        {dl.count > 0 && (
          <span style={{
            position: 'absolute', top: '-3px', right: '-3px',
            minWidth: '13px', height: '13px', padding: '0 3px', boxSizing: 'border-box',
            borderRadius: '7px', background: V2.brand, color: '#fff',
            fontSize: '8.5px', fontWeight: 700, lineHeight: '13px', textAlign: 'center',
            border: '1.5px solid rgba(10,10,18,0.9)',
          }}>{dl.count}</span>
        )}
      </div>
      {/* Placeholder bar while the account is still loading, so the pill keeps
          its shape instead of collapsing and then jumping to full width. */}
      {username
        ? <span style={{ fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap' }}>{username}</span>
        : <span style={{
            width: '58px', height: '9px', borderRadius: '5px',
            background: V2.bgElevated, opacity: 0.7,
          }} />}
      <FaChevronDown size={11} style={{ color: V2.fgMuted }} />
    </Focusable>
  );
}

export const NAV_ORDER: NavId[] = ['home', 'platforms', 'collections', 'search'];
