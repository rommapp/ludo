import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Focusable, GamepadButton, ModalRoot } from "@ludo/host";
import { FaTrophy } from "react-icons/fa";
import { V2Focus, V2_FOCUS_STYLE } from "../focus";
import { _forceGamepadFocus } from "../shell";
import { Bumper, MODAL_SCRIM_INSET, V2Button } from "../kit";
import { V2, fmtPlayTime } from "../theme";
import { GameCover } from "../media";
import { getMonthlyRecap, playTimeSyncIfDue } from "../rpc";
import { openGameById } from "../libcache";

// Monthly recap — Play time ▸ Last month. Argosy's recap card
// (ui/components/recap/MonthlyRecapCard.kt) at a TV's width: the month's
// play time with its most played game, the session facts beside a calendar of
// the month, the top games with their share, and the RetroAchievements
// unlocked and games mastered or completed in it. The figures come from the
// engine's play_stats.month_recap.

// The month the recap shows, kept while a game opened from it is on screen so
// Back returns to the same month.
export let _returnToRecap: string | null = null;
export let _recapBumper: ((dir: number) => void) | null = null;
export function recapBumper(dir: number) { _recapBumper?.(dir); }
export function openRecapNext(m: string) { _returnToRecap = m; }
// Read without clearing: the page can mount twice. Cleared once the recap closes.
export function takeReturnToRecap() { return _returnToRecap; }
export function clearReturnToRecap() { _returnToRecap = null; }

const TOP_COLORS = ['#8b74e8', '#38bdf8', '#f59e0b'];
const OTHERS = 'rgba(255,255,255,0.3)';
const AWARD = {
  mastered: { label: 'Mastered', color: '#fbbf24' },
  completed: { label: 'Completed', color: '#cbd5e1' },
} as Record<string, { label: string; color: string }>;

const card: React.CSSProperties = {
  background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusCard,
};

function monthName(m: string, year = true) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString([], year ? { month: 'long', year: 'numeric' } : { month: 'long' });
}

function Heading({ title, trailing }: { title: string; trailing?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', margin: '24px 2px 8px' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgMuted }}>{title}</span>
      <span style={{ flex: 1, height: '1px', background: V2.border, alignSelf: 'center' }} />
      {trailing && <span style={{ fontSize: '12px', color: V2.fgMuted }}>{trailing}</span>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 600, color: V2.fgMuted }}>{label}</div>
      <div style={{ fontSize: '17px', fontWeight: 800, marginTop: '3px' }}>{value}</div>
    </div>
  );
}

// The month as a grid of days, shaded by time played; the busiest is ringed.
function MonthGrid({ month, days, busiest }: { month: string; days: number[]; busiest: number | null }) {
  const [y, mo] = month.split('-').map(Number);
  const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7;
  const max = Math.max(1, ...days);
  const cells: any[] = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
    <div key={`h${i}`} style={{ fontSize: '10px', color: V2.fgMuted, textAlign: 'center' }}>{d}</div>
  ));
  for (let i = 0; i < lead; i++) cells.push(<div key={`l${i}`} />);
  days.forEach((ms, i) => {
    const level = ms ? 0.25 + 0.75 * Math.min(1, ms / max) : 0;
    cells.push(
      <div key={i} title={ms ? fmtPlayTime(ms) : 'Nothing played'} style={{
        height: '32px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '10.5px', fontWeight: 700, color: level > 0.6 ? V2.fg : ms ? V2.fg2 : V2.fgFaint,
        background: ms ? `rgba(139,116,232,${level})` : 'rgba(255,255,255,0.04)',
        outline: busiest === i + 1 ? `2px solid ${V2.warning}` : 'none', outlineOffset: '-2px',
      }}>{i + 1}</div>
    );
  });
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 44px)', gap: '4px' }}>{cells}</div>;
}

