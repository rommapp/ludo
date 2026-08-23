import { useActiveDownloads, useQueuedDownloads } from "../downloads";
import { usePendingUploads, useServiceStatus } from "../status";
import { useEffect, useRef, useState } from "react";
import { getRecentActivity } from "../rpc";
import { _forceGamepadFocus } from "../shell";
import { v2Page } from "../focus";
import { Focusable } from "@ludo/host";
import { libBack } from "../nav";
import { CollectionSyncStatusRow, DownloadRowCover, DownloadStatusRow, GameActionButton, V2StatsSectionBox, _gameLabel, useRowHighlight} from "../kit";
import { FaBoxOpen, FaChevronLeft, FaCloudUploadAlt, FaDownload, FaHistory, FaRegClock, FaCheckCircle, FaChevronRight} from "react-icons/fa";
import { V2, fmtAgo} from "../theme";
import { openGameById } from "../index";
// The Downloads page: what is transferring now, what is queued behind it.
//
// It owns none of that state — downloads.ts does, because the same transfer is
// on screen in two other places. This page is a view onto the registry.
// Downloads page: every in-flight download (per-game registry + backend
// collection auto-sync passes) with live progress, plus recently completed
// downloads from the backend activity log. Opened from the account menu.
// One "Recently completed" row. Focusable and openable when the activity entry
// carries a rom_id — A jumps to that game's detail page. Entries without one
// (failures, and anything logged before rom_id was recorded) render as inert
// text rather than as a focus target that does nothing when pressed.
function CompletedDownloadRow({ event, first }: {
  event: { kind: string; title: string; detail: string; timestamp: number; rom_id?: number };
  first: boolean;
}) {
  const { active, highlightHandlers } = useRowHighlight();
  const name = _gameLabel(event.detail || event.title);
  const romId = event.rom_id;
  const open = romId != null
    ? () => openGameById(romId, name, "/romm-sync-downloads")
    : undefined;
  return (
    <Focusable noFocusRing
      // `focusable` isn't in @decky/ui's prop types but is honoured at runtime —
      // same cast the tiles use to drop out of gamepad nav.
      {...({ focusable: !!open } as any)}
      onActivate={open}
      onClick={open}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px',
        borderTop: first ? 'none' : `1px solid ${V2.border}`,
        background: active && open ? V2.surfaceHover : 'transparent',
        // Inset ring rather than a border: these rows share one card, and a
        // real border would break its outline (same reasoning as V2CardRow).
        boxShadow: active && open ? `inset 0 0 0 2px ${V2.brand}` : 'none',
        cursor: open ? 'pointer' : 'default',
        transition: 'background 0.15s, box-shadow 0.15s',
      }}>
      {romId != null
        ? <DownloadRowCover romId={romId} />
        : <div style={{ flexShrink: 0, color: V2.success, display: 'flex' }}><FaCheckCircle size={13} /></div>}
      <div style={{
        flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', fontWeight: 600, color: V2.fg,
        display: 'flex', alignItems: 'center', gap: '7px',
      }}>
        {romId != null && <FaCheckCircle size={12} style={{ flexShrink: 0, color: V2.success }} />}
        <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      </div>
      <div style={{ flexShrink: 0, fontSize: '10.5px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>
        {fmtAgo(event.timestamp)}
      </div>
      {open && (
        <div style={{
          flexShrink: 0, display: 'flex', color: active ? V2.fg2 : V2.fgMuted,
          opacity: active ? 1 : 0.5, transition: 'opacity 0.15s, color 0.15s',
        }}><FaChevronRight size={11} /></div>
      )}
    </Focusable>
  );
}


