import { useEffect, useRef, useState } from "react";
import { _forceGamepadFocus } from "../shell";
import { downloadCore, getCoreMappings, getDownloadableCores, setCoreOverride } from "../rpc";
import { GameActionButton, PlatformIcon, UserMenuRow, V2SearchField, V2SettingsRow, V2SettingsSection, MODAL_SCRIM_INSET} from "../kit";
import { FaCheck, FaChevronLeft, FaChevronRight, FaDownload, FaLayerGroup, FaPuzzlePiece, FaUndo, FaGamepad, FaInfoCircle, FaSync} from "react-icons/fa";
import { Focusable, ModalRoot, showModal } from "@ludo/host";
import { toaster } from "../toast";
import { V2_FOCUS_STYLE, v2Page } from "../focus";
import { V2 } from "../theme";
import { libBack } from "../nav";
import { EmuStatus, installSize, loadEmulatorStatus, startEmulatorInstall, useEmulatorInstall, useEmulatorStatus } from "../emulator";
// Emulator cores: which one runs a platform, and getting one installed.
//
// The picker is a modal rather than a page of its own because it is reached
// from a failed launch as often as from here — a game that will not start for a
// missing core offers it inline.

// Glassy core picker (RomM v2 chrome, like the account/collection menus).
// Lists "Auto" + every installed core, with RetroDECK's choices surfaced first
// and the current selection check-marked. closeModal is injected by showModal.
export function CorePickerModal({ row, availableCores, canDownload, noDownloadReason, noDownloadKind, onPick, onDownload, closeModal }: {
  row: any; availableCores: string[]; canDownload: boolean;
  noDownloadReason?: string; noDownloadKind?: string;
  onPick: (core: string) => void;
  onDownload: (core: string) => void; closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  // Cores the buildbot can supply for this platform that aren't installed. The
  // full buildbot catalogue (~200 cores) is only pulled in once you search, so
  // opening the picker stays a local, offline-safe operation.
  const [catalogue, setCatalogue] = useState<string[] | null>(null);
  const rdSet = new Set<string>(row?.retrodeck_choices || []);
  // Installed cores that can actually run this platform (RetroDECK's choices
  // plus our own map). Only these are offered — pinning mupen64plus to Game Boy
  // Advance just produces a launch that fails. The rest of the core folder is
  // still reachable behind "show all" for cores we don't know about.
  const relevant: string[] = (row?.platform_cores
    || (row?.retrodeck_choices || []).filter((c: string) => availableCores.includes(c)));
  const relevantSet = new Set<string>(relevant);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);

  const q = query.trim().toLowerCase();
  const match = (c: string) => !q || c.toLowerCase().includes(q);
  // RetroDECK's choices first (in its priority order), then (if expanded) the rest.
  const rdOrdered = relevant.filter((c: string) => match(c));
  // Filtering searches the whole installed set even when collapsed, so you can
  // find any core by typing without toggling "show all" first.
  const others = (showAll || q) ? availableCores.filter((c) => !relevantSet.has(c) && match(c)) : [];
  const current = row?.override || '';

  const pick = (core: string) => { closeModal?.(); onPick(core); };
  const grab = (core: string) => { closeModal?.(); onDownload(core); };

  // Suggested downloads for this platform, plus — once you type — anything else
  // in the catalogue. Both filtered against what's already installed.
  // Nothing downloadable on a RetroDECK install (it bundles its own cores in a
  // read-only tree) — the whole section, catalogue fetch included, stays off.
  const suggested: string[] = canDownload ? (row?.download_candidates || []).filter(match) : [];
  const catalogueHits = (canDownload && q && catalogue)
    ? catalogue.filter((c) => !availableCores.includes(c) && !suggested.includes(c) && match(c)).slice(0, 40)
    : [];
  useEffect(() => {
    if (!canDownload || !q || catalogue !== null) return;
    getDownloadableCores(false)
      .then((r: any) => setCatalogue(r?.success ? (r.cores || []).map((c: any) => c.name) : []))
      .catch(() => setCatalogue([]));
  }, [canDownload, q, catalogue]);

  const coreRow = (core: string) => (
    <UserMenuRow key={core}
      icon={current === core ? <FaCheck size={13} /> : <FaPuzzlePiece size={13} />}
      label={core + (row?.retrodeck_default === core ? '  · RetroDECK default' : (rdSet.has(core) ? '  · RetroDECK' : ''))}
      onSelect={() => pick(core)} />
  );

  const downloadRow = (core: string) => (
    <UserMenuRow key={`dl-${core}`}
      icon={<FaDownload size={13} />}
      label={`${core}  ·  download`}
      onSelect={() => grab(core)} />
  );

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}>
      <Focusable noFocusRing style={{
        position: 'fixed', inset: MODAL_SCRIM_INSET, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(7,7,15,0.45)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
      }}>
        <style>{`${V2_FOCUS_STYLE}
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }`}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '340px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)', maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px',
          }}>Core · {row?.platform_name || ''}</div>
          <div style={{ padding: '0 4px 8px' }}>
            <V2SearchField value={query} onChange={setQuery} />
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          {/* Auto reverts to RetroDECK's choice / our guess. */}
          {match('auto') && (
            <UserMenuRow
              icon={!current ? <FaCheck size={13} /> : <FaUndo size={13} />}
              label={`Auto${row?.retrodeck_default ? `  ·  ${row.retrodeck_default}` : (row?.resolved_core ? `  ·  ${row.resolved_core}` : '')}`}
              onSelect={() => pick('')} />
          )}
          {rdOrdered.length > 0 && <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />}
          {rdOrdered.map(coreRow)}
          {/* No installed core runs this platform — say so instead of leaving a
              bare "Auto" that resolves to nothing. */}
          {relevant.length === 0 && !q && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <div style={{ padding: '8px 10px', fontSize: '11.5px', color: V2.fgMuted, lineHeight: 1.45 }}>
                {suggested.length > 0
                  ? 'No installed core runs this platform — download one below.'
                  /* Nothing to offer: either Ludo can't install cores here at all
                     (RetroDECK, unsupported arch, read-only cores dir) or the
                     buildbot has none for this platform. Both end the same way —
                     RetroArch's own Online Updater is the way out, so say so
                     instead of leaving a dead end. */
                  /* RetroDECK's core set is fixed and read-only inside the
                     flatpak, so its Online Updater can't write there either —
                     pointing at it would just be a second dead end. */
                  : noDownloadKind === 'retrodeck'
                    ? 'No installed core runs this platform. RetroDECK ships a fixed core set that neither Ludo nor its own updater can add to, so there is nothing to install here — this platform needs a separate RetroArch to run.'
                    : !canDownload
                    ? `No installed core runs this platform, and Ludo can't install one${noDownloadReason ? ` — ${noDownloadReason}` : ''}. Add a core from RetroArch itself (Main Menu ▸ Online Updater ▸ Core Downloader), then come back and pin it here.`
                    : 'No installed core runs this platform, and the libretro buildbot has none to offer for it. Check RetroArch\'s own Core Downloader (Main Menu ▸ Online Updater) — if it isn\'t there either, this platform has no libretro core.'}
              </div>
            </>
          )}
          {/* Escape hatch to the rest of the core folder, for cores our map
              doesn't know about. Off by default so a core meant for another
              system can't be pinned here by accident. */}
          <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
          <UserMenuRow
            icon={<FaLayerGroup size={13} />}
            label={showAll ? 'Show only cores for this platform' : 'Show all installed cores'}
            onSelect={() => setShowAll((v) => !v)} />
          {others.length > 0 && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <div style={{
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: V2.fgMuted, padding: '6px 8px 4px',
              }}>Other installed cores · not for this platform</div>
            </>
          )}
          {others.map(coreRow)}
          {/* Not installed, but the libretro buildbot has it — same source
              RetroArch's own Online Updater uses. */}
          {(suggested.length > 0 || catalogueHits.length > 0) && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <div style={{
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: V2.fgMuted, padding: '6px 8px 4px',
              }}>Available to download</div>
            </>
          )}
          {suggested.map(downloadRow)}
          {catalogueHits.map(downloadRow)}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}
