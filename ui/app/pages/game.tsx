import { Focusable, GamepadButton, ModalRoot, showModal, toaster, Navigation, DialogButton} from "@ludo/host";
import { V2, fmtBytes, fmtReleaseDate, formatEta, formatSpeed } from "../theme";
import { FaBookmark, FaBoxOpen, FaCheckCircle, FaClock, FaClone, FaCloudUploadAlt, FaCopy, FaDownload, FaFolder, FaLayerGroup, FaPlay, FaPuzzlePiece, FaRedo, FaSync, FaTimes, FaTrash, FaUndo, FaUnlink, FaExclamationTriangle, FaExternalLinkAlt, FaLink, FaMicrochip, FaUsers, FaChevronLeft, FaChevronRight} from "react-icons/fa";
import { useEffect, useRef, useState } from "react";
import { V2Focus, V2_FOCUS_STYLE, v2Page } from "../focus";
import { deleteGame, downloadGame, getGameDetail, getLocalDiscs, getRaEarned, getSaveHistory, getSaveScreenshot, restoreSaveVersion, getSwitchAddOns} from "../rpc";
import { _forceGamepadFocus, _gpFocusEl, playSteamSound, useAutoFocus } from "../shell";
import {
  MODAL_SCRIM_INSET,
  openGameById,
  useEmulatorStatus,
  SectionHeading,
  discDisplayLabel,
  LocalDisc,
  ToastCover,
  cannotLaunch,
  openDiscPicker,
  runLaunch,
  standaloneFor,
  useRommImage,
  useSaveActivityFor,
} from "../index";
import { Bumper, GameActionButton, PlatformIcon, V2Button, V2SettingsRow } from "../kit";
import { _dlSucceeded, _setDlActive, awaitDownload, useDownloadProgress, useIsDownloading, downloadOne} from "../downloads";
import { maybePromptSwitchFirmware } from "../firmware";
import { libBack, libNavigate } from "../nav";
import { GameCover } from "../media";
import { MdVerified } from "react-icons/md";
import { getLibGameHolder, getLibGameOrigin, libCacheSetDownloaded} from "../libcache";
// One game, in full: the hero art, the actions, and the four metadata tabs.
//
// The tabs are where most of this lives — overview, files, save data,
// achievements — and they are cycled with the bumpers rather than tapped,
// because that is what a gamepad makes cheap. The page reads its rom from the
// holder the previous screen set rather than from its route parameter; see
// the note in the library cache for why the parameter is decorative.

// MetadataTab — file info · hashes (click-to-copy) · verification tags ·
// provider grid (RomM MetadataTab).
// RomM RTabNav "underlined" variant — tabs over a bottom border with a 2px
// brand underline that slides between the active tab (GameDetails tab strip).
// AgeRatingBadges — 44px icon badges from the IGDB rating-icon CDN (loaded
// directly), falling back to a shield text chip when the icon 404s (RomM
// AgeRatingBadges).
// A hash as RomM draws it: the algorithm name on a darker inset, the abbreviated
// value in monospace, and a copy affordance. Activating it copies the FULL hash.
// RomM abbreviates a hash to its head and tail (e014f6…8c8fe5) — the full value
// is only useful pasted somewhere, and the chip is a copy button, not a readout.
function shortHash(v: string): string {
  return v.length > 16 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v;
}

function HashChip({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  const copy = () => {
    try { navigator.clipboard?.writeText(value); toaster.toast({ title: `${label} copied`, body: value }); } catch { /* ignore */ }
  };
  return (
    <Focusable noFocusRing onActivate={copy} onClick={copy} style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px', maxWidth: '100%',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`,
      borderRadius: V2.radiusChip, overflow: 'hidden', cursor: 'pointer', fontSize: '11px',
    }}>
      <span style={{
        alignSelf: 'stretch', display: 'flex', alignItems: 'center', padding: '3px 8px',
        background: 'rgba(0,0,0,0.28)', fontWeight: 700, letterSpacing: '0.04em',
        color: V2.fgFaint,
      }}>{label}</span>
      <span style={{
        fontFamily: 'monospace', color: V2.fg2, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{shortHash(value)}</span>
      <FaCopy size={10} style={{ color: V2.fgFaint, flexShrink: 0, marginRight: '8px' }} />
    </Focusable>
  );
}

// Fullscreen screenshot lightbox — RCarousel equivalent. L1/R1 or the
// on-screen arrows page through; A/B close.
function ScreenshotLightbox({ paths, index, closeModal }:
  { paths: string[]; index: number; closeModal?: () => void; }) {
  const [i, setI] = useState(index);
  const uri = useRommImage(paths[i]);
  const go = (d: -1 | 1) => setI((p) => (p + d + paths.length) % paths.length);
  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) go(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) go(1);
  };
  const multi = paths.length > 1;

  // Sample the left/right edge luminance of the current shot so each arrow can
  // flip to a light or dark scrim and stay legible over the image behind it.
  // true = that edge is dark → use a light scrim with a dark icon.
  const [edgeDark, setEdgeDark] = useState<{ left: boolean; right: boolean }>({ left: true, right: true });
  useEffect(() => {
    if (!uri) { setEdgeDark({ left: true, right: true }); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = 64, h = Math.max(1, Math.round(64 * img.height / Math.max(1, img.width)));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const lum = (x0: number) => {
          const d = ctx.getImageData(x0, 0, Math.max(1, Math.round(w * 0.18)), h).data;
          let s = 0, n = 0;
          for (let k = 0; k < d.length; k += 4) { s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; n++; }
          return n ? s / n : 0;
        };
        if (alive) setEdgeDark({ left: lum(0) < 140, right: lum(Math.round(w * 0.82)) < 140 });
      } catch { /* canvas may be tainted; keep default */ }
    };
    img.src = uri;
    return () => { alive = false; };
  }, [uri]);

  // Circular scrim arrow matching the Home CardRow chevrons, but with the
  // scrim/icon inverted on bright screenshot edges for contrast.
  const arrowStyle = (side: 'left' | 'right'): any => {
    const dark = side === 'left' ? edgeDark.left : edgeDark.right;
    return {
      position: 'absolute', [side]: '8px', zIndex: 2,
      minWidth: '36px', width: '36px', height: '36px', padding: 0, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
      color: dark ? '#07070f' : V2.fg2,
      border: dark ? '1px solid rgba(0,0,0,0.2)' : `1px solid ${V2.border}`,
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
      transition: 'background 0.2s ease, color 0.2s ease',
    };
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Focusable noFocusRing onButtonDown={onButtonDown}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
        <div style={{
          position: 'relative', width: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          {multi && (
            <DialogButton onClick={() => go(-1)} style={arrowStyle('left')}>
              <FaChevronLeft size={15} />
            </DialogButton>
          )}
          {uri ? (
            <img src={uri} style={{
              maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain',
              borderRadius: V2.radiusMd, boxShadow: V2.elev2,
            }} />
          ) : (
            <div style={{
              width: '100%', aspectRatio: '16 / 9', borderRadius: V2.radiusMd,
              background: V2.surface, display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: V2.fgMuted, fontSize: '12px',
            }}>Loading…</div>
          )}
          {multi && (
            <DialogButton onClick={() => go(1)} style={arrowStyle('right')}>
              <FaChevronRight size={15} />
            </DialogButton>
          )}
        </div>
        {multi && (
          <div style={{ fontSize: '12px', color: V2.fgMuted }}>{i + 1} / {paths.length}</div>
        )}
      </Focusable>
    </ModalRoot>
  );
}

function AgeRatingBadge({ item }: { item: { category: string; rating: string; icon_url: string | null } }) {
  const [failed, setFailed] = useState(false);
  const label = item.category ? `${item.category}: ${item.rating}` : item.rating;
  if (item.icon_url && !failed) {
    return <img src={item.icon_url} alt={label} title={label} loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: '44px', height: '44px', objectFit: 'contain', borderRadius: V2.radiusSm,
        background: V2.surface, padding: '3px', border: `1px solid ${V2.border}`
      }} />;
  }
  return (
    <span title={label} style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
      fontSize: '11.5px', fontWeight: 600, color: V2.fg2, letterSpacing: '0.02em',
    }}>🛡 {label}</span>
  );
}

// ── Files tab ───────────────────────────────────────────────────────────────
// Mirrors RomM's ROM Files tab: a header card for the entry itself (filename,
// file count + total size, ROM-level hashes), then one card per RomFile with its
// category, size and own hashes. Everything is visible at once — nothing
// collapses — and the file's path and modified date are deliberately absent,
// because RomM shows neither.
const FILE_CATEGORY_LABEL: Record<string, string> = {
  game: 'Game', dlc: 'DLC', update: 'Update', mod: 'Mod', patch: 'Patch',
  demo: 'Demo', manual: 'Manual', hack: 'Hack', prototype: 'Prototype',
  translation: 'Translation',
};

function HashChipRow({ crc, md5, sha1 }: { crc?: string | null; md5?: string | null; sha1?: string | null }) {
  if (!crc && !md5 && !sha1) return null;
  return (
    // RomM's order: the strongest hash first.
    <Focusable noFocusRing style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      <HashChip label="SHA-1" value={sha1} />
      <HashChip label="MD5" value={md5} />
      <HashChip label="CRC" value={crc} />
    </Focusable>
  );
}

// Metadata-provider registry (RomM providers.ts): id field · brand colour ·
// logo asset · external URL builder.
const PROVIDERS: { key: string; name: string; color: string; logo: string; url: ((id: any) => string) | null }[] = [
  { key: 'igdb_id', name: 'IGDB', color: '#6366f1', logo: '/assets/scrappers/igdb.png', url: (id) => `https://www.igdb.com/search?type=1&q=${id}` },
  { key: 'moby_id', name: 'MobyGames', color: '#f59e0b', logo: '/assets/scrappers/moby.png', url: (id) => `https://www.mobygames.com/game/${id}/` },
  { key: 'ss_id', name: 'ScreenScraper', color: '#3b82f6', logo: '/assets/scrappers/ss.png', url: (id) => `https://www.screenscraper.fr/gameinfos.php?gameid=${id}` },
  { key: 'ra_id', name: 'RetroAchievements', color: '#ef4444', logo: '/assets/scrappers/ra.png', url: (id) => `https://retroachievements.org/game/${id}` },
  { key: 'sgdb_id', name: 'SteamGridDB', color: '#0ea5e9', logo: '/assets/scrappers/sgdb.png', url: (id) => `https://www.steamgriddb.com/game/${id}` },
  { key: 'launchbox_id', name: 'LaunchBox', color: '#8b5cf6', logo: '/assets/scrappers/launchbox.png', url: (id) => `https://gamesdb.launchbox-app.com/games/dbid/${id}` },
  { key: 'hasheous_id', name: 'Hasheous', color: '#6b7280', logo: '/assets/scrappers/hasheous.png', url: null },
  { key: 'flashpoint_id', name: 'Flashpoint Archive', color: '#f97316', logo: '/assets/scrappers/flashpoint.png', url: null },
  { key: 'hltb_id', name: 'HowLongToBeat', color: '#22c55e', logo: '/assets/scrappers/hltb.png', url: (id) => `https://howlongtobeat.com/game/${id}` },
];

