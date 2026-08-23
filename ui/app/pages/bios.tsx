import { useEffect, useRef, useState } from "react";
import { downloadBios, getBiosInventory, getSwitchAddonMode, setSwitchAddonMode, switchFirmwareStatus } from "../rpc";
import { Focusable, ModalRoot, showModal, toaster } from "@ludo/host";
import { V2_FOCUS_STYLE, v2Page } from "../focus";
import { libBack } from "../nav";
import { GameActionButton, PlatformIcon, UserMenuRow, V2Segment, V2SettingsRow, V2SettingsSection } from "../kit";
import { FaCheckCircle, FaChevronLeft, FaDownload, FaHistory, FaMicrochip, FaSync, FaTimesCircle, FaChevronRight} from "react-icons/fa";
import { _forceGamepadFocus } from "../shell";
import { MODAL_SCRIM_INSET } from "../index";
import { V2, fmtBytes } from "../theme";
import { SwitchFirmwareConfirm, fmtFirmwareProgress, installSwitchFirmwareWatched, switchInstallSummary } from "../firmware";
// BIOS files: which platforms need one, and which of those are satisfied.
//
// A missing BIOS is the most common reason a game that downloaded fine will not
// boot, and the failure is silent inside the emulator — so this page exists to
// answer the question before the user hits it.

// BiosPage — what RomM holds as firmware per platform, versus what's actually in
// RetroArch's system dir, with a button to close the gap.
//
// The server is the source of truth for *which* files a platform wants, not the
// core's libretro .info: the core Ludo resolves is not necessarily the core that
// ends up running the game (the user can switch cores inside RetroArch), so a
// check keyed on the resolved core stays silent for pcsx_rearmed while every PSX
// BIOS is missing. The .info only decides how loudly to say it — 'required'
// means that core won't boot at all, 'optional' means it has an HLE fallback.
// Per-platform status pill: green once every file the server holds is on disk,
// red when the resolved core cannot boot without what's missing, amber when it
// has an HLE fallback and will merely run worse. Shared by the index row and
// the detail panel so the two never disagree.
function biosChip(row: any, chevron?: boolean) {
  const ok = row.missing_count === 0;
  const color = ok ? V2.success : (row.severity === 'required' ? V2.danger : V2.warning);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{
        fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color, border: `1px solid ${color}`, borderRadius: V2.radiusChip, padding: '1px 6px',
      }}>{ok ? 'complete'
            // Switch names what is missing instead of counting files: the
            // platform has exactly two things worth having, and "2 missing"
            // is a number you must open the panel to decode.
            : row.missing_label ? `${row.missing_label} missing`
            : `${row.missing_count} missing`}</span>
      {chevron && <FaChevronRight size={12} style={{ color: V2.fgFaint }} />}
    </div>
  );
}