// Emulator Cores page: one row per library platform showing how its launch
// core resolves (user override > RetroDECK/ES-DE > built-in guess). A on a row
// opens the picker; the trailing badge shows the resolved core + its source.
// The Emulator page with nothing to configure: no RetroArch, no RetroDECK, so
// per-platform cores are meaningless until one exists. Offer the install
// instead of an empty list.
function NoEmulatorSection({ status }: { status: EmuStatus }) {
  const install = useEmulatorInstall();
  // Can't install from here — Windows, no flatpak, running as root. The row
  // becomes an explanation rather than a button that could only fail.
  const canInstall = status.install.available;
  return (
    <V2SettingsSection title="Emulator">
      <V2SettingsRow icon={<FaGamepad size={16} />}
        title={install.active ? 'Installing RetroArch…' : 'No emulator installed'}
        subtitle={install.active
          ? [install.phase || 'Installing', install.pct != null ? `${install.pct}%` : '',
             installSize(install)].filter(Boolean).join(' · ')
            || 'This takes a few minutes.'
          : install.error
            ? install.error
            : canInstall
              ? 'Ludo needs RetroArch or RetroDECK to launch games.'
              : `Ludo needs RetroArch or RetroDECK to launch games. ${status.install.reason || 'Install one, then re-check.'}`}
        onClick={install.active || !canInstall ? undefined : startEmulatorInstall}
        right={install.active
          ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite', color: V2.fgMuted }} />
          : canInstall
            ? <span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>Install</span>
            : null} />
      {/* Only worth suggesting where a flatpak install is actually possible —
          the reasons canInstall is false here are Windows, no flatpak, or root. */}
      {canInstall && <V2SettingsRow icon={<FaInfoCircle size={15} />}
        title="Prefer RetroDECK?"
        subtitle="Install net.retrodeck.retrodeck from Flathub yourself."
        right={<span style={{ fontSize: '13px', fontWeight: 600, color: V2.brandHover }}>Re-check</span>}
        onClick={() => loadEmulatorStatus(true)} />}
      {/* Without the RetroDECK row there is nothing to re-detect with, and
          installing outside Ludo is exactly what needs a re-check. */}
      {!canInstall && <V2SettingsRow icon={<FaSync size={15} />}
        title="Re-check"
        subtitle="Look for an emulator again."
        onClick={() => loadEmulatorStatus(true)} />}
    </V2SettingsSection>
  );
}