function TopGameRow({ g, color, month, first, last, onOpenGame }: { g: any; color: string; month: string; first: boolean; last: boolean; onOpenGame?: (romId: number, name: string) => void }) {
  const [focused, setFocused] = useState(false);
  const name = g.name || 'Unknown game';
  const open = () => {
    if (onOpenGame) { onOpenGame(g.rom_id, name); return; }
    _returnToRecap = month; openGameById(g.rom_id, name, '/romm-sync-playtime');
  };
  return (
    <Focusable noFocusRing onActivate={open} onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '10px 16px', cursor: 'pointer',
        borderRadius: first ? `${V2.radiusCard} ${V2.radiusCard} 0 0` : last ? `0 0 ${V2.radiusCard} ${V2.radiusCard}` : 0,
        transition: 'background 0.15s ease, box-shadow 0.15s ease', ...V2Focus.row(focused),
        // Longhands after the focus style: it sets borderColor only while
        // focused, and dropping it on blur left the shorthand's white default.
        borderStyle: 'solid', borderWidth: '1px', borderColor: 'transparent',
        borderTopColor: focused || first ? 'transparent' : V2.border,
      }}>
      <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: color, flexShrink: 0 }} />
      <div style={{ width: '36px', height: '48px', borderRadius: V2.radiusSm, overflow: 'hidden', flexShrink: 0 }}>
        <GameCover romId={g.rom_id} hasCover radius={V2.radiusSm} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          {g.new && <span style={{
            fontSize: '10px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
            padding: '2px 6px', borderRadius: V2.radiusChip, background: 'rgba(74,222,128,0.16)', color: V2.success,
          }}>New</span>}
        </div>
        <div style={{ fontSize: '12px', color: V2.fgMuted, marginTop: '2px' }}>
          {[g.platform, `${g.sessions} ${g.sessions === 1 ? 'session' : 'sessions'}`].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: '14px', fontWeight: 800 }}>{fmtPlayTime(g.ms)}</div>
        <div style={{ fontSize: '12px', color: V2.fgMuted }}>{Math.round(g.share * 100)}%</div>
      </div>
    </Focusable>
  );
}

