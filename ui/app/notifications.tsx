import { ackLibraryAnnouncement, drainNotifications, getServiceStatus, getSyncIndicator } from "./rpc";
import { Navigation, toaster } from "@ludo/host";
import { _pushSaveActivity, useSaveActivity, useServiceStatus} from "./status";
import { useRef } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";
import { PlatformIcon, ToastCover} from "./kit";
import { _emuInstall } from "./emulator";
import { _setSyncPillPref, openGameById, syncPillPref } from "./libcache";
import { invalidateStateThumbs } from "./tiles";
// Background monitoring: the toasts that appear when nothing is on screen.
//
// This runs whether or not any of Ludo's pages are mounted, because most of
// what it reports happens while the user is somewhere else entirely — a sync
// finishing during a game, a connection dropping in the background. It is
// started once at module load and stopped when the plugin unloads.

// Last connection state seen by the background poller, for edge detection. Only
// an online→offline (or offline→online) TRANSITION toasts — a cold start that's
// already offline must not fire a spurious "connection lost".
// The ack is a round trip and this poll runs every 2s, so without this the same
// announcement toasts two or three times before the backend clears it.
let _annShown = false;

/**
 * Clear the "already toasted this announcement" latch, so the next poll shows
 * it again. A function because an imported `let` is read-only at the importing
 * end, and Settings resets this when the user re-enables announcements.
 */
export function resetAnnouncementShown() { _annShown = false; }

// Body of that toast. A component rather than a string because NEITHER toaster
// can update a toast that's already on screen — Decky's returns only
// {data, dismiss}, and the shim snapshots opts at push time. But `body` is a
// ReactNode rendered inside the host's own tree, so a node that subscribes to
// the shared status poll re-renders itself in place. That's what lets the count
// move while the toast stays put.
//
// `snapshot` is the progress payload as it stood when the toast was raised, and
// it is what the toast falls back to when the live poll hasn't resolved inside
// the host's tree — without it the body reads "Fetching from RomM…" with no
// number at all, which is the one thing this notification exists to avoid. It
// is never more than TOAST_SEGMENT_MS stale, because the toast is re-raised on
// that cadence with a fresh snapshot each time.
function LibraryFetchToastBody({ snapshot }: { snapshot?: any }) {
  const st = useServiceStatus();
  const prog = st?.library_progress ?? snapshot;
  // Per-platform walk: count within the platform, named. The library-wide
  // "platform 3 of 13" position the in-app banner also carries is dropped here
  // — see the width note below; there is only ever one line to spend.
  // Steam's toast description is a single nowrap line with overflow:hidden
  // (class StandardNotificationDescription, read off the Deck's CSS), so
  // anything past the container's width is CLIPPED FROM THE RIGHT — it does not
  // wrap and it does not shrink the toast to fit. Two things follow, and both
  // were wrong before:
  //
  //   * a second row is never drawn, so the counter can't live under the name;
  //   * whatever is rightmost is what disappears, so the counter can't be last
  //     either — which is why a name-then-count row still showed only the name.
  //
  // Hence: count first, name after it. The number is the reason this
  // notification exists, so it takes the position that cannot be clipped, and
  // the name ellipsises into whatever room is left.
  const box = (rows: React.ReactNode) => (
    <span style={{
      display: 'flex', alignItems: 'baseline', gap: '6px', maxWidth: '210px',
      // Proportional digits are individually different widths, so a counter
      // rendered in them shuffles sideways as it climbs.
      fontVariantNumeric: 'tabular-nums',
    }}>{rows}</span>
  );
  const line = (content: React.ReactNode, extra?: React.CSSProperties) => (
    <span style={{
      whiteSpace: 'nowrap', overflow: 'hidden',
      textOverflow: 'ellipsis', ...extra,
    }}>{content}</span>
  );

  if (prog?.platform_name && prog?.platform_total > 0) {
    const pl = (prog.platform_loaded ?? 0).toLocaleString();
    const pt = prog.platform_total.toLocaleString();
    return box(<>
      {line(`${pl} of ${pt}`, { flex: 'none' })}
      {line(prog.platform_name, { flex: '1 1 auto', minWidth: 0, opacity: 0.75 })}
    </>);
  }
  if (prog?.total > 0) {
    return box(line(`${(prog.loaded ?? 0).toLocaleString()} of ${prog.total.toLocaleString()} games`));
  }
  // Before the first page lands there's no total to divide by, and the fetch is
  // dismissed the instant progress clears — so this covers the opening seconds
  // and the single frame between the last page and the dismiss.
  return box(line('Fetching from RomM…'));
}