// One 16:9 screenshot thumbnail — opens the lightbox on activate.
function ScreenshotThumb({ paths, index }: { paths: string[]; index: number; }) {
  const uri = useRommImage(paths[index]);
  const [focused, setFocused] = useState(false);
  const open = () => showModal(<ScreenshotLightbox paths={paths} index={index} />);
  return (
    <Focusable noFocusRing
      onActivate={open}
      onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)}
      onMouseLeave={() => setFocused(false)}
      style={{
        cursor: 'pointer', position: 'relative', aspectRatio: '16 / 9',
        borderRadius: V2.radiusChip, overflow: 'hidden', background: V2.surface,
        transform: 'scale(1)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.tile(focused),
      }}>
      {uri ? (
        <img src={uri} loading="lazy" style={{
          width: '100%', height: '100%', objectFit: 'cover', display: 'block',
        }} />
      ) : null}
    </Focusable>
  );
}

// Where an add-on actually lives, which is the thing a file list cannot show.
// A record written before the two modes existed has no 'mode' and is a NAND
// install by construction.
function switchAddOnWhere(record: any): string {
  return record?.mode === 'extcontent'
    ? 'In the updates folder' : 'Installed in Eden’s NAND';
}

// ── Switch updates and DLC ──────────────────────────────────────────────────
// A Switch patch is not a file the game reads from beside itself. Eden applies
// add-on content only out of its own registered cache, so "downloaded" and
// "installed" are two different states for the same file, and neither one is
// visible from the file list above — a patch NSP sitting in the library folder
// looks identical whether or not it is doing anything. This section is the
// only place that says which.
//
// Everything comes from the switch_add_ons RPC, which answers {kind: null} for
// anything that is not Switch content, so this renders nothing at all on every
// other platform without the Files tab having to know the platform.
function switchVersionLabel(v: any): string {
  return (v === null || v === undefined || v === '') ? '' : `v${v}`;
}

function V2TabNav({ tabs, active, onTab }:
  { tabs: { id: string; label: string }[]; active: string; onTab: (id: string) => void }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const idx = tabs.findIndex((t) => t.id === active);
  useEffect(() => {
    const el = refs.current[idx];
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [idx, tabs.length]);
  return (
    // Deliberately NOT gamepad-focusable: tabs switch with L1/R1 only (the
    // Bumper hints render beside the strip), so the dpad walks straight from
    // the action buttons into the tab CONTENT without stepping through pills.
    // The labels stay clickable for touch/mouse.
    <div style={{ position: 'relative', display: 'flex', gap: '2px', borderBottom: `1px solid ${V2.borderStrong}` }}>
      {tabs.map((t, i) => {
        const on = active === t.id;
        return (
          <div key={t.id} onClick={() => onTab(t.id)} ref={(el) => { refs.current[i] = el; }}
            style={{
              padding: '8px 18px', fontSize: '13px', cursor: 'pointer',
              fontWeight: 500, color: on ? V2.fg : V2.fgMuted, transition: 'color 0.15s ease',
            }}>
            {t.label}
          </div>
        );
      })}
      {ind && (
        <div style={{
          position: 'absolute', bottom: '-1px', height: '2px', borderRadius: '2px 2px 0 0',
          left: `${ind.left}px`, width: `${ind.width}px`, background: V2.brand,
          transition: 'left 0.25s cubic-bezier(0.22,1,0.36,1), width 0.25s cubic-bezier(0.22,1,0.36,1)',
        }} />
      )}
    </div>
  );
}

// PlayerCountBadge — pill with a player icon whose glyph scales with the
// max player count parsed from the free-form string (RomM PlayerCountBadge).
function PlayerCountBadge({ value }: { value: string }) {
  const nums = (value.match(/\d+/g) || []).map(Number);
  const n = nums.length ? Math.max(...nums) : null;
  const label = n === 1 ? 'Single player' : (n && n > 1) ? `${value} players` : value;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '5px 12px 5px 10px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
      fontSize: '12px', color: V2.fg2,
    }}>
      <FaUsers size={14} color={V2.brand} />
      <span style={{ fontWeight: 600, letterSpacing: '0.01em' }}>{label}</span>
    </div>
  );
}

function AgeRatingBadges({ items }: { items: any[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
      {items.map((b, i) => <AgeRatingBadge key={i} item={b} />)}
    </div>
  );
}

// HLTBStrip — up to four columns (main story / +extra / completionist / all
// styles). Durations are seconds → hours rounded to 0.5h (RomM HLTBStrip).
function HLTBStrip({ hltb }: { hltb: any }) {
  const fmtHours = (secs?: number | null): string | null => {
    if (!secs || secs <= 0) return null;
    const hours = secs / 3600;
    if (hours < 1) { const m = Math.round(secs / 60); return m > 0 ? `${m}m` : null; }
    return `${Math.round(hours * 2) / 2}h`;
  };
  const candidates: [string, number | undefined, number | undefined][] = [
    ['Main Story', hltb?.main_story, hltb?.main_story_count],
    ['Main + Extra', hltb?.main_plus_extra, hltb?.main_plus_extra_count],
    ['Completionist', hltb?.completionist, hltb?.completionist_count],
    ['All Styles', hltb?.all_styles, hltb?.all_styles_count],
  ];
  const entries = candidates
    .map(([label, v, c]) => ({ label, value: fmtHours(v), count: c }))
    .filter((e) => e.value);
  if (!entries.length) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', background: V2.bgElevated,
      border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg, padding: '14px 0', maxWidth: '720px',
    }}>
      {entries.map((e, i) => (
        <div key={e.label} style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
          padding: '0 12px', borderRight: i < entries.length - 1 ? `1px solid ${V2.border}` : 'none',
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.fgFaint, textAlign: 'center' }}>{e.label}</div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: V2.fg }}>{e.value}</div>
          {e.count ? <div style={{ fontSize: '10px', color: V2.fgFaint }}>{e.count.toLocaleString()} players</div> : null}
        </div>
      ))}
    </div>
  );
}