export function BiosPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [biosDir, setBiosDir] = useState('');
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  // The server couldn't be asked (typically busy serving a library fetch) —
  // NOT the same as it holding no firmware, which is what this page used to
  // claim in that case.
  const [unavailable, setUnavailable] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const load = async (refresh = false) => {
    try {
      const r = await getBiosInventory(refresh);
      if (r?.success) {
        setRows(r.platforms || []);
        setBiosDir(r.bios_dir || '');
        setConnected(!!r.connected);
        setUnavailable(!!r.unavailable);
        setLibraryLoading(!!r.library_loading);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Come back on our own while the server is busy, so the page fills in when
  // the fetch eases off instead of parking on an error the user has to poke.
  useEffect(() => {
    if (!unavailable) return;
    const t = setTimeout(() => load(true), 5000);
    return () => clearTimeout(t);
  }, [unavailable, rows]);

  const openDetail = (row: any) =>
    showModal(<BiosDetailModal slug={row.slug} platformName={row.platform_name || row.name}
      seed={row} onChanged={load} />);

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Firmware / BIOS</div>
      </div>

      <V2SettingsSection title={biosDir ? `Stored in ${biosDir}` : 'BIOS'}>
        {loading ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />} title="Checking BIOS files…" />
        ) : !connected ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />}
            title="Not connected to RomM"
            subtitle="Connect to RomM to see its firmware." />
        ) : unavailable ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />}
            title={libraryLoading ? 'Waiting for your library to finish loading…'
              : 'Couldn’t read firmware from RomM'}
            subtitle={libraryLoading
              ? 'Your server is busy sending the library. Retrying…'
              : 'Your server didn’t answer. Retrying…'} />
        ) : rows.length === 0 ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />}
            title="No firmware on the server"
            subtitle="Upload BIOS files to a platform in RomM." />
        ) : rows.map((row) => (
          <V2SettingsRow key={row.slug}
            bareIcon
            icon={<PlatformIcon slug={row.slug} size={28} />}
            title={row.platform_name || row.name}
            subtitle={row.missing_label
              ? `${row.missing_label} missing — A to review`
              : row.missing_count === 0
                ? `${(row.files || []).length} file${(row.files || []).length === 1 ? '' : 's'} in place`
                : `${(row.files || []).length} file${(row.files || []).length === 1 ? '' : 's'} — A to review`}
            onClick={() => openDetail(row)}
            right={biosChip(row, true)} />
        ))}
      </V2SettingsSection>
    </Focusable>
  );
}