export function DownloadsPage() {
  const activeDls = useActiveDownloads();
  const queued = useQueuedDownloads();
  const status = useServiceStatus();
  const pendingCount = status?.pending_saves || 0;
  const pendingUploads = usePendingUploads(pendingCount);
  const offline = !!status?.unreachable_reason;
  const syncingCols = ((status?.collections || []) as any[]).filter((c) => c.sync_state === 'syncing');
  const activeCount = activeDls.length + syncingCols.length;

  const [recent, setRecent] = useState<Array<{ kind: string, title: string, detail: string, timestamp: number, rom_id?: number }>>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await getRecentActivity(10);
        if (alive && res?.events) setRecent(res.events.filter((e) => e.kind === 'download'));
      } catch { /* transient */ }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Same mount-focus dance as StatsPage: internally pushed views get no focus
  // pass from Steam, so drop gamepad focus on the first focusable element.
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const first = hostRef.current?.querySelector('[tabindex]') as HTMLElement | null;
        if (first) _forceGamepadFocus(first);
      } catch { /* ignore */ }
    }, 100);
    return () => clearTimeout(t);
  }, []);

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 80px' }}>
      <div ref={hostRef} style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Downloads</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <V2StatsSectionBox title={`Active${activeCount ? ` (${activeCount})` : ''}`} icon={<FaDownload size={14} />}>
          {activeCount === 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              padding: '24px', color: V2.fgMuted, fontSize: '13px',
            }}>
              <FaBoxOpen size={20} /><span>No active downloads</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {syncingCols.map((c, i) => (
                <div key={`col-${c.name}`} style={{ borderTop: i > 0 ? `1px solid ${V2.border}` : 'none' }}>
                  <CollectionSyncStatusRow col={c} />
                </div>
              ))}
              {activeDls.map((d, i) => (
                <div key={d.romId} style={{ borderTop: (i > 0 || syncingCols.length > 0) ? `1px solid ${V2.border}` : 'none' }}>
                  <DownloadStatusRow romId={d.romId} name={d.name} />
                </div>
              ))}
            </div>
          )}
        </V2StatsSectionBox>

        {queued.length > 0 && (
          <V2StatsSectionBox title={`Queued (${queued.length})`} icon={<FaRegClock size={14} />}>
            {queued.slice(0, 12).map((q, i) => (
              <div key={q.romId} style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px',
                borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
              }}>
                <DownloadRowCover romId={q.romId} />
                <div style={{
                  flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', fontWeight: 500, color: V2.fg2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{_gameLabel(q.name)}</div>
                <div style={{ flexShrink: 0, fontSize: '10.5px', color: V2.fgMuted }}>Waiting</div>
              </div>
            ))}
            {queued.length > 12 && (
              <div style={{
                padding: '9px 14px', fontSize: '11.5px', color: V2.fgMuted,
                borderTop: `1px solid ${V2.border}`,
              }}>and {queued.length - 12} more…</div>
            )}
          </V2StatsSectionBox>
        )}

        {pendingUploads.length > 0 && (
          <V2StatsSectionBox
            title={`Waiting to upload (${pendingUploads.length})`}
            icon={<FaCloudUploadAlt size={14} />}>
            <div style={{
              padding: '9px 14px', fontSize: '11.5px', color: V2.fgMuted,
              borderBottom: `1px solid ${V2.border}`,
            }}>
              {offline
                ? 'These saves will sync automatically when you’re back online.'
                : 'These local changes will sync on the next pass.'}
            </div>
            {pendingUploads.slice(0, 12).map((p, i) => {
              const slots = p.files.length;
              return (
                <div key={`${p.game}-${p.type}`} style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px',
                  borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
                }}>
                  <div style={{ flexShrink: 0, color: V2.fgMuted, display: 'flex' }}>
                    <FaCloudUploadAlt size={13} />
                  </div>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{
                      fontSize: '12.5px', fontWeight: 600, color: V2.fg,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{p.game}</div>
                    <div style={{ fontSize: '10.5px', color: V2.fgMuted, marginTop: '1px' }}>
                      {p.type === 'states' ? 'Save state' : 'Save'}
                      {slots > 1 ? ` · ${slots} files` : ''}
                      {p.emulator ? ` · ${p.emulator}` : ''}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, fontSize: '10.5px', color: V2.fgMuted }}>Waiting</div>
                </div>
              );
            })}
            {pendingUploads.length > 12 && (
              <div style={{
                padding: '9px 14px', fontSize: '11.5px', color: V2.fgMuted,
                borderTop: `1px solid ${V2.border}`,
              }}>and {pendingUploads.length - 12} more…</div>
            )}
          </V2StatsSectionBox>
        )}

        <V2StatsSectionBox title="Recently completed" icon={<FaHistory size={14} />}>
          {recent.length === 0 ? (
            <div style={{ padding: '14px 16px', fontSize: '12px', color: V2.fgMuted }}>
              Nothing yet — finished downloads will show up here.
            </div>
          ) : recent.map((e, i) => (
            <CompletedDownloadRow key={`${e.timestamp}-${i}`} event={e} first={i === 0} />
          ))}
        </V2StatsSectionBox>
      </div>
    </Focusable>,
  );
}
