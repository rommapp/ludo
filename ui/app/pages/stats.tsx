import { V2, fmtBytes } from "../theme";
import { Focusable } from "@ludo/host";
import { GameActionButton, PlatformIcon, V2SearchField, V2Segment, V2StatsSectionBox } from "../kit";
import { useEffect, useRef, useState } from "react";
import { getPluginStats } from "../rpc";
import { _forceGamepadFocus } from "../shell";
import { FaBookmark, FaBoxOpen, FaCheckCircle, FaChevronLeft, FaDownload, FaGamepad, FaHome, FaInfoCircle, FaLayerGroup } from "react-icons/fa";
import { v2Page } from "../focus";
import { libBack } from "../nav";
// Stats — a port of RomM's own ServerStats view.
//
// A summary card grid over a per-platform table, where each row's progress bar
// doubles as its divider. Scope is this device: what is on disk here, not what
// the server holds.

// SummaryStatsSection card: leading icon + big tabular number + uppercase label.
export function V2StatCard({ icon, value, label }: { icon: any; value: string; label: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px',
      padding: '16px', background: V2.surface, border: `1px solid ${V2.border}`,
      borderRadius: V2.radiusLg, color: V2.fgMuted,
    }}>
      <div style={{ color: V2.brandHover }}>{icon}</div>
      <div style={{
        fontSize: '28px', fontWeight: 800, lineHeight: 1.1, color: V2.fg,
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      <div style={{
        fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: V2.fgMuted,
      }}>{label}</div>
    </div>
  );
}

export type PlatStat = { slug: string; fs_slug?: string; name: string; rom_count: number; downloaded: number; fs_size_bytes: number };

// PlatformsStatsSection row: icon · name + meta · size + pct · progress bar
// (spans full width, doubles as the divider; hidden on the last row).
export function PlatformStatRow({ p, total }: { p: PlatStat; total: number }) {
  const pct = total > 0 ? (p.fs_size_bytes / total) * 100 : 0;
  // Same system as the achievements list: a shared .romm-row (CSS drives the
  // focus/hover highlight via :focus-within) plus an empty onActivate so the
  // row registers as a gamepad nav target. No JS focus state or inline border —
  // that's what left a stray border on blur.
  return (
    <Focusable noFocusRing onActivate={() => { }} className="romm-row" style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', columnGap: '14px', rowGap: '12px',
      alignItems: 'center', padding: '12px 14px', borderRadius: V2.radiusMd,
    }}>
      <div style={{
        flexShrink: 0, width: '32px', height: '32px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: V2.fg2,
      }}><PlatformIcon slug={p.slug} fsSlug={p.fs_slug} size={32} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: V2.fg }}>{p.name}</div>
        <div style={{
          marginTop: '4px', display: 'flex', flexWrap: 'wrap', alignItems: 'center',
          gap: '6px', fontSize: '12px', color: V2.fgMuted,
        }}>
          <span style={{ fontWeight: 500, color: V2.fg2 }}>{p.rom_count} game{p.rom_count === 1 ? '' : 's'}</span>
          <span style={{ color: V2.fgFaint }}>·</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 6px',
            borderRadius: V2.radiusSm, background: V2.surface, border: `1px solid ${V2.border}`,
            fontSize: '11px', fontWeight: 500, color: V2.fg2,
          }}>{p.downloaded} downloaded</span>
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: V2.brand, fontVariantNumeric: 'tabular-nums' }}>
          {fmtBytes(p.fs_size_bytes) || '0 B'}
        </div>
        <div style={{ fontSize: '11px', color: V2.fgFaint }}>{pct.toFixed(1)}%</div>
      </div>
      <div style={{ gridColumn: '1 / -1', height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: V2.brand }} />
      </div>
    </Focusable>
  );
}

export function StatsPage() {
  const [stats, setStats] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'size' | 'count'>('size');
  // Without an explicit mount focus, gamepad focus never enters the page, so
  // nothing (search, sort, the rows) can be reached and it can't scroll. Focus a
  // concrete child (the search field) — focusing the container itself doesn't
  // descend to a child here — and let spatial navigation handle the rest.
  const searchRef = useRef<any>(null);
  useEffect(() => {
    (async () => {
      try { setStats(await getPluginStats()); } catch { setStats({}); }
    })();
  }, []);
  useEffect(() => {
    if (stats == null) return;
    const t = setTimeout(() => { try { if (searchRef.current) _forceGamepadFocus(searchRef.current); } catch { } }, 80);
    return () => clearTimeout(t);
  }, [stats]);

  const s = stats || {};
  const cards = [
    { icon: <FaGamepad size={22} />, value: (s.platforms ?? 0).toLocaleString(), label: 'Platforms' },
    { icon: <FaLayerGroup size={22} />, value: (s.games_total ?? 0).toLocaleString(), label: 'Library games' },
    { icon: <FaDownload size={22} />, value: (s.games_downloaded ?? 0).toLocaleString(), label: 'Downloaded' },
    { icon: <FaHome size={22} />, value: fmtBytes(s.size_on_disk) || '0 B', label: 'Size on disk' },
    { icon: <FaBookmark size={22} />, value: (s.collections_total ?? 0).toLocaleString(), label: 'Collections' },
    { icon: <FaCheckCircle size={22} />, value: (s.collections_synced ?? 0).toLocaleString(), label: 'Synced' },
  ];

  const plats: PlatStat[] = (s.platforms_breakdown || []);
  const total = Number(s.size_on_disk || 0);
  const q = query.trim().toLowerCase();
  const filtered = plats
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : sort === 'count' ? b.rom_count - a.rom_count
          : b.fs_size_bytes - a.fs_size_bytes);

  const sortItems: { id: 'name' | 'size' | 'count'; label: string }[] = [
    { id: 'name', label: 'Name' }, { id: 'size', label: 'Size' }, { id: 'count', label: 'Games' },
  ];

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 80px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Stats</div>
      </div>

      {/* Section stack */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Summary */}
        <V2StatsSectionBox title="Summary" icon={<FaInfoCircle size={14} />}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', padding: '16px',
          }}>
            {cards.map((c) => <V2StatCard key={c.label} {...c} />)}
          </div>
        </V2StatsSectionBox>

        {/* Platforms breakdown — flush, no card chrome (matches RomM). */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ flex: '0 1 360px', minWidth: 0 }}>
              <V2SearchField ref={searchRef} value={query} onChange={setQuery} />
            </div>
            {/* Same segmented pill control as the update channel / setup switch. */}
            <div style={{ marginLeft: 'auto' }}>
              <V2Segment options={sortItems} value={sort} onChange={(v) => setSort(v as any)} />
            </div>
          </Focusable>

          <Focusable noFocusRing flow-children="vertical" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filtered.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                padding: '24px', color: V2.fgMuted, fontSize: '13px',
              }}>
                <FaBoxOpen size={22} /><span>{q ? 'No matching platforms' : 'No platforms'}</span>
              </div>
            ) : filtered.map((p) => (
              <PlatformStatRow key={p.slug} p={p} total={total} />
            ))}
          </Focusable>
        </section>
      </div>
    </Focusable>,
  );
}