// Body of that toast, live — the same self-subscribing trick as
// LibraryFetchToastBody, since neither toaster can update a toast in place. It
// matters here because the activity changes KIND partway through: a save waits
// out the settle delay before a byte moves, so the same notification has to be
// able to go from waiting to uploading without being re-raised.
function SaveSyncToastBody() {
  const a = useSaveActivity();
  const live = !a ? null
    : a.games > 1
      ? `${a.games} games`
      : a.game
        ? a.game
        : a.state === 'queued' ? 'Waiting for the save to finish writing' : 'Uploading to RomM';
  // The toast outlives the activity by up to SAVE_TOAST_MIN_MS, and its TITLE
  // is snapshotted at push time and cannot follow. So hold the last real line
  // rather than swapping in a completion message the title would contradict —
  // the notification simply finishes saying what it was saying, and the
  // separate completion toast reports the result.
  const last = useRef<string>('Uploading to RomM');
  if (live) last.current = live;
  const text = live ?? last.current;
  return (
    <span style={{
      display: 'block', maxWidth: '230px', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis',
    }}>{text}</span>
  );
}

// The save-sync toast's logo slot, live — and it has to be live for the same
// reason the body does: the rom_id is not known at push time when the upload is
// still settling, so a logo snapshotted then would be permanently blank.
//
// Same box art and same treatment the COMPLETION toast has always used, so the
// pair reads as one event reported twice rather than two unrelated messages —
// a generic cloud glyph followed by the game's cover looked like the second
// toast was about something else.
function SaveSyncToastLogo() {
  const a = useSaveActivity();
  if (a?.rom_id == null) return <FaCloudUploadAlt size={22} />;
  return <ToastCover romId={a.rom_id} hasCover />;
}