export function CoresPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [cores, setCores] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether this RetroArch can gain cores at all, and why not when it can't
  // (RetroDECK bundles them read-only; unsupported CPU; no writable dir).
  const [canDownload, setCanDownload] = useState(false);
  const [noDownloadReason, setNoDownloadReason] = useState('');
  // Which of those cases it is ('retrodeck', 'no_builds', …) — the picker words
  // its advice per case rather than pattern-matching the reason text.
  const [noDownloadKind, setNoDownloadKind] = useState('');

  const emu = useEmulatorStatus();

  const load = async () => {
    try {
      const r = await getCoreMappings();
      if (r?.success) {
        setRows(r.mappings || []);
        setCores(r.available_cores || []);
        setCanDownload(!!r.can_download_cores);
        setNoDownloadReason(r.download_unavailable_reason || '');
        setNoDownloadKind(r.download_unavailable_kind || '');
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  // An install finishing while this page is open turns every row from
  // unresolvable to resolvable — re-read instead of stranding the empty state.
  const wasInstalled = useRef<boolean | null>(null);
  useEffect(() => {
    if (emu == null) return;
    if (wasInstalled.current != null && wasInstalled.current !== emu.installed) load();
    wasInstalled.current = emu.installed;
  }, [emu?.installed]);

  const apply = async (slug: string, core: string) => {
    try {
      const r = await setCoreOverride(slug, core);
      if (r?.success && r.mapping) {
        setRows((prev) => prev.map((x) => x.slug === slug ? { ...r.mapping } : x));
      }
    } catch { toaster.toast({ title: 'Core override', body: 'Could not save change' }); }
  };

  // Fetch a core, then pin it for this platform — picking a core you just
  // downloaded and NOT using it is never what was meant.
  const [busy, setBusy] = useState<string | null>(null);
  const install = async (row: any, core: string) => {
    setBusy(row.slug);
    toaster.toast({ title: 'Emulator core', body: `Downloading ${core}…` });
    try {
      const r = await downloadCore(core);
      if (r?.success) {
        toaster.toast({ title: 'Emulator core', body: `${core} installed` });
        await apply(row.slug, core);
        await load();   // the installed-core list grew
      } else {
        toaster.toast({ title: 'Emulator core', body: r?.message || `Could not download ${core}` });
      }
    } catch {
      toaster.toast({ title: 'Emulator core', body: `Could not download ${core}` });
    } finally { setBusy(null); }
  };

  const openPicker = (row: any) =>
    showModal(<CorePickerModal row={row} availableCores={cores} canDownload={canDownload}
      noDownloadReason={noDownloadReason} noDownloadKind={noDownloadKind}
      onPick={(c) => apply(row.slug, c)}
      onDownload={(c) => install(row, c)} />);

  const badge = (row: any) => {
    const labelFor: Record<string, string> = { override: 'pinned', retrodeck: 'RetroDECK', guess: 'auto', none: '—' };
    const color = row.source === 'override' ? V2.brandHover : (row.source === 'none' ? V2.danger : V2.fgMuted);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: row.resolved_core ? V2.fg : V2.danger }}>
          {row.resolved_core || 'no core'}
        </span>
        <span style={{
          fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
          color, border: `1px solid ${color}`, borderRadius: V2.radiusChip, padding: '1px 6px',
        }}>{labelFor[row.source] || row.source}</span>
        <FaChevronRight size={12} style={{ color: V2.fgFaint }} />
      </div>
    );
  };

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Emulator Cores</div>
      </div>

      {/* Stale folders used to be warned about here; they now live in
          Settings ▸ Folders, beside the folders themselves. */}

      {/* Nothing installed: the per-platform list would be a wall of "no core"
          rows that can't be resolved, so it collapses to the install prompt. */}
      {emu && !emu.installed ? <NoEmulatorSection status={emu} /> : (
      <V2SettingsSection title="Per-platform core">
        {loading ? (
          <V2SettingsRow icon={<FaPuzzlePiece size={16} />} title="Loading cores…" />
        ) : rows.length === 0 ? (
          <V2SettingsRow icon={<FaPuzzlePiece size={16} />}
            title="No platforms detected yet"
            subtitle="Open the Game Browser once to load your library." />
        ) : rows.map((row) => (
          <V2SettingsRow key={row.slug}
            bareIcon
            icon={<PlatformIcon slug={row.slug} size={28} />}
            title={row.platform_name}
            subtitle={busy === row.slug
              ? 'Downloading core…'
              : row.source === 'none'
                ? ((row.download_candidates || []).length
                  ? `No core installed — A to download ${row.download_candidates[0]}`
                  : noDownloadReason
                    ? `No core installed — ${noDownloadReason}`
                    : 'No core installed — A to pick one')
                : row.source === 'override'
                  ? 'Pinned by you — A to change or reset to auto'
                  : 'Auto-resolved — A to pin a specific core'}
            onClick={() => openPicker(row)}
            right={badge(row)} />
        ))}
      </V2SettingsSection>
      )}
    </Focusable>
  );
}