function Badge({ u, selected, onFocus }: { u: any; selected: boolean; onFocus: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable noFocusRing onActivate={onFocus} onClick={onFocus}
      onFocus={() => { setFocused(true); onFocus(); }} onBlur={() => setFocused(false)} style={{
        width: '52px', height: '52px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0, cursor: 'pointer',
        background: V2.coverPlaceholder, border: `2px solid ${selected ? V2.brand : 'transparent'}`,
        transition: 'transform 0.15s ease, box-shadow 0.15s ease', ...V2Focus.tile(focused),
      }}>
      <img src={u.badge_url} alt={u.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
    </Focusable>
  );
}

function Achievements({ r }: { r: any }) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [r.month]);
  const u = r.unlocks[Math.min(sel, r.unlocks.length - 1)];
  const when = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'long' })
    + ', ' + new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div style={{ ...card, padding: '16px 18px' }}>
      {u && (
        <>
          <Focusable flow-children="horizontal" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {r.unlocks.map((x: any, i: number) => (
              <Badge key={`${x.ra_game_id}:${x.badge_id}`} u={x} selected={i === sel} onFocus={() => setSel(i)} />
            ))}
          </Focusable>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginTop: '14px', padding: '12px 14px', borderRadius: V2.radiusLg, background: V2.bgElevated }}>
            <img src={u.badge_url} alt="" style={{ width: '64px', height: '64px', borderRadius: '8px' }}
              onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '15px', fontWeight: 800 }}>{u.title || 'Achievement'}</div>
              {u.description && <div style={{ fontSize: '12.5px', color: V2.fg2, marginTop: '3px', lineHeight: 1.4 }}>{u.description}</div>}
              <div style={{ fontSize: '12px', color: V2.fgMuted, marginTop: '5px' }}>
                {[u.game, when(u.at)].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {u.points > 0 && <div style={{ fontSize: '15px', fontWeight: 800 }}>{u.points} pts</div>}
              <div style={{ fontSize: '12px', color: V2.fgMuted }}>{sel + 1} of {r.unlocks.length}</div>
            </div>
          </div>
        </>
      )}
      {r.awards.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: u ? '14px' : 0 }}>
          {r.awards.map((a: any) => {
            const k = AWARD[a.kind];
            return (
              <span key={`${a.kind}:${a.ra_game_id}`} style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 12px', fontSize: '12.5px',
                borderRadius: V2.radiusPill, border: `1px solid ${k.color}55`, background: `${k.color}1f`,
              }}>
                <FaTrophy size={11} style={{ color: k.color }} />
                <span style={{ fontWeight: 800, color: k.color }}>{k.label}</span>
                <span style={{ color: V2.fg2 }}>{a.game || 'A game'}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The months with play or unlocks, oldest on the left, the shown one centred
// and large: the library's platform / collection carousel (pages/library.tsx,
// the sliding-track header), with the same measurements, fade and keycaps.
function MonthCarousel({ months, month, onMonth }: { months: string[]; month: string; onMonth: (m: string) => void }) {
  const selRef = useRef<HTMLDivElement | null>(null);
  const [selW, setSelW] = useState(0);
  const [hov, setHov] = useState<string | null>(null);
  const DOTGAP = 16;
  useLayoutEffect(() => {
    const el = selRef.current;
    if (el) setSelW(el.offsetLeft + el.offsetWidth / 2);
  }, [month, months.length]);
  const canPage = months.length > 1;
  const slot: React.CSSProperties = { flexShrink: 0, padding: '0 4px', zIndex: 2, display: 'flex', alignItems: 'center' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', flex: 1, minWidth: 0 }}>
      {canPage && <div style={slot}><Bumper label="L1" /></div>}
      <div style={{
        position: 'relative', overflow: 'hidden', height: '100%', flex: 1,
        maskImage: 'linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: '50%', height: '100%', display: 'flex', alignItems: 'center',
          transform: `translateX(${-selW}px)`, transition: 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
        }}>
          {months.map((m, idx) => {
            const sel = m === month;
            return [
              idx > 0 && (
                <span key={`dot-${m}`} style={{ flexShrink: 0, padding: `0 ${DOTGAP}px`, color: V2.fgMuted, opacity: 0.5, fontSize: '13px' }}>·</span>
              ),
              // Not a focus stop: the d-pad stays on the page, LB/RB (Q/E)
              // change month, and a click picks one.
              <div key={m} ref={sel ? selRef : undefined} onClick={() => onMonth(m)}
                onMouseEnter={() => setHov(m)} onMouseLeave={() => setHov((k) => (k === m ? null : k))}
                style={{
                  flexShrink: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: sel ? 'default' : 'pointer', boxSizing: 'border-box',
                  fontSize: sel ? '22px' : '14px', fontWeight: sel ? 800 : 500, letterSpacing: sel ? '-0.01em' : '0',
                  color: sel || hov === m ? V2.fg : V2.fgMuted,
                  opacity: sel ? 1 : (hov === m ? 0.95 : 0.5),
                  whiteSpace: 'nowrap', transition: 'opacity 0.32s, color 0.32s',
                }}>
                <span style={{
                  padding: '4px 10px', borderRadius: V2.radiusPill,
                  background: !sel && hov === m ? 'rgba(255,255,255,0.10)' : 'transparent',
                  transition: 'background 0.15s ease',
                }}>{monthName(m)}</span>
              </div>,
            ];
          })}
        </div>
      </div>
      {canPage && <div style={slot}><Bumper label="R1" /></div>}
    </div>
  );
}

// Recaps already built, by month. Switching shows the cached one at once, and the
// months either side are fetched ahead, so LB/RB never flashes a loading state.
const _recaps = new Map<string, any>();
const fetchRecap = (m: string) => getMonthlyRecap(m).then((x) => {
  if (x?.success) _recaps.set(m, x);
  return x?.success ? x : null;
});

export function MonthlyRecap({ month, onMonth, navSlot, onOpenGame }: {
  month: string; onMonth: (m: string) => void; navSlot: HTMLElement | null;
  // Opening a game from the recap; the Play time page's default returns to it.
  onOpenGame?: (romId: number, name: string) => void;
}) {
  // Until the new month arrives the previous one stays up, rather than a
  // loading line for a frame or two.
  const [r, setR] = useState<any>(() => _recaps.get(month) ?? null);
  const [pulled, setPulled] = useState(0);
  // Which way the content slides in: from the side the carousel moved toward.
  const lastShown = useRef<string | null>(null);
  const slide = useRef(0);
  if (r && r.month !== lastShown.current) {
    slide.current = lastShown.current == null ? 0 : r.month < lastShown.current ? -1 : 1;
    lastShown.current = r.month;
  }
  // Animated in place rather than remounted by key, so focus on a badge or a
  // game row survives the switch.
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!slide.current || !bodyRef.current?.animate) return;
    bodyRef.current.animate(
      [{ opacity: 0, transform: `translateX(${slide.current * 28}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }, [r?.month]);
  useEffect(() => {
    let alive = true;
    const hit = _recaps.get(month);
    if (hit) setR(hit);
    fetchRecap(month).then((x) => {
      if (!alive || !x) return;
      setR(x);
      // Warm the neighbours LB/RB would go to.
      const o = x.months.find((m: string) => m < month);
      const n = [...x.months].reverse().find((m: string) => m > month);
      for (const m of [o, n]) if (m && !_recaps.has(m)) fetchRecap(m).catch(() => { });
    }).catch(() => { });
    return () => { alive = false; };
  }, [month, pulled]);
  // Like Argosy, bring in the other devices' latest play first when the last
  // pull is old; the recap shows at once and redraws if anything came in.
  useEffect(() => {
    playTimeSyncIfDue(4).then((x) => { if (x?.pulled) setPulled((n) => n + 1); }).catch(() => { });
  }, []);

  // The arrows step between months that have play or unlocks, skipping
  // the empty ones between them.
  // The month the recap opened on stays in the strip until you leave, even an
  // empty one (last month, opened from the card), so it can be stepped back to.
  const [opened] = useState(month);
  const strip: string[] = r ? [...new Set([...r.months, opened, month])].sort() : [];
  const older = [...strip].reverse().find((m) => m < month);
  const newer = strip.find((m) => m > month);
  // LB/RB step months too, like the library's tabs. The Play time page's
  // root routes them here (focus may rest on the root itself).
  useEffect(() => {
    _recapBumper = (dir) => { const to = dir < 0 ? older : newer; if (to) onMonth(to); };
    return () => { _recapBumper = null; };
  });
  const nav = r && <MonthCarousel months={strip} month={month} onMonth={onMonth} />;
  if (!r) {
    return <div style={{ color: V2.fgMuted, fontSize: '13px', padding: '40px 2px' }}>Putting {monthName(month, false)} together…</div>;
  }
  // What's on screen: the month that has arrived, which can trail `month` by a fetch.
  const shown = r.month;
  const top = r.top_games[0];
  const empty = !r.sessions && !r.unlocks.length && !r.awards.length;
  const masteries = r.awards.filter((a: any) => a.kind === 'mastered').length;
  const trailing = [
    `${r.unlocks.length} unlocked`,
    r.points ? `${r.points} points` : '',
    masteries ? `${masteries} ${masteries === 1 ? 'mastery' : 'masteries'}` : '',
  ].filter(Boolean).join(' · ');
  const bandParts = [
    ...r.top_games.slice(0, 3).map((g: any, i: number) => ({ key: g.rom_id, share: g.share, color: TOP_COLORS[i] })),
    ...(r.top_games.length > 3 ? [{ key: 'others', share: r.top_games.slice(3).reduce((a: number, g: any) => a + g.share, 0) + (r.total_ms ? r.other_ms / r.total_ms : 0), color: OTHERS }] : []),
  ];

  return (
    <>
      {nav && navSlot && createPortal(nav, navSlot)}
      <div ref={bodyRef}>
      {empty ? (
        <div style={{ ...card, padding: '28px', marginTop: '14px' }}>
          <div style={{ fontSize: '16px', fontWeight: 700 }}>Nothing played in {monthName(shown, false)}</div>
          <div style={{ fontSize: '13px', color: V2.fgMuted, marginTop: '6px' }}>Play time and achievements from that month show up here.</div>
        </div>
      ) : (
        <>
          {r.sessions > 0 && (
            <div style={{
              ...card, marginTop: '14px', padding: '20px 22px', display: 'flex', gap: '28px', alignItems: 'flex-start',
              background: 'linear-gradient(135deg, rgba(139,116,232,0.32), rgba(56,189,248,0.10))',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: '18px', alignItems: 'center' }}>
                  {top && (
                    <div style={{ width: '96px', height: '128px', borderRadius: V2.radiusMd, overflow: 'hidden', flexShrink: 0, boxShadow: V2.elev2 }}>
                      <GameCover romId={top.rom_id} hasCover large radius={V2.radiusMd} />
                    </div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '40px', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.05 }}>{fmtPlayTime(r.total_ms)}</div>
                    <div style={{ fontSize: '13px', color: V2.fg2, marginTop: '4px' }}>played in {monthName(shown, false)}</div>
                    {top && (
                      <div style={{ fontSize: '13px', marginTop: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span style={{ color: V2.fgMuted }}>Most played </span>
                        <span style={{ fontWeight: 700 }}>{top.name || 'Unknown game'}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '32px', marginTop: '22px' }}>
                  <Stat label="Sessions" value={String(r.sessions)} />
                  <Stat label="Days played" value={`${r.days_played} of ${r.days.length}`} />
                  <Stat label="Longest session" value={fmtPlayTime(r.longest_ms)} />
                </div>
              </div>
              <div>
                <MonthGrid month={shown} days={r.days} busiest={r.busiest_day?.day ?? null} />
                {r.busiest_day && (
                  <div style={{ fontSize: '12px', color: V2.fg2, marginTop: '8px' }}>
                    Busiest day: {new Date(Number(shown.slice(0, 4)), Number(shown.slice(5)) - 1, r.busiest_day.day)
                      .toLocaleDateString([], { day: 'numeric', month: 'short' })} · {fmtPlayTime(r.busiest_day.ms)}
                  </div>
                )}
              </div>
            </div>
          )}

          {r.top_games.length > 0 && (
            <>
              <Heading title="Top games" trailing={r.other_games ? `+ ${r.other_games} other ${r.other_games === 1 ? 'game' : 'games'} · ${fmtPlayTime(r.other_ms)}` : undefined} />
              <div style={card}>
                <div style={{ display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', gap: '2px', margin: '14px 16px 6px' }}>
                  {bandParts.map((p: any) => <div key={p.key} style={{ flex: Math.max(p.share, 0.004), background: p.color }} />)}
                </div>
                <Focusable flow-children="vertical">
                  {r.top_games.map((g: any, i: number) => (
                    <TopGameRow key={g.rom_id} g={g} month={shown} onOpenGame={onOpenGame} color={TOP_COLORS[i] || OTHERS}
                      first={i === 0} last={i === r.top_games.length - 1} />
                  ))}
                </Focusable>
              </div>
            </>
          )}

          {(r.unlocks.length > 0 || r.awards.length > 0) && (
            <>
              <Heading title="Achievements" trailing={trailing} />
              <Achievements r={r} />
            </>
          )}
        </>
      )}
      </div>
      <div style={{ height: '30px' }} />
    </>
  );
}

// The recap over Home: Home opens it by itself once a month for last month
// (Argosy's MonthlyRecapOverlay), and Done or Back closes it. The months
// carousel and LB/RB work as on the Play time page.
export function RecapModal({ month: first, closeModal }: { month: string; closeModal?: () => void }) {
  const [month, setMonth] = useState(first);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  const close = () => closeModal?.();
  return (
    <ModalRoot bHideCloseIcon onCancel={close} onEscKeypress={close}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={close}
        onButtonDown={(e: any) => {
          const b = e?.detail?.button;
          if (b === GamepadButton.BUMPER_LEFT || b === GamepadButton.BUMPER_RIGHT) {
            e.stopPropagation?.();
            recapBumper(b === GamepadButton.BUMPER_LEFT ? -1 : 1);
          }
        }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.55)',
          WebkitBackdropFilter: 'blur(10px)', backdropFilter: 'blur(10px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes recapIn { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={close} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing ref={panelRef} style={{
          position: 'relative', width: 'min(1160px, 94vw)', maxHeight: '88vh', overflowY: 'auto', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '16px 22px 4px',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.82) 0%, rgba(10,10,18,0.9) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: '1px solid rgba(255,255,255,0.12)', borderRadius: V2.radiusCard,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          animation: 'recapIn 0.22s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '88px', flexShrink: 0, fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgMuted }}>
              Your month
            </div>
            <div ref={setSlot} style={{ flex: 1, minWidth: 0, height: '46px', display: 'flex' }} />
            <div style={{ width: '88px', flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
              <V2Button variant="primary" onClick={close}>Done</V2Button>
            </div>
          </div>
          <MonthlyRecap month={month} onMonth={setMonth} navSlot={slot}
            onOpenGame={(id, name) => { close(); openGameById(id, name, '/romm-sync-library'); }} />
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}