// The toast's logo slot, live. `logo` is snapshotted at push time exactly like
// every other toast option, so a static icon would freeze on whichever platform
// happened to be current when the toast was raised. It is a ReactNode rendered
// inside the host's own tree though, so the same self-subscribing trick that
// keeps the body counting keeps the icon in step with the platform.
function LibraryFetchToastLogo({ snapshot }: { snapshot?: any }) {
  const st = useServiceStatus();
  // Same fallback as the body, for the same reason: no live status must not
  // mean no artwork.
  const slug = (st?.library_progress ?? snapshot)?.platform_slug;
  if (!slug) return null;
  return (
    // Fill the host's logo slot exactly, rather than picking our own box. Both
    // toasters hand `logo` to a container that already has fixed dimensions —
    // on Decky it's Steam's StandardLogoDimensions, a 44x44 block div — so a
    // 52x32 child overflowed it horizontally and sat against its top edge,
    // which is what "not centred, wrong size" looked like on the Deck.
    // PlatformIcon renders at width/height 100% with objectFit: contain, so a
    // square slot fits a wordmark and an icon alike; the padding keeps the
    // artwork off the slot's edges.
    <div style={{
      // 7px, not the 2px this started at: the host's logo slot sits close to
      // the toast's own edge, so artwork drawn to the slot's full 44px reads as
      // touching the notification border. The padding is the gap, and shrinking
      // the art is the point rather than a side effect — a platform wordmark at
      // 30px sits better beside 13px body text than one at 44px.
      width: '100%', height: '100%', padding: '7px', boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <PlatformIcon slug={slug} size={28} />
    </div>
  );
}

export let _prevConn: string | null = null;

// Consecutive offline samples seen since the last online one. The toast needs
// two (~4s at this interval), because a SINGLE bad sample is routinely not an
// outage: the reachability probe times out under load, and every deliberate sync
// restart (a path repair, an emulator install) tears the client down and rebuilds
// it. Both produced a "Can't reach RomM server" toast on a server that was never
// down — reported from inside the setup wizard, where installing RetroArch
// saturates the connection AND restarts sync at the same moment.
export let _offSamples = 0;

export let _fetchSamples = 0;

// When the CURRENT showing of the fetch toast went up — see TOAST_SEGMENT_MS.
export let _fetchToastAt = 0;

// How long ONE showing of a sticky toast lasts, and the reason both of them are
// re-raised rather than parked.
//
// `duration` is the only thing that reliably takes a Steam toast off the
// screen. Every other route — Decky's dismiss(), our own hardDismiss() — is a
// mutation of the notification store that has to survive an intact handle, a
// living poll loop, and a frontend that was never re-evaluated underneath it.
// Any one of those failing used to strand the toast until Steam restarted,
// because the duration behind it was measured in minutes.
//
// So the duration is now the SHORT path, not the backstop: each showing expires
// on its own, and the poll re-raises it while the work is still running. The
// worst failure this design has left is a toast that outlives its work by one
// segment. Long enough not to strobe during a multi-minute library walk, short
// enough that nobody would call it stuck.
export const TOAST_SEGMENT_MS = 15 * 1000;

// A save that uploads inside a single poll would otherwise appear and vanish in
// well under a second, reading as a glitch rather than as an answer. Hold it
// this long from the moment it went up.
export const SAVE_TOAST_MIN_MS = 2600;

// Live handle on the library-fetch toast, and the count of consecutive polls
// that have seen a fetch in flight. The toast exists because OfflineBanner is
// scoped to the library root page: navigate into a game or Settings mid-fetch
// and the only sign the sync is still running disappears. A toast host is
// global, so this follows the user wherever they go.
export let _fetchToast: { dismiss: () => void } | null = null;

// Live handle on the save-sync toast, plus when it went up. Same shape as the
// library-fetch toast above, and for the same reason: a toast host is global,
// so this reaches the user wherever they are — including the case this feature
// exists for, where they have just closed a game and are not in Ludo at all.
export let _saveToast: { dismiss: () => void } | null = null;

export let _saveToastAt = 0;

/**
 * Take a toast out of Steam's notification state as thoroughly as we can.
 *
 * Measured on a Deck over the CEF debugger: Decky's `dismiss()` leaves
 * m_rgNotificationToasts untouched, and ExpireToast does empty it — but the
 * popup STAYS ON SCREEN for its full duration either way. So this is tray and
 * queue hygiene only; TOAST_SEGMENT_MS is what actually bounds what the user
 * sees, and nothing here should be relied on to take a notification down.
 *
 * dismiss() calls RemoveGroupFromTray, which splices the tray array. ExpireToast
 * pops the on-screen queue; it matches on `notificationID`, which Decky's toast
 * objects never set (they carry `nNotificationID`), so ours is stamped from
 * that first — an id of `undefined` would otherwise match every other plugin's
 * toast in the queue. All of it is private Steam API, hence the blanket catch.
 */
function hardDismiss(t: { dismiss: () => void; data?: any } | null) {
  if (!t) return;
  try { t.dismiss(); } catch { /* already out of the tray */ }
  try {
    const ns = (window as any).NotificationStore;
    const queued = ns?.m_rgNotificationToasts?.find?.((n: any) => n && n.data === t.data);
    if (queued) {
      if (queued.notificationID === undefined) queued.notificationID = queued.nNotificationID;
      ns.ExpireToast(queued);
    }
  } catch { /* private API moved; the duration cap still bounds it */ }
}

export const checkForNotifications = async () => {
  try {
    // Connection-lost / restored toast — runs here (not in a component) so it
    // fires even while the RomM app isn't open (e.g. mid-game).
    try {
      const st = await getServiceStatus();
      const conn = st?.connection ?? null;
      if (conn && conn !== 'connecting') {
        const isOff = conn === 'offline_cached' || conn === 'disconnected';
        _offSamples = isOff ? _offSamples + 1 : 0;
        // Going offline has to be CONFIRMED before it counts as the current
        // state — and while an emulator install runs it never counts, since that
        // restarts sync itself and already narrates its own progress. Leaving
        // _prevConn untouched (rather than just skipping the toast) is what stops
        // an unreported blip from being followed by a baffling "Back online".
        const confirmed = !isOff || (_offSamples >= 2 && !_emuInstall.active);
        if (confirmed) {
          if (_prevConn === 'online' && isOff) {
            const r = st?.unreachable_reason;
            const noNet = r === 'no_network' || r === 'airplane_mode';
            toaster.toast({
              title: r === 'airplane_mode' ? 'Airplane mode is on'
                : noNet ? 'No internet connection' : "Can't reach RomM server",
              body: noNet
                ? 'Showing your downloaded games — saves sync when you’re back online.'
                : 'The server isn’t responding — showing your downloaded games.',
              duration: 5000,
            });
          } else if ((_prevConn === 'offline_cached' || _prevConn === 'disconnected') && conn === 'online') {
            toaster.toast({ title: 'Back online', body: 'Reconnected to RomM — syncing.', duration: 4000 });
          }
          _prevConn = conn;
        }
      }
      // Library-fetch toast: raised while a fetch is in flight, dismissed when
      // it clears. Deliberately outside the connection block above — a fetch
      // runs during 'connecting' too, and that's exactly the first-run case
      // where the wait is longest.
      const fetching = st?.library_progress;
      if (fetching) {
        _fetchSamples++;
        // The showing that's up has expired (or is about to). Drop the stale
        // handle so the raise below puts a fresh one up — that, not dismissal,
        // is what keeps the notification on screen for a long walk.
        if (_fetchToast && Date.now() - _fetchToastAt >= TOAST_SEGMENT_MS) {
          hardDismiss(_fetchToast);
          _fetchToast = null;
        }
        // Two samples (~4s) before raising. An incremental refresh is usually
        // done inside a single tick, and a toast that appears and vanishes is
        // pure noise — only a fetch long enough to be worth narrating gets one.
        if (!_fetchToast && _fetchSamples >= 2) {
          _fetchToastAt = Date.now();
          _fetchToast = toaster.toast({
            // A scoped walk is an update, not a load — the library is already
            // on screen and only the platforms that moved are being re-read.
            // Snapshotted at push time like the rest of the toast, which is
            // fine: a walk doesn't change kind halfway through.
            title: fetching.platform_name ? 'Updating your library…' : 'Loading your library…',
            body: <LibraryFetchToastBody snapshot={fetching} />,
            logo: <LibraryFetchToastLogo snapshot={fetching} />,
            duration: TOAST_SEGMENT_MS,
            // Silent: this one announces a wait the user didn't ask about, and
            // it can fire on any cold start. The completion toast keeps its chime.
            playSound: false,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        }
      } else {
        _fetchSamples = 0;
        if (_fetchToast) {
          hardDismiss(_fetchToast);
          _fetchToast = null;
        }
      }

      // Save-sync toast — raised while a save is on its way up, dismissed when
      // it lands. No sample delay before raising, unlike the fetch toast above:
      // a save sync is over in seconds, and waiting to be sure it was worth
      // narrating would mean narrating nothing at all. SAVE_TOAST_MIN_MS does
      // that job from the other end instead.
      //
      // Feeds the module store as well, so the per-tile badges keep updating on
      // this 2s poll even on a screen with no library subscriber running.
      _pushSaveActivity(st?.save_activity);
      if (syncPillPref() === null) {
        // First read. Fired from here rather than a component so the preference
        // is known even if the user never opens a page that asks for it.
        _setSyncPillPref(true);
        getSyncIndicator()
          .then((r) => _setSyncPillPref(r?.enabled !== false))
          .catch(() => { /* stays on */ });
      }
      const saving = st?.save_activity?.active && syncPillPref() !== false;
      if (saving) {
        // Re-raised on expiry, exactly like the fetch toast above.
        if (_saveToast && Date.now() - _saveToastAt >= TOAST_SEGMENT_MS) {
          hardDismiss(_saveToast);
          _saveToast = null;
        }
        if (!_saveToast) {
          _saveToastAt = Date.now();
          _saveToast = toaster.toast({
            title: 'Uploading save',
            body: <SaveSyncToastBody />,
            logo: <SaveSyncToastLogo />,
            duration: TOAST_SEGMENT_MS,
            // Silent, like the fetch toast: this narrates work the user did not
            // ask about. The completion toast keeps its chime, which is the one
            // they actually need to hear from another room.
            playSound: false,
          });
        }
      } else if (_saveToast) {
        const held = Date.now() - _saveToastAt;
        const t = _saveToast;
        _saveToast = null;
        // Past the floor already: go now. Otherwise let it serve out the rest,
        // with the body having fallen through to "Save uploaded" the moment the
        // activity cleared — so the extra time reads as a result, not a stall.
        if (held >= SAVE_TOAST_MIN_MS) hardDismiss(t);
        else setTimeout(() => hardDismiss(t), SAVE_TOAST_MIN_MS - held);
      }

      // First-library-load toast. Fires from here rather than a component
      // because the whole point is the user who wandered off to Steam during
      // the ~12s first fetch. The backend only ever raises this once per
      // device — see _announce_library — so there's no rate limiting to do
      // here, and routine reconnects stay silent.
      const ann = st?.library_announcement;
      if (ann?.kind && !_annShown) {
        _annShown = true;   // stop the next 2s tick re-toasting before the ack lands
        if (ann.kind === 'ready') {
          toaster.toast({
            title: 'Your library is ready',
            // Report the server's own ROM count, not our grouped entry count:
            // it's the number RomM shows the user everywhere else, and the
            // grouping is an implementation detail a completion toast is the
            // wrong place to explain.
            body: `${(ann.files ?? ann.games ?? 0).toLocaleString()} games from RomM`,
            duration: 6000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        } else if (ann.kind === 'updated') {
          // A reconcile ran on connect and changed something. Names the
          // platforms, because "your library changed" while a banner counts
          // through 17,000 c64 ROMs is exactly the moment the user wants to
          // know WHICH platform is being read and why.
          const bits: string[] = [];
          if (ann.added) bits.push(`${ann.added.toLocaleString()} added`);
          if (ann.removed) bits.push(`${ann.removed.toLocaleString()} removed`);
          const where = (ann.platforms || []).length
            ? ` in ${(ann.platforms as string[]).slice(0, 3).join(', ')}`
            + ((ann.platforms.length > 3) ? ` +${ann.platforms.length - 3} more` : '')
            : '';
          toaster.toast({
            title: 'Library updated',
            body: `${bits.join(', ') || 'Synced'}${where}`,
            duration: 6000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        } else {
          toaster.toast({
            title: "Couldn't load your library",
            body: "Ludo can’t reach your RomM server. Check that it’s running, then try again from Settings.",
            duration: 8000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-settings'); } catch { /* ignore */ } },
          });
        }
        // Released after the ack, not latched for the session: 'updated' is
        // repeatable, and a permanent latch would let the first announcement
        // silence every later one. The ack has cleared the backend's copy by
        // here, so the next poll has nothing to re-toast. Released even when
        // the ack fails, or a single failed round trip would mute it for good.
        try { await ackLibraryAnnouncement(); } catch { /* retried next load */ }
        finally { _annShown = false; }
      }
    } catch { /* transient */ }

    const { events } = await drainNotifications();
    if (!events?.length) return;
    // A save/state upload replaces that game's state screenshot. The row's own
    // invalidation only arms after a launch started from Ludo, so a session
    // played elsewhere (RetroDECK, another device) would otherwise keep showing
    // box art until the next app start. The backend drops its matching caches
    // in the same call, so the refetch below sees the new picture.
    if (events.some((e: any) => e?.kind === 'save')) invalidateStateThumbs();
    for (let i = 0; i < events.length; i++) {
      // Slight stagger so the toaster doesn't dedupe a burst into one.
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
      const ev = events[i];
      // Events carrying a rom_id are about one specific game (a save/state
      // upload). Give those the download toast's treatment — that game's box
      // art as the logo, and a click that opens it — so a burst of them is
      // still readable as "these games synced" rather than N identical rows.
      const romId = typeof ev.rom_id === 'number' ? ev.rom_id : null;
      toaster.toast({
        title: ev.title,
        body: ev.body,
        duration: 5000,
        ...(romId !== null ? {
          logo: <ToastCover romId={romId} hasCover={!!ev.has_cover} />,
          // Library root as origin: the toast can outlive the page that was
          // open when the sync fired (same reasoning as the download toast).
          onClick: () => openGameById(romId, ev.body || '', "/romm-sync-library"),
        } : {}),
      });
    }
  } catch (error) {
    console.error('[BACKGROUND NOTIFICATION] Error draining notifications:', error);
  }
};

// Background notification polling — drains events the backend emits at the exact
// moment a sync/removal happens. No state diffing, no transition inference: the
// backend is the single source of truth (see CollectionSyncManager.push_notification).
export let backgroundInterval: any = null;

export const startBackgroundMonitoring = () => {
  if (backgroundInterval) {
    clearInterval(backgroundInterval);
  }
  console.log('[BACKGROUND] Starting background notification monitoring');
  backgroundInterval = setInterval(checkForNotifications, 2000);
};

export const stopBackgroundMonitoring = () => {
  if (backgroundInterval) {
    console.log('[BACKGROUND] Stopping background notification monitoring');
    clearInterval(backgroundInterval);
    backgroundInterval = null;
  }
};