// One platform's firmware, as a panel rather than a page — the same shape as
// CorePickerModal, which is the other "settle one platform's emulation detail"
// surface. Opened from a BiosPage row or straight from a platform's actions
// menu, where the grid underneath is the context the user wants back.
//
// `seed` paints immediately when the caller already has the row; without one
// (the actions-menu path) the panel fetches the inventory itself.
export function BiosDetailModal({ slug, platformName, seed, onChanged, closeModal }: {
  slug: string; platformName?: string; seed?: any;
  onChanged?: () => void; closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<any>(seed || null);
  const [loading, setLoading] = useState(!seed);
  const [busy, setBusy] = useState(false);
  // Live transfer line while the detached firmware install runs. Empty at
  // rest; a bare "Installing…" with nothing moving is indistinguishable from
  // a hang, which is what this row used to be.
  const [progress, setProgress] = useState('');
  // What is actually installed on THIS device, for the Switch panel only. The
  // file rows above say what RomM holds and whether a file by that name is
  // present; neither answers "which firmware am I running", which is the
  // question someone opens this panel with after an emulator update.
  const [fw, setFw] = useState<any>(null);
  // Where Switch updates and DLC go. Eden 0.2.0-rc1 reads them from a folder;
  // older Eden only applies what is installed into NAND. The panel is the one
  // place that already knows this platform is Switch, so the choice lives here
  // rather than in a global settings list where it would mean nothing.
  const [addOn, setAddOn] = useState<any>(null);
  const [addOnBusy, setAddOnBusy] = useState(false);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);

  const load = async () => {
    try {
      const r = await getBiosInventory(false);
      if (r?.success) setRow((r.platforms || []).find((p: any) => p.slug === slug) || null);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { if (!seed) load(); }, []);

  // Stays open through the download: the panel is the only thing confirming it
  // worked, and closing on activate would take the answer away with it.
  // Switch firmware is not a BIOS file. It is a ~324 MB archive of NCAs that
  // belongs in Eden's NAND tree, and download_bios would drop it in RetroArch's
  // system directory where Eden never looks — so this platform routes to its
  // own installer. Everything else keeps the original path unchanged.
  const isSwitch = slug === 'switch' || /nintendo\s*switch/i.test(
    row?.platform_name || row?.name || platformName || '');

  const fetchAll = async () => {
    setBusy(true);
    try {
      if (isSwitch) {
        // Prompt first. ~340 MB into another application's system tree is not
        // something to start on a single button press without saying so --
        // and when nothing has changed, this answers without transferring
        // anything at all. Keys are deliberately NOT gated behind this: they
        // are ~14 KB, Eden cannot start a game without them, and they sync
        // with an ordinary Switch pass.
        const avail = await switchFirmwareStatus();
        if (avail && avail.available === false && avail.file_name) {
          toaster.toast({ title: 'Switch firmware', body: 'Already up to date' });
          return;
        }
        if (avail?.available) {
          const mb = avail.size ? `${(avail.size / 1048576).toFixed(0)} MB` : 'a large download';
          const ok = await new Promise<boolean>((resolve) => {
            showModal(
              <SwitchFirmwareConfirm
                fileName={avail.file_name}
                size={mb}
                reason={avail.reason}
                keysOk={avail.keys_ok}
                version={avail.version}
                installedVersion={avail.installed_version}
                onAnswer={resolve}
              />
            );
          });
          if (!ok) return;
        }
        const r = await installSwitchFirmwareWatched(
          (tick) => setProgress(fmtFirmwareProgress(tick)));
        setProgress('');
        toaster.toast({ title: 'Switch firmware', body: switchInstallSummary(r) });
      } else {
        const r = await downloadBios(slug, '');
        if (!r?.success) toaster.toast({ title: 'BIOS', body: r?.message || 'Download failed' });
      }
      await load();
      if (isSwitch) await loadFirmware();
      onChanged?.();
    } catch {
      toaster.toast({ title: isSwitch ? 'Switch firmware' : 'BIOS', body: 'Download failed' });
    } finally { setBusy(false); }
  };

  const loadFirmware = async () => {
    try { setFw(await switchFirmwareStatus()); } catch { /* leave the line off */ }
  };
  useEffect(() => { if (isSwitch) loadFirmware(); }, [isSwitch]);

  const loadAddOnMode = async () => {
    try { setAddOn(await getSwitchAddonMode()); } catch { /* ignore */ }
  };
  useEffect(() => { if (isSwitch) loadAddOnMode(); }, [isSwitch]);
  const changeAddOnMode = async (mode: string) => {
    if (addOnBusy || mode === addOn?.mode) return;
    setAddOnBusy(true);
    // Optimistic, then replaced by what the backend reports: switching to the
    // folder mode also tries to register it with Eden, and whether THAT
    // worked is the part worth waiting to show.
    setAddOn((a: any) => ({ ...a, mode }));
    try { setAddOn(await setSwitchAddonMode(mode)); }
    catch { await loadAddOnMode(); }
    finally { setAddOnBusy(false); }
  };

  const files = row?.files || [];
  const missing = row?.missing_count || 0;
  // installed_version is deliberately null when Eden's registered/ is empty,
  // so an absent firmware never reads as a version number.
  const fwLine = !isSwitch || !fw ? null
    : fw.installed_version ? `Firmware: ${fw.installed_version}`
    : fw.installed ? `Firmware: version unknown (${fw.installed} files)`
    : 'Firmware: not installed';
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
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '6px 8px 10px',
          }}>
            <div style={{
              flex: '1 1 auto', minWidth: 0,
              fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: V2.fgMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>BIOS · {row?.platform_name || row?.name || platformName || ''}</div>
            {row && biosChip(row)}
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />

          {loading ? (
            <UserMenuRow icon={<FaMicrochip size={13} />} label="Checking…" disabled onSelect={() => {}} />
          ) : !row ? (
            <div style={{ padding: '10px 10px 14px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
              RomM holds no firmware for this platform. Upload it under the
              platform’s Firmware tab and it will show up here.
            </div>
          ) : (
            <>
              {/* Exact filenames, because RetroArch matches BIOS on the name:
                  knowing it wants scph5501.bin specifically is the difference
                  between a fix and a guess. */}
              {/* A superseded firmware set is neither present nor missing:
                  a device holds exactly one, so an older upload sitting
                  beside the current one is history, not a gap. Shown greyed
                  with its own label rather than a red cross that would never
                  clear no matter how much is installed. */}
              {files.map((f: any) => (
                <UserMenuRow key={f.name}
                  icon={f.superseded
                    ? <FaHistory size={13} style={{ color: V2.fgFaint }} />
                    : f.present
                      ? <FaCheckCircle size={13} style={{ color: V2.success }} />
                      : <FaTimesCircle size={13} style={{ color: row.severity === 'required' ? V2.danger : V2.warning }} />}
                  label={`${f.name}  ·  ${fmtBytes(f.size)}${f.superseded ? '  ·  superseded' : ''}`}
                  disabled onSelect={() => {}} />
              ))}
              {fwLine && (
                <>
                <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
                <div style={{ padding: '8px 10px 12px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
                  {/* One line, not two. The master-key generation belongs in
                      the install prompt, where it is deciding something; here
                      the only question is whether the set is complete, and
                      "keys installed" is the whole answer. */}
                  {fwLine}{fw?.keys_installed ? ' · Keys installed' : ''}
                </div>
                {/* Updates & DLC placement. Two modes, and the difference is
                    not cosmetic: the folder keeps one file per add-on where
                    the user (and RetroDECK) can see it, while NAND explodes it
                    into anonymous NCAs. The folder needs Eden 0.2.0-rc1 and it
                    needs Eden to know the path — an unregistered folder is the
                    silent failure this block exists to make loud. */}
                <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 10px 12px' }}>
                  <div style={{ fontSize: '12px', color: V2.fg2 }}>Updates &amp; DLC</div>
                  {/* The pill sizes to its labels. In a column flex parent it
                      would otherwise stretch edge to edge, which reads as a
                      progress bar rather than a two-way choice. */}
                  <div style={{ display: 'flex' }}>
                    <V2Segment
                      options={[{ id: 'extcontent', label: 'Folder' },
                                { id: 'nand', label: 'Install to NAND' }]}
                      value={addOn?.mode || 'extcontent'}
                      disabled={addOnBusy}
                      onChange={changeAddOnMode} />
                  </div>
                  <div style={{ fontSize: '11.5px', color: V2.fgMuted, lineHeight: 1.45 }}>
                    {addOn?.mode === 'nand'
                      ? 'Add-ons are installed into Eden’s NAND. Works on any Eden version, and stores each add-on twice.'
                      : addOn?.eden_registered
                      ? `Eden reads add-ons from ${addOn?.folder || 'the library folder'} — one copy, nothing in NAND.`
                      : !addOn?.folder
                      ? 'Add-ons will go in a folder Eden reads. Download a Switch game first, so there is a folder to put them in.'
                      : !addOn?.eden_configured
                      ? 'Add-ons go in a folder Eden reads. Run Eden once so it writes its config — Ludo will point it at the folder by itself after that.'
                      : addOn?.eden_running
                      ? 'Eden is open, and it rewrites its config when it closes — so Ludo will point it at the folder once Eden has quit. Nothing for you to do.'
                      : 'Ludo could not write Eden’s config. Add the folder yourself under Settings → General → External Content. Needs Eden 0.2.0-rc1 or newer.'}
                  </div>
                </div>
                </>
              )}
              {/* Nothing missing means nothing to say: the ticks above
                  already state it, and a paragraph restating them was the
                  panel's largest element for its least informative case. The
                  divider goes with the row it separates -- without one, it
                  would hang under the last file with nothing below it. */}
              {missing > 0 && (
                <>
                  <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
                  <UserMenuRow
                    icon={busy
                      ? <FaSync size={13} style={{ animation: 'spin 1s linear infinite' }} />
                      : <FaDownload size={13} />}
                    label={busy
                      ? (isSwitch ? (progress || 'Installing…') : 'Downloading…')
                      : isSwitch ? 'Install firmware into Eden'
                      : `Download ${missing} missing file${missing === 1 ? '' : 's'}`}
                    disabled={busy}
                    onSelect={() => { if (!busy) fetchAll(); }} />
                </>
              )}
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}
