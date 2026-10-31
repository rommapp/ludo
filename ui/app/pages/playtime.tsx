import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { _forceGamepadFocus } from "../shell";
import { Focusable, GamepadButton } from "@ludo/host";
import { FaCalendarAlt, FaChevronLeft, FaChevronRight, FaCloudDownloadAlt, FaCloudUploadAlt, FaGamepad, FaLayerGroup, FaTrophy } from "react-icons/fa";
import { V2Focus, v2Page } from "../focus";
import { libBack } from "../nav";
import { GameActionButton, V2CardRow, V2Switch, useRowHighlight } from "../kit";
import { DEVICE_COLORS, V2, fmtPlayTime } from "../theme";
import { GameCover } from "../media";
import { getPlayTime, playTimeDeleteGame, playTimeRefresh, playTimeSyncIfDue, playTimeUpload, setRecapAuto } from "../rpc";
import { openGameById } from "../libcache";
import { toaster } from "../toast";
import { _libRefreshListeners } from "../events";
import { MonthlyRecap, clearReturnToRecap, recapBumper, takeReturnToRecap } from "./recap";

// Play time — Settings ▸ Play time. Every figure comes from one list of
// sessions (this device's, plus the other devices' pulled from RomM), computed
// by the engine's play_stats, so the page agrees with the game pages. The
// sections and their wording follow Argosy's Play Time screen; the layout uses
// the width a TV or desktop has, where Argosy stacks for a phone.

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PLATFORM_COLORS = ['#ef4444', '#22c55e', '#eab308', '#38bdf8', '#f472b6', '#a78bfa'];
const OTHERS = 'rgba(255,255,255,0.3)';

const card: React.CSSProperties = {
  background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusCard,
};

function hourLabel(h: number) {
  return new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ago(ts: number | null | undefined) {
  if (!ts) return 'Never';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  const d = new Date(ts * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + `, ${time}`;
}

function shortDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function Section({ title, children, style }: { title: string; children: any; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: V2.fgMuted, padding: '0 2px', margin: '24px 0 8px',
      }}>{title}</div>
      {children}
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: any; sub?: any }) {
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 600, color: V2.fgMuted }}>{label}</div>
      <div style={{ fontSize: '17px', fontWeight: 800, color: V2.fg, marginTop: '3px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: V2.fgMuted }}>{sub}</div>}
    </div>
  );
}

// ── Activity: summary facts beside a month calendar ─────────────────────────
function Calendar({ days }: { days: Record<string, [number, number]> }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const todayKey = new Date().toLocaleDateString('sv');   // YYYY-MM-DD, local
  const max = useMemo(() => Math.max(1, ...Object.values(days).map((v) => v[0])), [days]);
  const lead = (month.getDay() + 6) % 7;   // Monday first
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: any[] = DAY_NAMES.map((d) => (
    <div key={d} style={{ fontSize: '10px', color: V2.fgMuted, textAlign: 'center' }}>{d}</div>
  ));
  for (let i = 0; i < lead; i++) cells.push(<div key={`l${i}`} />);
  for (let day = 1; day <= count; day++) {
    const key = new Date(month.getFullYear(), month.getMonth(), day).toLocaleDateString('sv');
    const [ms, n] = days[key] || [0, 0];
    const level = ms ? 0.25 + 0.75 * Math.min(1, ms / max) : 0;
    cells.push(
      <div key={key} title={ms ? `${fmtPlayTime(ms)} · ${n}x` : 'Nothing played'} style={{
        height: '38px', borderRadius: '7px', padding: '4px 6px',
        background: ms ? `rgba(139,116,232,${level})` : 'rgba(255,255,255,0.04)',
        boxShadow: key === todayKey ? `inset 0 0 0 1.5px ${V2.brand}` : 'none',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: '10.5px', fontWeight: 700, color: level > 0.6 ? V2.fg : key === todayKey ? V2.brand : V2.fg2 }}>{day}</span>
        {n > 0 && <span style={{ fontSize: '9.5px', color: V2.fg2, textAlign: 'right' }}>{n}x</span>}
      </div>
    );
  }
  const shift = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  const isCurrent = month.getFullYear() === new Date().getFullYear() && month.getMonth() === new Date().getMonth();
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <Focusable flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <GameActionButton icon={<FaChevronLeft size={11} />} onClick={() => shift(-1)} />
        <span style={{ flex: 1, textAlign: 'center', fontSize: '13px', fontWeight: 700 }}>
          {month.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </span>
        <GameActionButton icon={<FaChevronRight size={11} />} onClick={() => shift(1)} disabled={isCurrent} />
      </Focusable>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>{cells}</div>
    </div>
  );
}