// InfoGrid — two-column section grid; each section is icon + uppercase label
// over a row of chips (RomM InfoGrid).
function InfoGrid({ sections }: { sections: { label: string; items: string[]; icon?: any }[] }) {
  const visible = sections.filter((s) => s.items.length > 0);
  if (!visible.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, auto))', gap: '18px 24px', width: '100%' }}>
      {visible.map((s) => (
        <div key={s.label}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '8px',
            fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgFaint,
          }}>
            {s.icon && <span style={{ color: V2.brand, display: 'inline-flex' }}>{s.icon}</span>}
            <span>{s.label}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {s.items.map((it, i) => (
              <span key={i} style={{
                background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
                padding: '4px 10px', fontSize: '11.5px', fontWeight: 500, color: V2.fg2,
              }}>{it}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// RelatedGameCard — static cover tile using IGDB's external cover URL (loads
// directly, no auth). Cover + truncated label, focus lift (RomM RelatedGameCard
// in GameCard static mode). Non-navigating (synthetic).
function RelatedGameCard({ game }: { game: { id: number; name: string; cover_url?: string | null } }) {
  const [focused, setFocused] = useState(false);
  // IGDB thumb URLs are tiny (t_thumb); request the bigger cover art variant.
  const cover = game.cover_url ? game.cover_url.replace('/t_thumb/', '/t_cover_big/') : null;
  return (
    <Focusable noFocusRing
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ width: '110px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'default' }}
    >
      <div style={{
        width: '100%', aspectRatio: '3 / 4', borderRadius: V2.radiusArt, overflow: 'hidden',
        background: V2.coverPlaceholder, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: 'scale(1)', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.tile(focused),
      }}>
        {cover
          ? <img src={cover} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <span style={{ color: V2.fgMuted, fontSize: '10px', padding: '0 6px', textAlign: 'center' }}>{game.name}</span>}
      </div>
      <div style={{
        fontSize: '11px', color: focused ? V2.fg : V2.fg2, textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{game.name}</div>
    </Focusable>
  );
}

// ProviderCard — logo + name + linked id (or "Not linked"); clickable when a
// URL resolves. Logo is base64'd via get_image (RomM-served asset).
function ProviderCard({ p, id }: { p: typeof PROVIDERS[number]; id: any }) {
  const [focused, setFocused] = useState(false);
  const logo = useRommImage(p.logo);
  const linked = id !== null && id !== undefined && id !== '' && id !== 0;
  const href = linked && p.url ? p.url(id) : null;
  const open = () => { if (href) try { Navigation?.NavigateToExternalWeb?.(href); } catch { /* ignore */ } };
  return (
    <Focusable noFocusRing
      onActivate={open} onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 14px',
        background: V2.bgElevated, borderRadius: V2.radiusMd, color: V2.fg,
        border: `1px solid ${focused && href ? p.color : V2.border}`,
        opacity: linked ? 1 : 0.55, cursor: href ? 'pointer' : 'default',
        transform: focused && href ? 'translateY(-1px)' : 'none',
        transition: 'background 0.15s, border-color 0.15s, transform 0.15s',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {logo && <img src={logo} alt={p.name} style={{ width: '16px', height: '16px', objectFit: 'contain', borderRadius: '2px' }} />}
        <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 600, color: V2.fg }}>{p.name}</span>
        {href && <FaExternalLinkAlt size={11} color={V2.fgMuted} />}
      </div>
      <div style={{ fontSize: '11.5px', color: V2.fg2, fontVariantNumeric: 'tabular-nums' }}>
        {linked ? String(id) : <span style={{ fontStyle: 'italic', color: V2.fgFaint }}>Not linked</span>}
      </div>
    </Focusable>
  );
}

// One RomFile, laid out as RomM's file card: name line, then category + size,
// then the file's own hashes. No path or modified date — RomM shows neither.
function FileRow({ f }: { f: any }) {
  const cat = String(f?.category || '').toLowerCase();
  const catLabel = FILE_CATEGORY_LABEL[cat] || (cat ? cat : '');
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      // radiusLg is the surface radius the Screenshots, Save Data and
      // Achievements tabs use — the file cards and the header card above them
      // all share it so the tab reads as one stack.
      padding: '12px', borderRadius: V2.radiusLg,
      background: V2.surface, border: `1px solid ${V2.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        {/* On this device? Only shown when the backend could actually read the
            ROM's folder — an unknown state stays blank rather than guessing. */}
        {f?.on_disk === true
          ? <FaCheckCircle size={12} style={{ color: V2.success, flexShrink: 0 }} />
          : <FaLink size={11} style={{ color: V2.fgFaint, flexShrink: 0 }} />}
        <span style={{
          fontSize: '13px', color: f?.missing ? V2.fgFaint : V2.fg, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: f?.missing ? 'line-through' : 'none',
        }}>{f?.name || '—'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11.5px' }}>
        {catLabel && (
          <span style={{
            flexShrink: 0, padding: '2px 8px', borderRadius: V2.radiusChip,
            background: 'rgba(139,116,232,0.18)', color: V2.brandHover,
            fontSize: '10.5px', fontWeight: 700,
          }}>{catLabel}</span>
        )}
        <span style={{ color: V2.fgMuted }}>{fmtBytes(f?.size)}</span>
        {/* RomM flags files its scanner can no longer find on disk. */}
        {f?.missing && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: V2.fgMuted }}>
            <FaExclamationTriangle size={11} />Missing on server
          </span>
        )}
      </div>
      <HashChipRow crc={f?.crc} md5={f?.md5} sha1={f?.sha1} />
    </div>
  );
}

function SwitchAddOnsSection({ romId }: { romId: number }) {
  const [state, setState] = useState<any | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    try { setState(await getSwitchAddOns(romId)); }
    catch (e) { console.error('switch_add_ons failed', e); setState(null); }
  };
  useEffect(() => { load(); }, [romId]);

  if (!state?.kind) return null;

  // This ROM is itself a patch or an add-on. Its own detail page should say
  // what it belongs to and whether it is live in Eden — listing "its" add-ons
  // would just list itself.
  if (state.kind !== 'base') {
    const label = state.kind === 'update' ? 'Update' : 'DLC';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <SectionHeading icon={<FaPuzzlePiece size={12} />}>Switch add-on</SectionHeading>
        <V2SettingsRow icon={<FaPuzzlePiece size={14} />}
          title={`${label} for ${state.base_id}`}
          subtitle={[state.title_id, switchVersionLabel(state.version),
                     state.installed ? 'Active in Eden' : 'Not active in Eden']
                    .filter(Boolean).join(' · ')}
          right={state.installed
            ? <FaCheckCircle size={12} style={{ color: V2.success }} />
            : <FaLink size={11} style={{ color: V2.fgFaint }} />} />
      </div>
    );
  }

  const update = state.installed_update;
  const dlc: any[] = state.installed_dlc || [];
  // An available add-on is matched to an installed record by the filename the
  // install recorded, which is the only identifier both sides carry: the
  // server row has no title ID until its name is parsed, and the manifest has
  // no ROM ID at all.
  const installedNames = new Set<string>(
    [update, ...dlc].filter(Boolean).map((r: any) => String(r.file_name || '')));
  const available: any[] = (state.available || [])
    .filter((a: any) => !installedNames.has(String(a.file_name || '')));

  if (!update && !dlc.length && !available.length) return null;

  const fetchAddOn = async (a: any) => {
    setBusy(a.rom_id);
    try {
      // The plugin installs a downloaded .nsp/.xci into Eden on the download
      // worker itself, so there is nothing to trigger here afterwards — only
      // the state to re-read.
      const ok = await downloadOne(a.rom_id, a.name || a.file_name);
      toaster.toast({
        title: ok ? 'Add-on installed' : 'Add-on download failed',
        body: a.name || a.file_name,
      });
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SectionHeading icon={<FaPuzzlePiece size={12} />}>Updates &amp; DLC</SectionHeading>
      {update && (
        <V2SettingsRow icon={<FaMicrochip size={14} />}
          title={`Update ${switchVersionLabel(update.version)}`.trim()}
          subtitle={[update.file_name, switchAddOnWhere(update)].filter(Boolean).join(' · ')}
          right={<FaCheckCircle size={12} style={{ color: V2.success }} />} />
      )}
      {dlc.map((d: any) => (
        <V2SettingsRow key={d.title_id} icon={<FaPuzzlePiece size={14} />}
          title={d.file_name || d.title_id}
          subtitle={[d.title_id, switchAddOnWhere(d)].filter(Boolean).join(' · ')}
          right={<FaCheckCircle size={12} style={{ color: V2.success }} />} />
      ))}
      {available.map((a: any) => (
        <V2SettingsRow key={a.rom_id} icon={<FaPuzzlePiece size={14} />}
          // The filename first, not the name: RomM reports an add-on's name as
          // the base game's, so a list keyed on it is several identical rows.
          // The filename is what carries the title ID and the DLC's label.
          title={a.file_name || a.name}
          subtitle={busy === a.rom_id ? 'Downloading…'
            : a.is_downloaded ? 'Downloaded · not active in Eden'
            : 'On the server'}
          disabled={busy !== null}
          onClick={() => fetchAddOn(a)}
          right={<FaDownload size={12} style={{ color: V2.fgMuted }} />} />
      ))}
    </div>
  );
}

// Responsive grid of screenshot thumbnails (RomM ScreenshotsTab).
function ScreenshotGrid({ paths }: { paths: string[]; }) {
  return (
    <Focusable noFocusRing style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: '10px', padding: '6px 6px 4px',
    }}>
      {paths.map((p, i) => <ScreenshotThumb key={p || i} paths={paths} index={i} />)}
    </Focusable>
  );
}

interface HistoryEntry {
  id: number; slot: any; save_type: string; file_name: string;
  updated_at: string | null; size_bytes: number | null;
  device: string | null; has_screenshot: boolean;
}

// One related-games section: eyebrow heading + flex-wrap row of cards.
function RelatedSection({ icon, title, items }: { icon: any; title: string; items: any[] }) {
  if (!items?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SectionHeading icon={icon}>{title}</SectionHeading>
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 16px', padding: '6px 6px 4px' }}>
        {items.map((g) => <RelatedGameCard key={g.id ?? g.name} game={g} />)}
      </Focusable>
    </div>
  );
}

function fmtHistTs(iso: string | null): string {
  if (!iso) return "Unknown time";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function slotLabel(e: HistoryEntry): string {
  const fn = (e.file_name || '').toLowerCase();
  if (fn.endsWith('.state.auto')) return 'Auto';
  const m = fn.match(/\.state(\d+)$/);
  if (m) return `Slot ${m[1]}`;
  if (fn.endsWith('.state')) return 'Quicksave';
  if (e.slot != null && e.slot !== '') return String(e.slot);
  return e.save_type === 'states' ? 'State' : 'Save';
}

// A percentage padded to three cells with U+2007 FIGURE SPACE, which in any
// sane font is exactly one digit wide. Combined with `fontVariantNumeric:
// tabular-nums` on the button, this makes "5%" and "100%" render at the SAME
// width, so a counting progress label cannot resize the pill around it. A
// pixel minWidth alone could not do this: it only sets a floor, and the label
// still outgrew it at 100%.
function padPct(n: number): string {
  return String(n).padStart(3, '\u2007');
}

function fmtHistSize(n: number | null): string {
  if (n == null || isNaN(n as any)) return "";
  let v = Number(n);
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return u === 'B' ? `${v.toFixed(0)} ${u}` : `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

type TypeFilter = 'all' | 'progression' | 'missable' | 'win_condition';

type StatusFilter = 'all' | 'earned' | 'locked';

type Achievement = {
  ra_id: number | null; title: string; description: string; points: number;
  type: string; badge_id: string | null; badge_url: string | null;
  badge_url_lock: string | null; earned: boolean;
};

// Eases a displayed integer toward a target so a stepwise percentage (updated
// every poll) counts up smoothly. Resets to 0 when inactive.
function useSmoothNumber(target: number | null, active: boolean): number {
  const [val, setVal] = useState(0);
  const cur = useRef(0);
  const raf = useRef<any>(null);
  useEffect(() => {
    if (!active) { cur.current = 0; setVal(0); return; }
    const t = target ?? 0;
    const step = () => {
      const diff = t - cur.current;
      if (Math.abs(diff) < 0.5) { cur.current = t; setVal(t); return; }
      cur.current += diff * 0.18;
      setVal(cur.current);
      raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, active]);
  return Math.round(val);
}

export function MetadataTab({ detail }: { detail: any }) {
  const providers = detail?.providers || {};
  const ordered = [...PROVIDERS].sort((a, b) => {
    const av = providers[a.key] ? 1 : 0, bv = providers[b.key] ? 1 : 0;
    return bv - av;
  });
  const hashes = detail?.hashes || {};
  const hashRows: [string, string | null][] = [
    ['CRC', hashes.crc], ['MD5', hashes.md5], ['SHA1', hashes.sha1], ['RA', hashes.ra],
  ];
  const copy = (v: string) => { try { navigator.clipboard?.writeText(v); toaster.toast({ title: 'Copied', body: v }); } catch { /* ignore */ } };
  const heading = (txt: string) => (
    <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{txt}</div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* File info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('File info')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px 24px' }}>
          {[['Filename', detail?.fs_name || '—'], ['Size', detail?.fs_size_bytes ? fmtBytes(detail.fs_size_bytes) : '—']].map(([l, v]) => (
            <div key={l as string} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              <div style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgFaint }}>{l}</div>
              <div style={{ fontSize: '13px', color: V2.fg2, wordBreak: 'break-all' }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      {/* Hashes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Hashes')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {hashRows.map(([label, val]) => (
            <Focusable key={label} noFocusRing
              onActivate={() => val && copy(val)} onClick={() => val && copy(val)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px',
                background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
                fontSize: '11.5px', cursor: val ? 'pointer' : 'default',
              }}>
              <span style={{ fontWeight: 700, color: V2.fgFaint, letterSpacing: '0.06em' }}>{label}</span>
              <span style={{ fontFamily: 'monospace', color: val ? V2.fg2 : V2.fgFaint }}>
                {val ? `${String(val).slice(0, 8)}…` : '—'}
              </span>
            </Focusable>
          ))}
        </div>
      </div>
      {/* Verification */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Verification')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {(detail?.verifications || []).map((v: any) => (
            <span key={v.label} style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
              borderRadius: V2.radiusChip, fontSize: '11.5px', fontWeight: 600,
              background: v.match ? 'rgba(74,222,128,0.12)' : V2.surface,
              border: `1px solid ${v.match ? 'rgba(74,222,128,0.4)' : V2.borderStrong}`,
              color: v.match ? V2.success : V2.fgMuted,
            }}>{v.match ? <FaCheckCircle size={12} /> : <FaTimes size={12} />}{v.label}</span>
          ))}
        </div>
      </div>
      {/* Provider links */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Metadata sources')}
        <Focusable noFocusRing style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
          {ordered.map((p) => <ProviderCard key={p.key} p={p} id={providers[p.key]} />)}
        </Focusable>
      </div>
    </div>
  );
}

export function FilesTab({ detail }: { detail: any }) {
  const list = detail?.files || [];
  const total = list.reduce((a: number, f: any) => a + (Number(f?.size) || 0), 0)
    || Number(detail?.fs_size_bytes) || 0;
  // RomM groups the ROM's own files ahead of the extras (DLC, updates, manuals);
  // within a group it keeps filename order, which is what disc numbering needs.
  const ordered = [...list].sort((a: any, b: any) => {
    const rank = (f: any) => (String(f?.category || 'game').toLowerCase() === 'game' ? 0 : 1);
    return rank(a) - rank(b) || String(a?.name || '').localeCompare(String(b?.name || ''));
  });
  const hashes = detail?.hashes || {};
  const count = ordered.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ROM header — the whole entry: its filename, what it weighs, and the
          ROM-level hashes. RomM leads the Files tab with this card, above the
          per-file list. */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '14px', borderRadius: V2.radiusLg,
        background: V2.surface, border: `1px solid ${V2.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <FaFolder size={14} style={{ color: V2.fg2, flexShrink: 0 }} />
          <span style={{
            fontSize: '15px', fontWeight: 600, color: V2.fg, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{detail?.fs_name || detail?.name || '—'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: V2.fgMuted, fontSize: '11.5px' }}>
          <span>{count} file{count === 1 ? '' : 's'}</span>
          {total > 0 && <><span>·</span><span>{fmtBytes(total)}</span></>}
          {ordered.some((f: any) => f?.on_disk === true) && (
            <><span>·</span><span>{ordered.filter((f: any) => f?.on_disk === true).length} on this device</span></>
          )}
        </div>
        <HashChipRow crc={hashes.crc} md5={hashes.md5} sha1={hashes.sha1} />
      </div>

      {/* Per-file list, under the same "N files" label RomM puts above it. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '11.5px', color: V2.fgMuted, padding: '0 2px' }}>
          {count} file{count === 1 ? '' : 's'}
        </div>
        {count === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px' }}>No file information.</div>
        ) : ordered.map((f: any, i: number) => <FileRow key={f?.id ?? i} f={f} />)}
      </div>
    </div>
  );
}

export function AchievementsTab({ achievements }: { achievements: Achievement[] }) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Which filter pill is focused, so it shows a highlight under the controller
  // (the pills otherwise only reflect active/inactive, not focus).
  const [filterFocus, setFilterFocus] = useState<string | null>(null);
  // Drive the summary progress bar from 0 → pct after mount so it animates in.
  const [barReady, setBarReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBarReady(true), 60); return () => clearTimeout(t); }, []);

  if (!achievements.length) {
    return (
      <div style={{ padding: '30px 0', color: V2.fgMuted, fontSize: '13px', fontStyle: 'italic', textAlign: 'center' }}>
        No achievement data for this game.
      </div>
    );
  }

  const earnedCount = achievements.filter((a) => a.earned).length;
  const totalPoints = achievements.reduce((s, a) => s + (a.points || 0), 0);
  const progressionCount = achievements.filter((a) => a.type === 'progression').length;
  const missableCount = achievements.filter((a) => a.type === 'missable').length;

  const isVisible = (a: Achievement) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (statusFilter === 'earned' && !a.earned) return false;
    if (statusFilter === 'locked' && a.earned) return false;
    return true;
  };

  const typeLabel = (t: string) => t === 'win_condition' ? 'Win Condition' : t.charAt(0).toUpperCase() + t.slice(1);
  const toggleStatus = (s: StatusFilter) => setStatusFilter((cur) => cur === s ? 'all' : s);

  const stat = (val: any, lbl: string, missable = false) => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '0 12px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, color: missable ? V2.warning : V2.fg, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.fgMuted }}>{lbl}</div>
    </div>
  );

  const typeTagStyle = (t: string): any => {
    const base: any = { fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: '8px' };
    if (t === 'progression') return { ...base, background: 'rgba(99,102,241,0.18)', color: V2.igdb };
    if (t === 'missable') return { ...base, background: 'rgba(251,191,36,0.18)', color: V2.warning };
    if (t === 'win_condition') return { ...base, background: 'rgba(74,222,128,0.18)', color: V2.success };
    return { ...base, background: V2.surface, color: V2.fg2 };
  };

  const filterBtn = (key: string, label: string, active: boolean, onClick: () => void, accent?: 'earned' | 'locked') => {
    let bg = V2.surface, color = V2.fg2, border = V2.border;
    if (active) {
      if (accent === 'earned') { bg = 'rgba(74,222,128,0.30)'; border = 'rgba(74,222,128,0.50)'; color = V2.fg; }
      else if (accent === 'locked') { bg = 'rgba(255,80,80,0.24)'; border = 'rgba(255,80,80,0.45)'; color = V2.fg; }
      else { bg = V2.fg; border = V2.fg; color = V2.bg; }
    }
    const focused = filterFocus === key;
    return (
      <Focusable noFocusRing
        key={key}
        onActivate={onClick}
        onClick={onClick}
        onFocus={() => setFilterFocus(key)} onBlur={() => setFilterFocus((c) => c === key ? null : c)}
        onMouseEnter={() => setFilterFocus(key)} onMouseLeave={() => setFilterFocus((c) => c === key ? null : c)}
        style={{
          background: focused && !active ? V2.surfaceHover : bg,
          border: `1px solid ${focused ? V2.brand : border}`, borderRadius: V2.radiusPill,
          color, padding: '5px 13px', fontSize: '11.5px', fontWeight: 500, cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
          ...V2Focus.flat(focused, { glow: true }),
        }}
      >
        {label}
      </Focusable>
    );
  };

  const pct = achievements.length ? Math.round((earnedCount / achievements.length) * 100) : 0;
  const EASE = 'cubic-bezier(0.22,1,0.36,1)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        @keyframes achFade { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .ach-fade { animation: achFade 320ms ${EASE} both; animation-delay: calc(var(--ach-i, 0) * 28ms); }
        /* Row hover is the shared .romm-row (see V2_ROW_STYLE). */
      `}</style>

      <div className="ach-fade" style={{ display: 'flex', flexDirection: 'column', background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg, overflow: 'hidden' }}>
        <div style={{ display: 'flex', padding: '14px 0' }}>
          {stat(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              {earnedCount} / {achievements.length}
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: V2.fgMuted }} />
              {pct}%
            </span>, 'Achievements')}
          <div style={{ width: '1px', background: V2.border }} />
          {stat(totalPoints, 'Total Points')}
          {progressionCount > 0 && <><div style={{ width: '1px', background: V2.border }} />{stat(progressionCount, 'Progression')}</>}
          {missableCount > 0 && <><div style={{ width: '1px', background: V2.border }} />{stat(missableCount, 'Missable', true)}</>}
        </div>
        <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)' }}>
          <div style={{
            height: '100%', width: barReady ? `${pct}%` : '0%',
            background: `linear-gradient(90deg, ${V2.brand}, ${V2.success})`,
            borderRadius: '0 2px 2px 0', transition: `width 800ms ${EASE}`,
          }} />
        </div>
      </div>

      <Focusable noFocusRing className="ach-fade" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', '--ach-i': 1 } as any}>
        {(['all', 'progression', 'missable', 'win_condition'] as TypeFilter[]).map((f) =>
          filterBtn(f, typeLabel(f), typeFilter === f, () => setTypeFilter(f)))}
        <span style={{ width: '1px', height: '16px', background: V2.surfaceHover, margin: '0 4px' }} />
        {filterBtn('earned', '✓ Earned', statusFilter === 'earned', () => toggleStatus('earned'), 'earned')}
        {filterBtn('locked', '⊘ Locked', statusFilter === 'locked', () => toggleStatus('locked'), 'locked')}
      </Focusable>

      {/* Filtered-out rows simply unmount (with a fade on the survivors) so the
          list re-flows without a clipping wrapper — that lets the shared
          .romm-row outset glow show, identical to the saves list. */}
      <Focusable noFocusRing style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {achievements.filter(isVisible).map((a, i) => {
          const src = a.earned ? a.badge_url : a.badge_url_lock;
          // Dim LOCKED rows via their contents, not the Focusable itself: the
          // desktop shim reads an inline opacity<1 on a Focusable as the
          // "disabled control" signal and strips its tabindex, which made locked
          // rows unreachable by the controller (Down dead-ended at the filters).
          const dim = a.earned ? 1 : 0.55;
          return (
            <Focusable noFocusRing key={a.ra_id ?? i} onActivate={() => { }} className="romm-row ach-fade" style={{
              display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: '14px', alignItems: 'center',
              padding: '10px 14px', borderRadius: V2.radiusMd,
              '--ach-i': Math.min(i, 12) + 2,
            } as any}>
              <div style={{ width: '52px', height: '52px', borderRadius: '8px', overflow: 'hidden', background: V2.coverPlaceholder, flexShrink: 0, opacity: dim }}>
                {src && <img src={src} alt={a.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />}
              </div>
              <div style={{ minWidth: 0, opacity: dim }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{a.title}</div>
                <div style={{ fontSize: '11.5px', color: V2.fgMuted, marginTop: '2px', lineHeight: 1.4 }}>{a.description}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', whiteSpace: 'nowrap', opacity: dim }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: V2.fg2, fontVariantNumeric: 'tabular-nums' }}>{a.points} pts</div>
                {a.type && <span style={typeTagStyle(a.type)}>{typeLabel(a.type)}</span>}
              </div>
            </Focusable>
          );
        })}
      </Focusable>
    </div>
  );
}

// Restore modal — a bare ModalRoot styled entirely in the RomM v2 design
// language (tokens, V2Button) rather than Steam chrome. Previews the chosen
// version (screenshot for states) and exposes Restore / Restore-as-copy /
// Cancel. closeModal is injected by showModal.
export function RestoreModal({ romId, entry, shotUri, onDone, closeModal }: {
  romId: number; entry: HistoryEntry; shotUri?: string; onDone: () => void; closeModal?: () => void;
}) {
  const isState = entry.save_type === 'states';
  const [shot, setShot] = useState<string | null>(shotUri ?? null);
  // Fetch a preview for any version (saves can carry screenshots too), unless
  // we were handed a cached one. Loading runs until the fetch resolves.
  const [loadingShot, setLoadingShot] = useState(!shotUri);
  const [busy, setBusy] = useState<null | 'restore' | 'copy'>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shotUri) return;
    getSaveScreenshot(romId, entry.id, entry.save_type)
      .then((r: any) => setShot(r?.data_uri || null))
      .catch(() => setShot(null))
      .finally(() => setLoadingShot(false));
  }, []);

  // Move controller focus into the overlay (no ModalRoot to do it for us).
  useEffect(() => {
    const t = setTimeout(() => { if (cardRef.current) _forceGamepadFocus(cardRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);

  const run = async (asCopy: boolean) => {
    if (busy) return;
    setBusy(asCopy ? 'copy' : 'restore');
    try {
      const res = await restoreSaveVersion(romId, entry.id, entry.save_type, asCopy);
      if (res?.success) {
        toaster.toast({ title: 'Restored', body: res.tgt_name ? `→ ${res.tgt_name}` : 'Version restored' });
        onDone();
        closeModal?.();
      } else {
        toaster.toast({ title: 'Restore failed', body: res?.message || 'Unknown error' });
        setBusy(null);
      }
    } catch (e) {
      toaster.toast({ title: 'Restore failed', body: String(e) });
      setBusy(null);
    }
  };

  const meta = [slotLabel(entry), entry.device || '', fmtHistSize(entry.size_bytes)].filter(Boolean).join(' · ');

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing
        className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}
      >
        <style>{`
        @keyframes sdShimmer { 0% { background-position: -150% 0; } 100% { background-position: 150% 0; } }
        .sd-shimmer { background-image: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%) !important; background-size: 200% 100% !important; background-repeat: no-repeat; animation: sdShimmer 1.1s linear infinite; }
        ${V2_FOCUS_STYLE}
        /* Collapse ModalRoot's own panel chrome so only our overlay shows. */
        .romm-modal-collapse, .romm-modal-collapse > div {
          background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
        }
      `}</style>
        <Focusable noFocusRing autoFocus ref={cardRef} flow-children="vertical" style={{
          fontFamily: V2.font, color: V2.fg, width: '520px', maxWidth: '90vw', boxSizing: 'border-box',
          padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px',
          maxHeight: '82vh', overflowY: 'auto',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
        }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.brand }}>
              Restore {isState ? 'state' : 'save'}
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '4px' }}>{fmtHistTs(entry.updated_at)}</div>
            {meta && <div style={{ fontSize: '13px', color: V2.fg2, marginTop: '4px' }}>{meta}</div>}
          </div>

          <div className={loadingShot ? 'sd-shimmer' : ''} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: loadingShot || !shot ? '120px' : undefined,
            backgroundColor: (loadingShot || !shot) ? V2.coverPlaceholder : 'transparent',
            borderRadius: V2.radiusLg, overflow: 'hidden',
            border: (loadingShot || !shot) ? `1px solid ${V2.border}` : 'none',
          }}>
            {loadingShot ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: V2.fgMuted }}>
                <FaSync size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: '12px' }}>Loading preview…</span>
              </div>
            ) : shot ? (
              <img src={shot} style={{ maxWidth: '100%', maxHeight: '210px', width: 'auto', display: 'block', borderRadius: V2.radiusLg }} />
            ) : (
              <span style={{ fontSize: '12px', color: V2.fgMuted }}>No preview available</span>
            )}
          </div>

          <div style={{ fontSize: '12.5px', color: V2.fg2, lineHeight: 1.55, background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusMd, padding: '10px 12px' }}>
            <span style={{ color: V2.fg, fontWeight: 600 }}>Restore (overwrite)</span> replaces the current file with this version. The current file is backed up first.
            {isState && <><br /><span style={{ color: V2.fg, fontWeight: 600 }}>Restore as copy</span> writes this version into a new free slot, leaving your current slots untouched.</>}
          </div>

          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px', flexWrap: 'nowrap', justifyContent: 'flex-end', alignItems: 'center' }}>
            <V2Button variant="text" disabled={!!busy} onClick={() => closeModal?.()}>Cancel</V2Button>
            {isState && (
              <V2Button variant="tonal" disabled={!!busy} onClick={() => run(true)}>
                {busy === 'copy' ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FaCopy size={12} />}
                <span>Restore as copy</span>
              </V2Button>
            )}
            <V2Button variant="danger" disabled={!!busy} onClick={() => run(false)}>
              {busy === 'restore' ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FaUndo size={12} />}
              <span>Restore (overwrite)</span>
            </V2Button>
          </Focusable>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Inline Save Data tab — Saves + States subtabs, mirrors RomM's SaveDataTab.
// Saves are a vertical info list; States are a screenshot tile grid. Selecting
// an item reveals inline restore actions (restore-in-place, and restore-as-copy
// for states) backed by the same callables the standalone history page uses.
export function SaveDataTab({ romId }: { romId: number }) {
  const [sub, setSub] = useState<'saves' | 'states'>('saves');
  const [loading, setLoading] = useState(true);
  const [saves, setSaves] = useState<HistoryEntry[]>([]);
  const [states, setStates] = useState<HistoryEntry[]>([]);
  // shots[id]: 'loading' while fetching, '' once resolved with no screenshot,
  // otherwise the data URI. Absence means not yet requested.
  const [shots, setShots] = useState<Record<number, string>>({});
  // Gamepad focus under gamescope doesn't reliably fire CSS :focus-within, so
  // the selected save/state gets no highlight. Track the focused entry in JS
  // and paint the brand highlight explicitly (same approach as the nav tabs).
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [pillFocus, setPillFocus] = useState<'saves' | 'states' | null>(null);
  const EASE = 'cubic-bezier(0.22,1,0.36,1)';

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getSaveHistory(romId);
      if (res?.success) {
        setSaves(res.saves || []);
        setStates(res.states || []);
      } else if (!silent) {
        setSaves([]); setStates([]);
      }
    } catch (e) {
      console.error('get_save_history failed', e);
      if (!silent) { setSaves([]); setStates([]); }
    } finally {
      if (!silent) setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // After a restore the new version is written locally and the file watcher
  // uploads it to the server a moment later. Mirror the GTK app's
  // _await_restore_sync: snapshot the current ids, wait for the upload debounce,
  // then poll once a second until a new id appears (bounded deadline).
  const pollCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pollCancelRef.current?.(), []);
  const reloadAfterRestore = () => {
    pollCancelRef.current?.();
    const baseline = new Set<number>([...saves, ...states].map((e) => e.id));
    let cancelled = false;
    pollCancelRef.current = () => { cancelled = true; };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await sleep(3500); // upload debounce + buffer
      const deadline = Date.now() + 20000;
      while (!cancelled) {
        try {
          const res = await getSaveHistory(romId);
          if (res?.success) {
            const ids = [...(res.saves || []), ...(res.states || [])].map((e: any) => e.id);
            const hasNew = ids.some((id) => !baseline.has(id));
            if (hasNew || Date.now() >= deadline) {
              setSaves(res.saves || []); setStates(res.states || []);
              return;
            }
          }
        } catch { /* keep polling */ }
        if (Date.now() >= deadline) return;
        await sleep(1000);
      }
    })();
  };

  // Lazily fetch state screenshots once the States subtab is opened. The
  // backend serves them one request at a time, so fetch sequentially, newest
  // first, and commit each result as it lands — tiles fill in progressively
  // instead of all appearing only once the last one finishes.
  const requestedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (sub !== 'states') return;
    const queue = states
      .filter((s) => !requestedRef.current.has(s.id))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    if (!queue.length) return;
    queue.forEach((s) => requestedRef.current.add(s.id));
    setShots((p) => {
      const next = { ...p };
      queue.forEach((s) => { if (!(s.id in next)) next[s.id] = 'loading'; });
      return next;
    });
    let cancelled = false;
    (async () => {
      for (const s of queue) {
        if (cancelled) return;
        try {
          const r: any = await getSaveScreenshot(romId, s.id, 'states');
          setShots((p) => ({ ...p, [s.id]: r?.data_uri || '' }));
        } catch {
          setShots((p) => ({ ...p, [s.id]: '' }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sub, states]);

  const openRestore = (e: HistoryEntry) => {
    const cached = shots[e.id];
    const shotUri = (cached && cached !== 'loading') ? cached : undefined;
    showModal(<RestoreModal romId={romId} entry={e} shotUri={shotUri} onDone={reloadAfterRestore} />);
  };

  const pill = (id: 'saves' | 'states', label: string, count: number) => {
    const active = sub === id;
    const focused = pillFocus === id;
    return (
      <Focusable noFocusRing
        key={id}
        onActivate={() => setSub(id)}
        onClick={() => setSub(id)}
        onFocus={() => setPillFocus(id)} onBlur={() => setPillFocus((c) => c === id ? null : c)}
        onMouseEnter={() => setPillFocus(id)} onMouseLeave={() => setPillFocus((c) => c === id ? null : c)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '7px',
          background: active ? V2.fg : (focused ? V2.surfaceHover : V2.surface),
          border: `1px solid ${active ? V2.fg : (focused ? V2.brand : V2.border)}`,
          borderRadius: V2.radiusPill, color: active ? V2.bg : V2.fg2,
          padding: '5px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
          // Ring on focus even when the pill is the ACTIVE one (like the
          // achievements filters) — the tab-switch focus-pull lands here, and
          // without the ring the landing was invisible.
          ...V2Focus.flat(focused, { glow: true }),
        }}
      >
        {label}
        <span style={{
          fontSize: '10px', fontWeight: 700, padding: '0px 6px', borderRadius: V2.radiusPill,
          background: active ? 'rgba(0,0,0,0.18)' : V2.surfaceHover, color: active ? V2.bg : V2.fgMuted,
        }}>{count}</span>
      </Focusable>
    );
  };

  // Group a type's entries by slot, newest-first within each slot (the newest
  // is the live/current file). Mirrors the standalone history browser.
  const groupBySlot = (entries: HistoryEntry[]) => {
    const groups: Record<string, HistoryEntry[]> = {};
    entries.forEach((e) => {
      const slot = (e.slot != null && e.slot !== '') ? String(e.slot) : slotLabel(e);
      (groups[slot] = groups[slot] || []).push(e);
    });
    return Object.keys(groups).sort().map((slot) => ({
      slot,
      items: groups[slot].slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
    }));
  };

  const slotHeader = (slot: string, count: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '2px 0' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, whiteSpace: 'nowrap' }}>Slot: {slot}</span>
      <span style={{ flex: 1, height: '1px', background: V2.border }} />
      <span style={{ fontSize: '10px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>{count} version{count === 1 ? '' : 's'}</span>
    </div>
  );

  const currentChip = (
    <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '1px 7px', borderRadius: V2.radiusPill, background: 'rgba(74,222,128,0.18)', color: V2.success }}>Current</span>
  );

  if (loading) {
    return <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>Loading save data…</div>;
  }

  const total = saves.length + states.length;
  if (total === 0) {
    return <div style={{ color: V2.fgMuted, fontSize: '13px', padding: '24px 0', textAlign: 'center', fontStyle: 'italic' }}>
      No server saves or states for this game yet.
    </div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        @keyframes sdFade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .sd-fade { animation: sdFade 300ms ${EASE} both; animation-delay: calc(var(--sd-i, 0) * 26ms); }
        /* Row/tile hover is the shared .romm-row / .romm-tile (see V2_ROW_STYLE). */
        @keyframes sdShimmer { 0% { background-position: -150% 0; } 100% { background-position: 150% 0; } }
        .sd-shimmer { background-image: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%) !important; background-size: 200% 100% !important; background-repeat: no-repeat; animation: sdShimmer 1.1s linear infinite; }
      `}</style>

      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px' }}>
        {pill('saves', 'Saves', saves.length)}
        {pill('states', 'States', states.length)}
      </Focusable>

      {sub === 'saves' ? (
        saves.length === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>No saves for this game.</div>
        ) : (
          <Focusable noFocusRing style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {groupBySlot(saves).map((g) => (
              <div key={`sg-${g.slot}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {slotHeader(g.slot, g.items.length)}
                {g.items.map((e, idx) => {
                  const isCur = idx === 0;
                  const sub2 = [e.device || '', fmtHistSize(e.size_bytes)].filter(Boolean).join(' · ');
                  return (
                    <div key={`save-${e.id}`} className="sd-fade" style={{ '--sd-i': Math.min(idx, 14) } as any}>
                      <Focusable noFocusRing
                        className="romm-row"
                        onActivate={() => openRestore(e)}
                        onClick={() => openRestore(e)}
                        onFocus={() => setFocusedId(e.id)} onBlur={() => setFocusedId((c) => c === e.id ? null : c)}
                        onMouseEnter={() => setFocusedId(e.id)} onMouseLeave={() => setFocusedId((c) => c === e.id ? null : c)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', textAlign: 'left',
                          padding: '10px 13px', cursor: 'pointer', borderRadius: V2.radiusMd,
                          ...V2Focus.row(focusedId === e.id),
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{fmtHistTs(e.updated_at)}</span>
                            {isCur && currentChip}
                          </div>
                          {sub2 && <div style={{ fontSize: '11px', color: V2.fgMuted }}>{sub2}</div>}
                        </div>
                        <FaUndo size={13} style={{ color: V2.fgMuted, flexShrink: 0 }} />
                      </Focusable>
                    </div>
                  );
                })}
              </div>
            ))}
          </Focusable>
        )
      ) : (
        states.length === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>No states for this game.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {(() => {
              const pending = states.filter((s) => shots[s.id] === undefined || shots[s.id] === 'loading').length;
              if (pending === 0) return null;
              const loaded = states.length - pending;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: V2.fgMuted }}>
                  <FaSync size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>Loading previews {loaded}/{states.length}…</span>
                </div>
              );
            })()}
            {groupBySlot(states).map((g) => (
              <div key={`stg-${g.slot}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {slotHeader(g.slot, g.items.length)}
                <Focusable noFocusRing style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px' }}>
                  {g.items.map((e, idx) => {
                    const isCur = idx === 0;
                    const shot = shots[e.id];
                    const loadingShot = shot === undefined || shot === 'loading';
                    return (
                      <Focusable noFocusRing
                        key={`state-${e.id}`}
                        className="romm-tile sd-fade"
                        onActivate={() => openRestore(e)}
                        onClick={() => openRestore(e)}
                        onFocus={() => setFocusedId(e.id)} onBlur={() => setFocusedId((c) => c === e.id ? null : c)}
                        onMouseEnter={() => setFocusedId(e.id)} onMouseLeave={() => setFocusedId((c) => c === e.id ? null : c)}
                        style={{
                          display: 'flex', flexDirection: 'column', cursor: 'pointer', overflow: 'hidden',
                          borderRadius: V2.radiusLg,
                          '--sd-i': Math.min(idx, 14),
                          ...V2Focus.row(focusedId === e.id),
                        } as any}
                      >
                        <div className={loadingShot ? 'sd-shimmer' : ''} style={{ position: 'relative', aspectRatio: '16 / 9', backgroundColor: V2.coverPlaceholder, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                          {loadingShot ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', color: V2.fgMuted }}>
                              <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} />
                              <span style={{ fontSize: '10px' }}>Downloading…</span>
                            </div>
                          ) : shot ? (
                            <img src={shot} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          ) : (
                            <span style={{ fontSize: '10px', color: V2.fgMuted }}>No screenshot</span>
                          )}
                          {isCur && <div style={{ position: 'absolute', top: '6px', left: '6px' }}>{currentChip}</div>}
                        </div>
                        <div style={{ padding: '8px 10px' }}>
                          <div style={{ fontSize: '11px', color: V2.fg2 }}>{fmtHistTs(e.updated_at)}</div>
                        </div>
                      </Focusable>
                    );
                  })}
                </Focusable>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

export function GameDetailPage() {
  const game = getLibGameHolder();
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'download' | 'delete' | 'launch'>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState<boolean>(!!game?.is_downloaded);
  const [discs, setDiscs] = useState<LocalDisc[]>([]);
  const [discLast, setDiscLast] = useState<string>('');
  const [bgUri, setBgUri] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const dlProg = useDownloadProgress(game?.rom_id ?? -1, busy === 'download');
  const dlPct = dlProg?.percent ?? null;
  const extracting = dlProg?.state === 'extracting';
  const globalDownloading = useIsDownloading(game?.rom_id ?? -1);
  const downloading = busy === 'download' || globalDownloading;
  const smoothPct = useSmoothNumber(dlPct, downloading);
  // Nothing to launch into: Play dims rather than disappearing, and says why
  // when focused. Downloading stays available — building a library before you
  // own an emulator is legitimate.
  const saveActivity = useSaveActivityFor(game);
  const emu = useEmulatorStatus();
  // Per-game, not global: a Switch ROM is playable on a machine with only Eden,
  // and unplayable on one with only RetroArch — no core can run it either way.
  const gameStandalone = standaloneFor(emu, game?.platform, game?.platform_slug);
  // Removed from RomM but kept because it is on disk. The server has nothing to
  // serve for it, so anything that would re-fetch it is a guaranteed failure.
  const orphan = !!game?.is_orphan;
  const noEmulator = cannotLaunch(emu, game?.platform, game?.platform_slug);
  const [ctaFocused, setCtaFocused] = useState(false);
  // Land gamepad focus on the primary CTA (Play / Download) when the page
  // opens. As an internal view (LibraryRootPage) there is no route change, so
  // Steam gives us no focus pass — without this the generic view focus-pull
  // could park focus on the page's invisible root Focusable.
  const ctaRef = useAutoFocus(true, game?.rom_id);

  const load = async () => {
    if (!game) { setLoading(false); return; }
    setLoading(true);
    const rid = game.rom_id;
    try {
      const res = await getGameDetail(rid);
      if (res?.success) {
        setDetail(res);
        // get_game_detail reports is_downloaded from the in-memory games index,
        // which a just-finished download may not have reached yet (and which
        // holds nothing at all for a rom folded into a parent). Treat a
        // completed download in this session as the stronger evidence — it is
        // only ever cleared by an actual delete, via libCacheSetDownloaded.
        setIsDownloaded(!!res.is_downloaded || _dlSucceeded.has(rid));
        // Earned achievements are fetched separately so nothing blocks on the
        // extra /users/me round-trip; patch earned flags in once they arrive.
        if (res.ra_id && (res.achievements?.length)) {
          getRaEarned(res.ra_id).then((r: any) => {
            const earned = new Set<string>(r?.earned || []);
            if (!earned.size) return;
            setDetail((prev: any) => prev && prev.rom_id === rid ? {
              ...prev,
              achievements: prev.achievements.map((a: any) =>
                ({ ...a, earned: a.badge_id != null && earned.has(String(a.badge_id)) })),
            } : prev);
          }).catch(() => { });
        }
      }
    } catch (e) {
      console.error('get_game_detail failed', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // If a download for this game finishes on another surface (e.g. its cover
  // tile), refresh so the CTA flips Download → Play here too.
  const prevDownloading = useRef(false);
  useEffect(() => {
    if (prevDownloading.current && !downloading) {
      // Flip the CTA on the registry alone, before load() answers. The reload
      // is a round-trip to RomM and it can fail outright — a ROM download
      // finishing has just been hammering the same connection, and a reset
      // there returns success:false, which leaves the CTA saying Download for
      // a game that is on disk. The registry cannot fail and is the reason the
      // library tiles heal correctly today.
      if (game && _dlSucceeded.has(game.rom_id)) setIsDownloaded(true);
      load();
    }
    prevDownloading.current = downloading;
  }, [downloading]);

  // Resolve the on-disk disc files once the game is downloaded. A multi-disc
  // game exposes >1 entry (plus an .m3u); a single-disc game returns [].
  // `discReload` bumps after a disc launch so the remembered-disc checkmark and
  // the resume target stay current without leaving the page.
  const [discReload, setDiscReload] = useState(0);
  useEffect(() => {
    if (!game || !isDownloaded) { setDiscs([]); setDiscLast(''); return; }
    let alive = true;
    (async () => {
      try {
        const r = await getLocalDiscs(game.rom_id);
        if (alive) { setDiscs(r?.success ? (r.discs || []) : []); setDiscLast(r?.last || ''); }
      } catch { if (alive) { setDiscs([]); setDiscLast(''); } }
    })();
    return () => { alive = false; };
  }, [isDownloaded, game?.rom_id, discReload]);

  // A game is "multi-disc" for picker purposes when more than one bootable
  // disc exists (the .m3u playlist alone does not count as a choice).
  const pickableDiscs = discs.filter((d) => !d.is_m3u);
  const isMultiDisc = pickableDiscs.length > 1;

  const doDownload = async () => {
    if (!game) return;
    setBusy('download');
    _setDlActive(game.rom_id, true, detail?.name || game.name);
    try {
      await maybePromptSwitchFirmware(game.rom_id);
      const start = await downloadGame(game.rom_id);
      if (!start?.success) {
        toaster.toast({ title: 'Download failed', body: start?.message || 'Unknown error' });
        return;
      }
      const res = await awaitDownload(game.rom_id);
      if (res.ok) {
        toaster.toast({
          title: 'Downloaded', body: detail?.name || game.name,
          logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
          // Started from this page, but the toast outlives it — a click has to
          // bring the user back rather than do nothing.
          onClick: () => openGameById(game.rom_id, detail?.name || game.name, "/romm-sync-library"),
        });
        setIsDownloaded(true);
        // The same session registry the library tiles heal from. Without it
        // this page is the only surface that does not know the download
        // succeeded, so anything that re-reads state here — a remount with a
        // stale `game` prop, or the reload below — silently flips the CTA back
        // to Download while the library shows the game as present.
        _dlSucceeded.add(game.rom_id);
        libCacheSetDownloaded(game.rom_id, true);
      } else {
        toaster.toast({ title: 'Download failed', body: res.message || 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Download failed', body: String(e) });
    } finally {
      _setDlActive(game.rom_id, false);
      setBusy(null);
    }
  };

  const doLaunch = async (disc?: string | null, label?: string) => {
    if (!game) return;
    await runLaunch(game.rom_id, detail?.name || game.name, disc ?? null, label, setBusy);
    if (disc) setDiscReload((n) => n + 1);  // refresh remembered-disc marker
  };

  // Y / Options on the Play button: pick which disc to boot.
  const openDiscMenu = () => {
    if (game) openDiscPicker(game.rom_id, detail?.name || game.name, discs, discLast,
      setBusy, () => setDiscReload((n) => n + 1));
  };

  const doDelete = async () => {
    if (!game) return;
    setBusy('delete');
    try {
      const res = await deleteGame(game.rom_id);
      if (res?.success) {
        setIsDownloaded(false);
        libCacheSetDownloaded(game.rom_id, false);
      } else {
        toaster.toast({ title: 'Delete failed', body: res?.message || 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Delete failed', body: String(e) });
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  if (!game) {
    return v2Page(<div style={{ padding: '16px', color: V2.fgMuted }}>No game selected.</div>);
  }

  const name = detail?.name || game.name;
  const platform = detail?.platform || game.platform;
  const releaseDate = fmtReleaseDate(detail?.release_date);
  // RomM GameHeader meta row: platform-icon + platform · release date ·
  // verified — text items only (the tag chips render after as RTags).
  const meta: { text: string; color?: string }[] = [];
  if (platform) meta.push({ text: platform });
  if (releaseDate) meta.push({ text: releaseDate });

  // Header tag chips (RomM GameHeader): regions (info), languages (brand),
  // custom tags (neutral) — each an RTag.
  const headerTags: { text: string; tone: 'info' | 'brand' | 'neutral' }[] = [
    ...((detail?.regions || []) as string[]).map((r) => ({ text: r, tone: 'info' as const })),
    ...((detail?.languages || []) as string[]).map((l) => ({ text: l, tone: 'brand' as const })),
    ...((detail?.tags || []) as string[]).map((t) => ({ text: t, tone: 'neutral' as const })),
  ];

  // Overview "InfoGrid" sections — icon + label + chip items (RomM InfoGrid).
  const infoGrid: { label: string; items: string[]; icon?: any }[] = [];
  if (detail?.genres?.length) infoGrid.push({ label: 'Genres', items: detail.genres });
  if (detail?.companies?.length) infoGrid.push({ label: 'Companies', items: detail.companies });
  if (detail?.franchises?.length) infoGrid.push({ label: 'Franchises', items: detail.franchises });
  if (detail?.collections?.length) infoGrid.push({ label: 'Collections', items: detail.collections });

  const related = detail?.related || {};
  const hasRelated = ['expansions', 'dlcs', 'remakes', 'remasters']
    .some((k) => (related[k] || []).length);
  const ageRatings = detail?.age_ratings || [];
  const userCollections: string[] = detail?.user_collections || [];

  // Tab strip — Files only when the server reported files (RomM hides empty tabs).
  const tabList: { id: string; label: string }[] = [{ id: 'overview', label: 'Overview' }];
  if (detail?.files?.length) tabList.push({ id: 'files', label: 'Files' });
  if (detail?.screenshots?.length) tabList.push({ id: 'screenshots', label: 'Screenshots' });
  tabList.push({ id: 'save-data', label: 'Save Data' });
  if (detail?.achievements?.length) tabList.push({ id: 'achievements', label: 'Achievements' });
  tabList.push({ id: 'metadata', label: 'Metadata' });

  // L1 / R1 page through the detail tabs (RomM pages detail tabs with bumpers).
  // After a switch, land gamepad focus on the new tab's FIRST interactive
  // element (subtab pill, screenshot, filter, save row …) so the content is
  // immediately steerable — not back on the Play/Download CTA. The retry
  // ladder covers tabs whose content mounts async (Save Data fetches first);
  // a tab with nothing focusable (Overview's plain text) parks focus on the
  // CTA only if it died with the old tab's unmount, and each attempt bails
  // once focus is inside the content so the user is never fought.
  const tabContentRef = useRef<HTMLDivElement | null>(null);
  const tabFocusSeq = useRef(0);
  const cycleTab = (dir: -1 | 1) => {
    const i = tabList.findIndex((t) => t.id === tab);
    const ni = (i < 0 ? 0 : i + dir + tabList.length) % tabList.length;
    setTab(tabList[ni].id);
    const seq = ++tabFocusSeq.current;
    // The ladder stretches to ~3s because Save Data mounts its content only
    // after a fetch. Two guards keep it polite: it stops for good once focus
    // is inside the content, and it stops if the user has meanwhile driven
    // focus somewhere else themselves (any connected element that is neither
    // where focus was at switch time nor a spot we parked it on).
    const initial: any = _gpFocusEl();
    let parked: any = null;
    [60, 180, 400, 750, 1200, 2000, 3000].forEach((d) => setTimeout(() => {
      try {
        if (seq !== tabFocusSeq.current) return;      // superseded by a newer switch
        const host = tabContentRef.current;
        if (!host) return;
        const cur: any = _gpFocusEl();
        if (cur && cur.isConnected && host.contains(cur)) { tabFocusSeq.current++; return; }  // landed — done
        if (cur && cur.isConnected && cur !== initial && cur !== parked) { tabFocusSeq.current++; return; }  // user moved — don't fight
        // First LEAF focusable: containers (noFocusRing grids/lists) also carry
        // tabindex, but focusing them paints no highlight — skip to their first
        // real item.
        const nodes = Array.from(host.querySelectorAll('[tabindex]')) as HTMLElement[];
        const leaf = nodes.find((n) => !n.querySelector('[tabindex]'));
        if (leaf) { _forceGamepadFocus(leaf); return; }
        if ((!cur || !cur.isConnected) && ctaRef.current) { parked = ctaRef.current; _forceGamepadFocus(parked); }
      } catch { /* ignore */ }
    }, d));
  };
  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycleTab(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycleTab(1);
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
  };
  // Back returns to the page this game was opened from (collection/platform games
  // page or the library index). onCancelButton CONSUMES B so Steam's default
  // router-back doesn't also fire (which would land somewhere else entirely).
  const onBack = () => libBack(getLibGameOrigin());

  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown} onCancelButton={onBack} style={{ padding: '20px 16px' }}>
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '22px', alignItems: 'flex-start' }}>
        {/* Cover */}
        <div style={{ flex: '0 0 220px', maxWidth: '220px' }}>
          <div style={{ boxShadow: V2.elev2, borderRadius: V2.radiusLg, overflow: 'hidden' }}>
            <GameCover romId={game.rom_id} hasCover={game.has_cover || !!detail?.has_cover} large
              radius={V2.radiusLg} onLoaded={setBgUri} />
          </div>
        </div>

        {/* Info + actions */}
        <Focusable noFocusRing flow-children="vertical" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <div style={{ fontSize: '30px', fontWeight: 800, lineHeight: '1.15', letterSpacing: '-0.01em' }}>{name}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0', marginTop: '8px', fontSize: '13.5px', color: V2.fg2 }}>
              {/* Platform icon leads the meta row (RomM GameHeader). */}
              {game.platform_slug && (
                <span style={{ display: 'inline-flex', width: '16px', height: '16px', marginRight: '6px', alignItems: 'center', justifyContent: 'center' }}>
                  <PlatformIcon slug={game.platform_slug} size={16} />
                </span>
              )}
              {meta.map((m, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {i > 0 && <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>}
                  <span style={{ color: m.color || V2.fg2 }}>{m.text}</span>
                </span>
              ))}
              {/* Verified — icon-only check matching RomM GameHeader
                  (mdi-check-decagram seal); MdVerified is its react-icons twin. */}
              {detail?.verified && (
                <>
                  <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>
                  <MdVerified size={17} color={V2.success} />
                </>
              )}
              {/* Region / language / custom tag chips (RomM RTags). */}
              {headerTags.length > 0 && (
                <>
                  <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
                    {headerTags.map((tg, i) => {
                      const palette =
                        tg.tone === 'info' ? { c: '#93c5fd', b: 'rgba(147,197,253,0.14)', br: 'rgba(147,197,253,0.30)' }
                          : tg.tone === 'brand' ? { c: V2.brandHover, b: 'rgba(139,116,232,0.16)', br: 'rgba(139,116,232,0.30)' }
                            : { c: V2.fg2, b: V2.surface, br: V2.border };
                      return (
                        <span key={i} style={{
                          fontSize: '11px', fontWeight: 600, lineHeight: 1.6, padding: '1px 8px',
                          borderRadius: V2.radiusPill, color: palette.c,
                          background: palette.b, border: `1px solid ${palette.br}`,
                        }}>{tg.text}</span>
                      );
                    })}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Removed-from-RomM notice. Stated once, up front, rather than only
              at the delete step: it changes what the whole page means — no
              re-download, no save sync target, and this copy is the last one. */}
          {orphan && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '0 0 14px',
              padding: '8px 12px', borderRadius: V2.radiusMd,
              background: 'rgba(251,191,36,0.10)', border: `1px solid rgba(251,191,36,0.30)`,
              color: V2.warning, fontSize: '12px', lineHeight: 1.4, maxWidth: '560px',
            }}>
              <FaUnlink size={12} style={{ marginTop: '2px', flexShrink: 0 }} />
              <span>This game was removed from RomM. Your downloaded copy still plays, but
                it can't be downloaded again — keep a backup if you want to be sure of it.</span>
            </div>
          )}

          {/* Actions — RomM GameActions ribbon: an emphasized white pill for the
              primary CTA (Download when absent, Play when present) + circular
              surface icon buttons for the secondary actions (Delete). */}
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            {!isDownloaded ? (
              <GameActionButton variant="emphasized" focusRef={ctaRef} disabled={!!busy || downloading} onClick={doDownload}
                progress={downloading ? (dlPct ?? 0) : undefined}
                label={downloading
                  ? (extracting ? (dlPct != null ? `Extracting… ${padPct(dlPct)}%` : 'Extracting…')
                     : dlPct != null ? `Downloading… ${padPct(smoothPct)}%` : 'Downloading…')
                  : 'Download'}
                icon={downloading
                  ? (extracting ? <FaBoxOpen size={15} />
                     : <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />)
                  : <FaDownload size={15} />} />
            ) : !confirmDelete ? (
              <>
                <GameActionButton variant="emphasized" focusRef={ctaRef} disabled={!!busy || noEmulator}
                  onClick={() => doLaunch()}
                  onFocused={() => setCtaFocused(true)} onBlurred={() => setCtaFocused(false)}
                  onOptionsButton={isMultiDisc && !noEmulator ? openDiscMenu : undefined}
                  optionsHint={isMultiDisc && !noEmulator}
                  label={busy === 'launch' ? 'Launching…' : 'Play'}
                  icon={busy === 'launch'
                    ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaPlay size={14} style={{ marginLeft: '2px' }} />} />
                {noEmulator && ctaFocused && (
                  <span style={{ fontSize: '12px', color: V2.warning, maxWidth: '260px', lineHeight: 1.35 }}>
                    {gameStandalone
                      ? `${gameStandalone.name} is not installed — ${game?.platform || 'this platform'} needs it to play.`
                      : 'No emulator installed — install RetroArch from Home to play.'}
                  </span>
                )}
                <GameActionButton variant="surface" accent="danger" onClick={() => setConfirmDelete(true)}
                  icon={<FaTrash size={15} />} />
                {/* Sits beside Play rather than replacing it: a save going up
                    doesn't stop you launching again, and swapping the CTA out
                    from under a waiting thumb would. */}
                {saveActivity && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    fontSize: '12px', fontWeight: 600, color: V2.fgMuted,
                  }}>
                    <FaCloudUploadAlt size={13} style={{ color: V2.brandHover }} />
                    Uploading save…
                  </span>
                )}
              </>
            ) : (
              <>
                <GameActionButton variant="danger" disabled={!!busy} onClick={doDelete}
                  label={busy === 'delete' ? 'Deleting…' : orphan ? 'Delete for good' : 'Confirm delete'}
                  icon={busy === 'delete'
                    ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaTrash size={15} />} />
                <GameActionButton variant="surface" onClick={() => setConfirmDelete(false)}
                  icon={<FaTimes size={16} />} />
                {/* Deleting a normal game is undoable — it is still on RomM. For
                    an orphan this local copy is the last one, so the confirm
                    step has to say that rather than reading as routine. */}
                {orphan && (
                  <span style={{ fontSize: '12px', color: V2.warning, maxWidth: '260px', lineHeight: 1.35 }}>
                    This game is no longer on RomM — deleting it here cannot be undone.
                  </span>
                )}
              </>
            )}
            {/* Live transfer readout — speed · ETA, shown beside the button only
                while a download is in flight (kept off the cover tiles by design). */}
            {downloading && dlProg && (dlProg.speed > 0 || dlProg.eta > 0) && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: V2.fg2,
                animation: 'dlValIn 0.35s ease'
              }}>
                <span style={{ opacity: 0.3 }}>·</span>
                {dlProg.speed > 0 && <span>{formatSpeed(dlProg.speed)}</span>}
                {dlProg.speed > 0 && formatEta(dlProg.eta) && <span style={{ opacity: 0.3 }}>·</span>}
                {formatEta(dlProg.eta) && <span>{formatEta(dlProg.eta)} left</span>}
              </span>
            )}
          </Focusable>

          {/* Tabbed panel (RomM GameDetails: RTabNav + tab content). L1/R1 page tabs. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}><V2TabNav tabs={tabList} active={tab} onTab={setTab} /></div>
            <Bumper label="L1" />
            <Bumper label="R1" />
          </div>
          <div ref={tabContentRef} style={{ paddingTop: '14px' }}>
            {loading ? (
              <div style={{ color: V2.fgMuted, fontSize: '12px' }}>Loading details…</div>
            ) : tab === 'overview' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
                {/* 1. Summary */}
                {detail?.summary && (
                  <div style={{ fontSize: '13.5px', color: V2.fg2, lineHeight: '1.7' }}>{detail.summary}</div>
                )}

                {/* 2. Left-labelled fact rows — Last played · Players · Age rating
                    (RomM OverviewTab __facts). */}
                {(() => {
                  const lp = detail?.last_played ? new Date(detail.last_played) : null;
                  const lpStr = lp && !isNaN(lp.getTime()) ? lp.toLocaleString() : null;
                  const rows: { label: string; field: any }[] = [];
                  if (lpStr) rows.push({ label: 'Last played', field: <span style={{ fontSize: '13px', color: V2.fg2 }}>{lpStr}</span> });
                  if (detail?.player_count) rows.push({ label: 'Players', field: <PlayerCountBadge value={String(detail.player_count)} /> });
                  if (ageRatings.length) rows.push({ label: 'Age rating', field: <AgeRatingBadges items={ageRatings} /> });
                  if (userCollections.length) rows.push({
                    label: 'Collections',
                    field: (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {userCollections.map((c, i) => (
                          <span key={i} style={{
                            display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
                            background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
                            fontSize: '11.5px', fontWeight: 600, color: V2.fg2,
                          }}><FaBookmark size={10} color={V2.brand} />{c}</span>
                        ))}
                      </div>
                    ),
                  });
                  if (!rows.length) return null;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      {rows.map((r) => (
                        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ width: '120px', flexShrink: 0, fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: V2.fgFaint }}>{r.label}</div>
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>{r.field}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* 3. Info grid */}
                <InfoGrid sections={infoGrid} />

                {/* 4. HLTB */}
                {detail?.hltb && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SectionHeading icon={<FaClock size={12} />}>How long to beat</SectionHeading>
                    <HLTBStrip hltb={detail.hltb} />
                  </div>
                )}

                {/* 5. Related games — one labelled section per category. */}
                {hasRelated && (
                  <>
                    <RelatedSection icon={<FaPuzzlePiece size={12} />} title="Expansions" items={related.expansions} />
                    <RelatedSection icon={<FaBoxOpen size={12} />} title="DLC" items={related.dlcs} />
                    <RelatedSection icon={<FaRedo size={12} />} title="Remakes" items={related.remakes} />
                    <RelatedSection icon={<FaClone size={12} />} title="Remasters" items={related.remasters} />
                  </>
                )}

                {!detail?.summary && infoGrid.length === 0 && !hasRelated && !detail?.hltb && !ageRatings.length && (
                  <div style={{ color: V2.fgMuted, fontSize: '12px' }}>No metadata available.</div>
                )}
              </div>
            ) : tab === 'files' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {/* Discs — bootable entries on disk (downloaded multi-disc games).
                    Each row launches that disc; the playlist row boots all discs
                    with in-game swapping. */}
                {isMultiDisc && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SectionHeading icon={<FaLayerGroup size={12} />}>Discs</SectionHeading>
                    {discs.some((d) => d.is_m3u) && (
                      <V2SettingsRow icon={<FaLayerGroup size={14} />}
                        title="All discs" subtitle="In-game disc swapping"
                        onClick={() => doLaunch(null, 'All discs')}
                        right={<FaPlay size={12} style={{ color: V2.fgMuted }} />} />
                    )}
                    {pickableDiscs.map((d) => (
                      <V2SettingsRow key={d.name} icon={<FaClone size={14} />}
                        title={discDisplayLabel(d.name)} subtitle={d.name}
                        onClick={() => doLaunch(d.name, discDisplayLabel(d.name))}
                        right={<FaPlay size={12} style={{ color: V2.fgMuted }} />} />
                    ))}
                  </div>
                )}
                {/* Switch patches and DLC. Above the file list because they are
                    the actionable half: the list says what exists, this says
                    what Eden will actually apply. Renders nothing off Switch. */}
                <SwitchAddOnsSection romId={game.rom_id} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {isMultiDisc && <SectionHeading icon={<FaBoxOpen size={12} />}>Files</SectionHeading>}
                  <FilesTab detail={detail} />
                </div>
              </div>
            ) : tab === 'screenshots' ? (
              <ScreenshotGrid paths={detail?.screenshots || []} />
            ) : tab === 'save-data' ? (
              <SaveDataTab romId={game.rom_id} />
            ) : tab === 'metadata' ? (
              <MetadataTab detail={detail} />
            ) : (
              <AchievementsTab achievements={detail?.achievements || []} />
            )}
          </div>
        </Focusable>
      </Focusable>
    </Focusable>,
    bgUri,
  );
}