// ── When you play: played time across the week's 168 hours ─────────────────
// Each day starts at its own boundary with hour ticks under it, evenings are
// shaded, and a time scale sits on the left. The peak is labelled; hovering
// with the mouse moves the label (no pad focus: it would be a trap to cross).
const shortHour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const WAVE_STEPS = [15, 30, 60, 120, 300, 600, 1200, 3000].map((m) => m * 60000);

function Waveform({ wave }: { wave: number[] }) {
  const W = 1100, H = 120, L = 58, T = 40, B = 36;
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...wave);
  // Smoothed over three hours, so a single long session reads as a hill.
  const smooth = wave.map((_, i) => (wave[(i + 167) % 168] + 2 * wave[i] + wave[(i + 1) % 168]) / 4);
  const smax = Math.max(1, ...smooth);
  const step = WAVE_STEPS.find((s) => smax / s <= 4) ?? WAVE_STEPS[WAVE_STEPS.length - 1];
  const top = Math.ceil(smax / step) * step;
  const y = (v: number) => H - (v / top) * H;
  const pts = smooth.map((v, i) => [i / 167 * W, y(v)]);
  const path = 'M' + pts.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(' L');
  const peak = wave.indexOf(max);
  const at = hover ?? peak;
  const [px, py] = pts[at];
  const tip = `${DAY_NAMES[Math.floor(at / 24)]} ${shortHour(at % 24)} · ${fmtPlayTime(wave[at])}`;
  const tipW = tip.length * 6.4 + 20;
  const tipX = Math.min(Math.max(px - tipW / 2, -L + 4), W - tipW);
  const dw = W / 7;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * (W + L + 4) - L;
    setHover(x < 0 || x > W ? null : Math.round(x / W * 167));
  };
  return (
    <div style={{ ...card, padding: '14px 18px 10px' }}>
      <div style={{ display: 'flex', fontSize: '12px', color: V2.fgMuted, marginBottom: '6px' }}>
        <span>Played time by hour of the week</span>
        <span style={{ marginLeft: 'auto', color: V2.brandHover, fontWeight: 700 }}>
          Peak {DAY_NAMES[Math.floor(peak / 24)]} {hourLabel(peak % 24)}
        </span>
      </div>
      <svg width="100%" viewBox={`${-L} ${-T} ${W + L + 4} ${H + T + B}`} style={{ display: 'block' }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="ptWave" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={V2.brand} stopOpacity="0.55" />
            <stop offset="1" stopColor={V2.brand} stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: Math.round(top / step) }, (_, k) => (k + 1) * step).map((v) => (
          <g key={v}>
            <line x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
            <text x={-8} y={y(v) + 4} fill={V2.fgMuted} fontSize="10" textAnchor="end">{fmtPlayTime(v)}</text>
          </g>
        ))}
        {DAY_NAMES.map((d, i) => {
          const x0 = i * dw;
          return (
            <g key={d}>
              <rect x={x0 + dw * 18 / 24} y={0} width={dw * 6 / 24} height={H} fill="rgba(161,143,255,0.07)" />
              <line x1={x0} x2={x0} y1={-6} y2={H + 30} stroke="rgba(255,255,255,0.12)" />
              <text x={x0 + 5} y={H + 30} fill={V2.fg2} fontSize="11.5" fontWeight="700">{d}</text>
              {[6, 12, 18].map((h) => (
                <g key={h}>
                  <line x1={x0 + dw * h / 24} x2={x0 + dw * h / 24} y1={H} y2={H + 4} stroke={V2.fgMuted} />
                  <text x={x0 + dw * h / 24} y={H + 15} fill={V2.fgMuted} fontSize="9.5" textAnchor="middle">{shortHour(h)}</text>
                </g>
              ))}
            </g>
          );
        })}
        <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#ptWave)" />
        <path d={path} fill="none" stroke={V2.brandHover} strokeWidth="2" />
        {hover != null && <line x1={px} x2={px} y1={py} y2={H} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />}
        <circle cx={px} cy={py} r="4.5" fill={V2.fg} />
        <rect x={tipX} y={py - 32} width={tipW} height={20} rx={6} fill="#1d1a2b" stroke="rgba(255,255,255,0.15)" />
        <text x={tipX + tipW / 2} y={py - 18} fill={V2.fg} fontSize="11" fontWeight="700" textAnchor="middle">{tip}</text>
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: V2.fgMuted, marginTop: '2px' }}>
        <span style={{ width: '14px', height: '10px', borderRadius: '2px', background: 'rgba(161,143,255,0.18)' }} />
        Evenings, 6 PM – midnight
      </div>
    </div>
  );
}

// ── Platforms / Devices: a share band and a drill-in row ────────────────────
function Band({ parts }: { parts: Array<{ name: string; share: number; color: string }> }) {
  return (
    <div style={{ padding: '14px 16px 12px' }}>
      <div style={{ display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', gap: '2px' }}>
        {parts.map((p) => <div key={p.name} style={{ flex: Math.max(p.share, 0.004), background: p.color }} />)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: '10px' }}>
        {parts.map((p) => (
          <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: V2.fg2 }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: p.color }} />
            {p.name}<span style={{ color: V2.fgMuted }}>{Math.round(p.share * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function topWithOthers(rows: any[], n: number, colors: string[], othersLabel: string) {
  const head = rows.slice(0, n).map((r, i) => ({ name: r.name, share: r.share, color: colors[r.rank ?? i] || OTHERS }));
  const rest = rows.slice(n);
  if (rest.length) head.push({ name: othersLabel, share: rest.reduce((a, r) => a + r.share, 0), color: OTHERS });
  return head;
}

// Side-by-side band cards keep one height when a legend wraps; the drill-in
// row stays at the bottom.
const bandCard: React.CSSProperties = { ...card, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' };

const chevron = <FaChevronRight size={12} style={{ color: V2.fgFaint }} />;

// ── What you play: covers sized by time played ──────────────────────────────
// Slice-and-dice layout: the biggest game takes a full-height column sized by
// its share, the next ones split what is left in columns of two.
function Mosaic({ games }: { games: any[] }) {
  const top = games.slice(0, 7);
  const rest = games.slice(7);
  const total = games.reduce((a, g) => a + g.ms, 0) || 1;
  const others = rest.reduce((a, g) => a + g.ms, 0);
  type Tile = { g?: any; ms: number };
  const tiles: Tile[] = top.map((g) => ({ g, ms: g.ms }));
  if (others > 0) tiles.push({ ms: others });
  const cols: Tile[][] = [];
  if (tiles.length) cols.push([tiles[0]]);
  for (let i = 1; i < tiles.length; i += 2) cols.push(tiles.slice(i, i + 2));
  return (
    <div style={{ display: 'flex', gap: '4px', height: '240px', padding: '14px 16px 8px' }}>
      {cols.map((col, ci) => {
        const colMs = col.reduce((a, t) => a + t.ms, 0);
        return (
          <div key={ci} style={{ flex: Math.max(colMs / total, 0.06), display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
            {col.map((t, ti) => (
              <div key={ti} style={{
                flex: t.ms / colMs, position: 'relative', borderRadius: V2.radiusArt, overflow: 'hidden',
                background: t.g ? V2.coverPlaceholder : 'rgba(255,255,255,0.08)',
              }}>
                {t.g ? (
                  <>
                    <div style={{ position: 'absolute', inset: 0 }}><GameCover romId={t.g.rom_id} hasCover large radius="0" /></div>
                    <span style={{
                      position: 'absolute', left: '7px', bottom: '5px', fontSize: '11px', fontWeight: 800,
                      color: V2.fg, textShadow: '0 1px 3px #000',
                    }}>{fmtPlayTime(t.g.ms).split(' ')[0]}</span>
                  </>
                ) : (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: V2.fgMuted }}>Others</div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Drill-in lists ──────────────────────────────────────────────────────────
function ShareBar({ share, color }: { share: number; color: string }) {
  return (
    <div style={{ height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', marginTop: '6px' }}>
      <div style={{ height: '100%', width: `${Math.max(1, share * 100)}%`, borderRadius: '3px', background: color }} />
    </div>
  );
}

// After a delete the row is gone; focus lands on the row that took its place
// rather than falling back to the page's first button.
let _focusRowAfterDelete: number | null = null;

function GameRow({ g, index, first, last, maxMs, onDeleted }: { g: any; index: number; first: boolean; last: boolean; maxMs: number; onDeleted: () => void }) {
  const { active, highlightHandlers } = useRowHighlight();
  const [armed, setArmed] = useState(false);
  const name = g.name || 'Unknown game';
  const open = () => { _returnToList = 'games'; openGameById(g.rom_id, name, '/romm-sync-playtime'); };
  const del = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    const r = await playTimeDeleteGame(g.rom_id).catch(() => null);
    if (r?.success) {
      _focusRowAfterDelete = index;
      toaster.toast({ title: 'Play records deleted', body: name });
      onDeleted();
    }
  };
  const end = `calc(${V2.radiusCard} - 1px)`;
  return (
    <Focusable noFocusRing
      onActivate={open}
      onClick={open}
      onOptionsButton={del}
      onOptionsActionDescription={armed ? 'Confirm delete' : 'Delete play records'}
      {...highlightHandlers}
      onBlur={(e: any) => { setArmed(false); (highlightHandlers as any).onBlur?.(e); }}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '10px 14px', cursor: 'pointer',
        borderTop: first ? 'none' : `1px solid ${V2.border}`,
        borderTopLeftRadius: first ? end : 0, borderTopRightRadius: first ? end : 0,
        borderBottomLeftRadius: last ? end : 0, borderBottomRightRadius: last ? end : 0,
        background: active ? V2.surfaceHover : 'transparent',
        boxShadow: active ? `inset 0 0 0 2px ${armed ? V2.danger : V2.brand}` : 'none',
        transition: 'background 0.15s, box-shadow 0.15s',
      }}>
      <div style={{ width: '32px', height: '43px', flexShrink: 0, borderRadius: V2.radiusSm, overflow: 'hidden' }}>
        <GameCover romId={g.rom_id} hasCover radius={V2.radiusSm} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
        <div style={{ fontSize: '12px', color: armed ? V2.danger : V2.fgMuted }}>
          {armed
            ? 'All play history for this game is removed from this device. Press again to delete.'
            : `${g.platform || 'Unknown platform'} · ${g.sessions} ${g.sessions === 1 ? 'session' : 'sessions'} · Last played ${new Date(g.last * 1000).toLocaleDateString()}`}
        </div>
        <ShareBar share={g.ms / maxMs} color={V2.brand} />
      </div>
      <div style={{ fontSize: '14px', fontWeight: 700, width: '80px', textAlign: 'right' }}>{fmtPlayTime(g.ms)}</div>
    </Focusable>
  );
}

function ListView({ kind, data, onDeleted }: { kind: 'platforms' | 'devices' | 'games'; data: any; onDeleted: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (_focusRowAfterDelete == null || !listRef.current) return;
    const rows = listRef.current.children;
    const el = rows[Math.min(_focusRowAfterDelete, rows.length - 1)];
    _focusRowAfterDelete = null;
    if (el) _forceGamepadFocus(el);
  }, [data]);
  if (kind === 'games') {
    const games = data.games || [];
    const max = games[0]?.ms || 1;
    return (
      <div ref={listRef} style={card}>
        {games.map((g: any, i: number) => (
          <GameRow key={g.rom_id} g={g} index={i} first={i === 0} last={i === games.length - 1} maxMs={max} onDeleted={onDeleted} />
        ))}
      </div>
    );
  }
  const rows = kind === 'platforms' ? data.platforms : data.devices;
  const colors = kind === 'platforms' ? PLATFORM_COLORS : DEVICE_COLORS;
  return (
    <div style={card}>
      {rows.map((r: any, i: number) => (
        <V2CardRow key={r.name + i} focusable divider={i > 0} first={i === 0} last={i === rows.length - 1}
          icon={kind === 'platforms' ? <FaLayerGroup size={14} /> : <FaGamepad size={14} />}
          title={r.name}
          subtitle={<>
            {kind === 'platforms' ? `${r.games} ${r.games === 1 ? 'game' : 'games'} · ` : ''}{Math.round(r.share * 100)}%
            <ShareBar share={r.share} color={colors[r.rank ?? i] || OTHERS} />
          </>}
          right={<span style={{ fontSize: '14px', fontWeight: 700 }}>{fmtPlayTime(r.ms)}</span>} />
      ))}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
// The list a game was opened from, so Back from that game lands on the list
// again rather than on the overview (the page remounts in between).
let _returnToList: null | 'platforms' | 'devices' | 'games' = null;

// Where focus was in each view (main page, a list, the recap), as an index into
// the page's focusables, so Back lands on the row you left rather than the top.
// Module-level so it survives the trip to a game page and back.
const _viewFocus: Record<string, number> = {};
const FOCUSABLES = '.desk-focusable[tabindex="0"]';
// The last reply, so coming back from a game page draws the page at once
// (and lands focus) instead of flashing "Reading sessions…" at the top first.
let _lastData: any = null;

// The Last month card opens that month's recap.
function LastMonthCard({ onOpen, children }: { onOpen: () => void; children: any }) {
  // Same highlight as the other rows: lit by focus or by the mouse.
  const { active, highlightHandlers } = useRowHighlight();
  return (
    <Focusable noFocusRing onActivate={onOpen} onClick={onOpen} {...highlightHandlers} style={{
        ...card, flex: 1, padding: '16px 18px', display: 'flex', flexDirection: 'column', cursor: 'pointer',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease', ...V2Focus.row(active),
        background: `linear-gradient(135deg, rgba(139,116,232,0.32), rgba(56,189,248,0.10))`,
        // Lit, the ring alone draws the edge: a brand border inside it renders
        // brighter than the shadowed ring and reads as a light line.
        borderColor: active ? 'transparent' : V2.border,
        // Lay the gradient out from the border box, or it repeats into the
        // border strip and shows its far, darker end as a line.
        backgroundOrigin: 'border-box',
      }}>
      {children}
    </Focusable>
  );
}

export function PlayTimePage() {
  const [data, setDataState] = useState<any>(() => _lastData);
  const setData = (d: any) => { _lastData = d; setDataState(d); };
  const [list, setListState] = useState<null | 'platforms' | 'devices' | 'games'>(() => {
    const l = _returnToList; _returnToList = null; return l;
  });
  const setList = (l: null | 'platforms' | 'devices' | 'games') => {
    if (l) delete _viewFocus[l];   // a list opened afresh starts at the top
    setListState(l);
  };
  const [navSlot, setNavSlot] = useState<HTMLDivElement | null>(null);
  const [recap, setRecap] = useState<string | null>(() => takeReturnToRecap());
  const openRecap = (m: string) => { delete _viewFocus.recap; setRecap(m); };
  const rootRef = useRef<HTMLDivElement>(null);
  const view = recap ? 'recap' : list || 'main';
  const remember = () => {
    const root = rootRef.current;
    const el = document.activeElement;
    if (!root || !el || !root.contains(el)) return;
    const i = [...root.querySelectorAll(FOCUSABLES)].indexOf(el);
    if (i >= 0) _viewFocus[view] = i;
  };
  // Before paint, so the view never shows a frame at the top first.
  useLayoutEffect(() => {
    const i = _viewFocus[view];
    if (i == null || !data || !rootRef.current) return;
    const el = rootRef.current.querySelectorAll(FOCUSABLES)[i] as HTMLElement | undefined;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    _forceGamepadFocus(el);
  }, [view, !!data]);
  const [busy, setBusy] = useState<null | 'upload' | 'refresh'>(null);
  const load = () => getPlayTime().then((r) => { if (r?.success) setData(r); }).catch(() => { });
  useEffect(() => {
    load();
    // Pull the other devices' latest when the last pull is old; redraw if
    // anything came in.
    playTimeSyncIfDue(4).then((r) => { if (r?.pulled) load(); }).catch(() => { });
    _libRefreshListeners.add(load);
    return () => { _libRefreshListeners.delete(load); };
  }, []);

  const back = () => (recap ? (clearReturnToRecap(), setRecap(null)) : list ? setList(null) : libBack('/romm-sync-settings'));
  const title = recap ? 'Monthly recap' : list === 'platforms' ? 'By platform' : list === 'devices' ? 'By device'
    : list === 'games' ? 'Top games' : 'Play time';

  const act = async (which: 'upload' | 'refresh') => {
    if (busy) return;
    setBusy(which);
    const r = await (which === 'upload' ? playTimeUpload() : playTimeRefresh()).catch(() => null);
    setBusy(null);
    if (!r) return;
    if (!r.success) toaster.toast({ title: 'Play time', body: r.message });
    else if (which === 'upload') toaster.toast({ title: 'Play time', body: `Sent ${r.sent}, ${r.duplicates} already on RomM, ${r.failed} refused` });
    else toaster.toast({ title: 'Play time', body: `${r.added} ${r.added === 1 ? 'session' : 'sessions'} from ${r.devices} ${r.devices === 1 ? 'device' : 'devices'}` });
    load();
  };

  const s = data?.summary;
  const f = data?.facts;
  const rm = data?.romm;
  const bh = s?.busiest_hour;
  const lm = data?.last_month;

  const body = !data ? (
    <div style={{ color: V2.fgMuted, fontSize: '13px', padding: '40px 2px' }}>Reading sessions…</div>
  ) : recap ? (
    <MonthlyRecap month={recap} onMonth={setRecap} navSlot={navSlot} />
  ) : list ? (
    <ListView kind={list} data={data} onDeleted={load} />
  ) : !data.has_data ? (
    <div style={{ ...card, padding: '28px', marginTop: '8px' }}>
      <div style={{ fontSize: '16px', fontWeight: 700 }}>No play sessions yet</div>
      <div style={{ fontSize: '13px', color: V2.fgMuted, marginTop: '6px', maxWidth: '560px', lineHeight: 1.5 }}>
        Play a game and your patterns will build up here. Refresh from RomM to include sessions from your other devices.
      </div>
    </div>
  ) : (
    <>
      <Section title="Activity">
        <div style={{ ...card, padding: '16px 18px', display: 'flex', gap: '28px' }}>
          <div style={{ width: '260px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 14px', alignContent: 'start' }}>
            <Fact label="Played" value={fmtPlayTime(s.total_ms)} sub={`Across ${s.window_days} ${s.window_days === 1 ? 'day' : 'days'}`} />
            <Fact label="Platforms" value={s.platforms} />
            <Fact label="Busiest hour" value={bh ? `${DAY_NAMES[bh.weekday]} ${hourLabel(bh.hour)}` : '—'} />
            <Fact label="Most played on" value={s.most_played_on || '—'} />
            <Fact label="Current streak" value={`${s.current_streak} ${s.current_streak === 1 ? 'day' : 'days'}`} />
            <Fact label="Longest streak" value={`${s.longest_streak} ${s.longest_streak === 1 ? 'day' : 'days'}`}
              sub={s.longest_streak_range && s.longest_streak > 1 ? `${shortDate(s.longest_streak_range[0])} – ${shortDate(s.longest_streak_range[1])}` : undefined} />
          </div>
          <Calendar days={data.calendar} />
        </div>
      </Section>

      <Section title="When you play">
        <Waveform wave={data.wave} />
      </Section>

      <div style={{ display: 'flex', gap: '14px' }}>
        <Section title="Platforms" style={{ flex: 1 }}>
          <div style={bandCard}>
            <Band parts={topWithOthers(data.platforms, 3, PLATFORM_COLORS, 'Other platforms')} />
            <V2CardRow divider last icon={<FaLayerGroup size={14} />} title="By platform"
              subtitle={`${data.platforms.length} ${data.platforms.length === 1 ? 'platform' : 'platforms'}`}
              onClick={() => setList('platforms')} right={chevron} />
          </div>
        </Section>
        <Section title="Devices" style={{ flex: 1 }}>
          <div style={bandCard}>
            <Band parts={topWithOthers(data.devices, 4, DEVICE_COLORS, 'Other devices')} />
            <V2CardRow divider last icon={<FaGamepad size={14} />} title="By device"
              subtitle={`${data.devices.length} ${data.devices.length === 1 ? 'device' : 'devices'}`}
              onClick={() => setList('devices')} right={chevron} />
          </div>
        </Section>
      </div>

      <Section title="What you play">
        <div style={card}>
          <Mosaic games={data.games} />
          <V2CardRow divider last icon={<FaTrophy size={14} />} title="Top games"
            subtitle={`${data.games.length} ${data.games.length === 1 ? 'game' : 'games'}`}
            onClick={() => setList('games')} right={chevron} />
        </div>
      </Section>

      <div style={{ display: 'flex', gap: '14px' }}>
        <Section title="Quick facts" style={{ flex: 1.6 }}>
          <div style={card}>
            {([
              ['Average session', fmtPlayTime(f.average_ms)],
              ['Longest session', fmtPlayTime(f.longest_ms)],
              ['Sessions', String(f.sessions)],
              ['Days played', `${f.days_played} of ${f.days_window}`],
              ['Per day played', fmtPlayTime(f.per_day_ms)],
              ['Busiest day', f.busiest_day ? `${shortDate(f.busiest_day.date)} · ${fmtPlayTime(f.busiest_day.ms)}` : 'None yet'],
            ] as [string, string][]).map(([k, v], i) => (
              <div key={k} style={{ display: 'flex', padding: '11px 16px', borderTop: i ? `1px solid ${V2.border}` : 'none' }}>
                <span style={{ fontSize: '13px', color: V2.fg2 }}>{k}</span>
                <span style={{ marginLeft: 'auto', fontSize: '13px', fontWeight: 700 }}>{v}</span>
              </div>
            ))}
          </div>
        </Section>
        <Section title="Last month" style={{ flex: 1 }}>
          <LastMonthCard onOpen={() => openRecap(lm.month.slice(0, 7))}>
            <div style={{ fontSize: '15px', fontWeight: 800 }}>
              {new Date(lm.month + 'T00:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </div>
            <div style={{ fontSize: '12px', color: V2.fg2, marginTop: '4px' }}>
              {lm.sessions ? `${fmtPlayTime(lm.total_ms)} over ${lm.sessions} ${lm.sessions === 1 ? 'session' : 'sessions'}` : 'Nothing played'}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: 'auto', paddingTop: '14px' }}>
              {lm.top.map((id: number) => (
                <div key={id} style={{ width: '46px', height: '62px', borderRadius: V2.radiusSm, overflow: 'hidden' }}>
                  <GameCover romId={id} hasCover radius={V2.radiusSm} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: V2.fg2, marginTop: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              See the recap {chevron}
            </div>
          </LastMonthCard>
        </Section>
      </div>

      <Section title="Monthly recap">
        <div style={card}>
          <V2CardRow first last icon={<FaCalendarAlt size={14} />} title="Show last month's recap on Home"
            subtitle="Once a month, the first time Home opens"
            onClick={() => {
              const on = !data.recap_auto;
              setData({ ...data, recap_auto: on });
              setRecapAuto(on).catch(() => { });
            }}
            right={<V2Switch checked={!!data.recap_auto} />} />
        </div>
      </Section>

      <Section title="RomM">
        <div style={{ ...card, display: 'flex', padding: '2px 16px' }}>
          {[
            [['Sessions on RomM', '', String(rm.on_server)],
             ['Ready to upload', 'Sent on the next upload', String(rm.pending), rm.pending ? V2.warning : undefined],
             ['Unlinked', 'No matching RomM game to attach them to', String(rm.unlinked), V2.fgMuted]],
            [['Last upload', '', ago(rm.last_upload)],
             ['From other devices', '', String(rm.from_other_devices)],
             ['Last refresh', '', ago(rm.last_refresh)]],
          ].map((col, ci) => (
            <div key={ci} style={{ flex: 1, paddingLeft: ci ? '20px' : 0, paddingRight: ci ? 0 : '20px' }}>
              {col.map(([t, sub, v, color], i) => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', minHeight: '46px', borderTop: i ? `1px solid ${V2.border}` : 'none' }}>
                  <div>
                    <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{t}</div>
                    {sub && <div style={{ fontSize: '11.5px', color: V2.fgMuted }}>{sub}</div>}
                  </div>
                  <span style={{ marginLeft: 'auto', fontSize: '13.5px', fontWeight: 700, color: color || V2.fg }}>{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <Focusable flow-children="horizontal" style={{ display: 'flex', gap: '12px', marginTop: '10px' }}>
          <div style={{ ...card, flex: 1 }}>
            <V2CardRow first last icon={<FaCloudUploadAlt size={15} />}
              title={busy === 'upload' ? 'Uploading…' : 'Upload now'}
              subtitle={data.online ? 'Send local sessions to RomM' : 'Connect to RomM to upload'}
              onClick={data.online ? () => act('upload') : undefined} />
          </div>
          <div style={{ ...card, flex: 1 }}>
            <V2CardRow first last icon={<FaCloudDownloadAlt size={15} />}
              title={busy === 'refresh' ? 'Refreshing…' : 'Refresh from RomM'}
              subtitle={data.online ? 'Pull sessions from your other devices' : 'Connect to RomM to refresh'}
              onClick={data.online ? () => act('refresh') : undefined} />
          </div>
        </Focusable>
      </Section>
      <div style={{ height: '30px' }} />
    </>
  );

  return v2Page(
    <Focusable noFocusRing ref={rootRef} onFocus={remember} onCancelButton={back} onButtonDown={(evt: any) => {
      // In the recap LB/RB change month, not the library's tab.
      const b = evt?.detail?.button;
      if (!recap || (b !== GamepadButton.BUMPER_LEFT && b !== GamepadButton.BUMPER_RIGHT)) return;
      evt.stopPropagation?.();
      recapBumper(b === GamepadButton.BUMPER_LEFT ? -1 : 1);
    }}
      style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={back} />
        {!recap && <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>{title}</div>}
        {/* The recap's month carousel takes the title's place, centred on the
            page: the spacer after it mirrors the Back button, as the library
            header's spacer mirrors its count. */}
        <div ref={setNavSlot} style={{ flex: recap ? 1 : undefined, minWidth: 0, height: '46px', display: recap ? 'flex' : 'none' }} />
        {recap && <div style={{ width: '46px', flexShrink: 0 }} />}
      </div>
      {body}
    </Focusable>
  );
}
