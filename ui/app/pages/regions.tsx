import { useEffect, useRef, useState } from "react";
import { Focusable } from "@ludo/host";
import { FaChevronLeft, FaGlobe, FaGripLines } from "react-icons/fa";
import { v2Page } from "../focus";
import { GameActionButton, ScrollFade, V2CardRow, V2SettingsSection, V2Switch } from "../kit";
import { libBack } from "../nav";
import { _broadcastLibRefresh } from "../events";
import { getRegionOrder, rebuildLibrary, setRegionOrder } from "../rpc";
import { _forceGamepadFocus } from "../shell";
import { V2 } from "../theme";
import { toaster } from "../toast";

// Settings ▸ Region order: which version a game opens with when it has several.
// RomM's priority is one list per server, so this device can keep its own.

const FLAGS: Record<string, string> = {
  Australia: 'AU', Brazil: 'BR', Canada: 'CA', China: 'CN', England: 'GB', Europe: 'EU',
  Finland: 'FI', France: 'FR', Germany: 'DE', Greece: 'GR', Holland: 'NL', 'Hong Kong': 'HK',
  Italy: 'IT', Japan: 'JP', Korea: 'KR', Norway: 'NO', Russia: 'RU', Spain: 'ES', Sweden: 'SE',
  Taiwan: 'TW', USA: 'US', Bulgaria: 'BG', Chile: 'CL', 'Czech Republic': 'CZ', Denmark: 'DK',
  Hungary: 'HU', Israel: 'IL', Kuwait: 'KW', 'New Zealand': 'NZ', Peru: 'PE', Poland: 'PL',
  Portugal: 'PT', Slovakia: 'SK', Turkey: 'TR',
};
const flag = (name: string) => {
  const code = FLAGS[name];
  return code ? String.fromCodePoint(...[...code].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🌐';
};

function moved(list: string[], name: string, to: number) {
  const out = list.filter((n) => n !== name);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, name);
  return out;
}

export function RegionsPage() {
  const [loaded, setLoaded] = useState<any>(null);
  const [follow, setFollow] = useState(true);
  const [order, setOrder] = useState<string[]>([]);
  const [held, setHeld] = useState<string | null>(null);
  const beforeLift = useRef<string[]>([]);
  const dragEndedAt = useRef(0);
  const rows = useRef<Record<string, HTMLElement | null>>({});
  const latest = useRef({ follow, order, loaded });
  latest.current = { follow, order, loaded };

  useEffect(() => {
    getRegionOrder().then((r: any) => {
      if (!r?.success) return;
      setLoaded(r); setFollow(r.follow); setOrder(r.order);
    }).catch(() => { });
    // Saved on the way out rather than per move: a new order means re-reading
    // the library, and rearranging four regions shouldn't start that four times.
    return () => {
      const { follow: f, order: o, loaded: l } = latest.current;
      if (!l || (f === l.follow && (f || o.join() === l.order.join()))) return;
      setRegionOrder(f ? [] : o)
        .then(() => rebuildLibrary())
        .then(() => {
          toaster.toast({ title: 'Region order saved', body: 'Updating your library from RomM.' });
          _broadcastLibRefresh();
        })
        .catch((e: any) => toaster.toast({ title: 'Region order not saved', body: String(e?.message ?? e) }));
    };
  }, []);

  // While a region is lifted the pad's normal focus walk is the move: landing on
  // a neighbour swaps with it, and focus goes straight back to the lifted row.
  const landedOn = (name: string) => {
    if (!held || name === held) return;
    setOrder((o) => moved(o, held, o.indexOf(name)));
    requestAnimationFrame(() => {
      const el = rows.current[held];
      if (el) { _forceGamepadFocus(el); el.scrollIntoView({ block: 'nearest' }); }
    });
  };
  const lift = (name: string) => { beforeLift.current = order; setHeld(name); };
  const cancel = () => { setOrder(beforeLift.current); setHeld(null); };
  const dragOver = (e: any, name: string) => {
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-region]');
    const target = under?.getAttribute('data-region');
    if (target && target !== name) setOrder((o) => moved(o, name, o.indexOf(target)));
  };

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => { if (held) cancel(); else libBack("/romm-sync-settings"); }}
      onCancelActionDescription={held ? 'Cancel' : 'Back'}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-settings")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Region order</div>
      </div>
      <div style={{ fontSize: '13px', color: V2.fgMuted, margin: '0 4px 16px' }}>
        Decides which version a game opens with when it has several. A version you marked as main still comes first.
      </div>
      <div style={{ borderRadius: V2.radiusCard, background: V2.surface, border: `1px solid ${V2.border}`, overflow: 'hidden', marginBottom: '20px' }}>
        <V2CardRow first last
          icon={<FaGlobe size={16} />}
          title="Use the order from RomM"
          subtitle={follow
            ? `${(loaded?.server || []).join(', ') || 'No order set'}. Set on the server, shared by everyone on it.`
            : 'Off: this device uses the order below.'}
          onClick={() => { setHeld(null); setFollow(!follow); }}
          right={<V2Switch checked={follow} />} />
      </div>
      <V2SettingsSection title={follow ? 'Order in use' : 'Your order'}>
        <ScrollFade maxHeight="calc(100vh - 330px)" refresh={order.join()}
          style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '2px' }}>
          {(follow ? (loaded?.server || []) as string[] : order).map((name, i) => (
            <RegionRow key={name} name={name} rank={i + 1} editable={!follow} held={held === name}
              setRef={(el) => { rows.current[name] = el; }}
              onActivate={() => {
                // Releasing a mouse drag also clicks the row; that isn't a lift.
                if (performance.now() - dragEndedAt.current < 300) return;
                if (held) setHeld(null); else lift(name);
              }}
              onFocused={() => landedOn(name)}
              onDragStart={() => lift(name)}
              onDragMove={(e) => dragOver(e, name)}
              onDragEnd={() => {
                dragEndedAt.current = performance.now();
                setHeld(null);
                // The grip isn't focusable, so a drag would leave focus nowhere
                // and Back with no row to act on.
                const el = rows.current[name];
                if (el) _forceGamepadFocus(el);
              }} />
          ))}
        </ScrollFade>
      </V2SettingsSection>
    </Focusable>
  );
}

function RegionRow({ name, rank, editable, held, setRef, onActivate, onFocused, onDragStart, onDragMove, onDragEnd }: {
  name: string; rank: number; editable: boolean; held: boolean;
  setRef: (el: HTMLElement | null) => void; onActivate: () => void; onFocused: () => void;
  onDragStart: () => void; onDragMove: (e: any) => void; onDragEnd: () => void;
}) {
  const [lit, setLit] = useState(false);
  const on = editable && (lit || held);
  const body = (
    <div ref={setRef as any} data-region={name} tabIndex={editable ? 0 : undefined} style={{
      display: 'flex', alignItems: 'center', gap: '14px', padding: '11px 14px',
      borderRadius: V2.radiusCard, background: on ? V2.surfaceHover : V2.surface,
      border: `1px solid ${V2.border}`, boxShadow: on ? `inset 0 0 0 2px ${V2.brand}` : 'none',
      opacity: editable ? 1 : 0.5,
    }}>
      <div style={{ width: '32px', height: '32px', borderRadius: V2.radiusMd, display: 'flex', alignItems: 'center', justifyContent: 'center', background: V2.bgElevated, color: V2.brandHover, fontSize: '13px', fontWeight: 700 }}>{rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 600 }}>{flag(name)} {name}</div>
        {held && <div style={{ fontSize: '12px', color: V2.fgMuted }}>Moving: up and down to place, A to drop</div>}
      </div>
      {editable && (
        <div style={{ color: V2.fgFaint, cursor: 'grab', touchAction: 'none', padding: '6px' }}
          onPointerDown={(e) => {
            e.preventDefault(); e.stopPropagation();
            onDragStart();
            // On the window, not the grip: reordering moves this row in the DOM,
            // which drops pointer capture and would lose the release.
            const end = () => {
              window.removeEventListener('pointermove', onDragMove);
              window.removeEventListener('pointerup', end);
              window.removeEventListener('pointercancel', end);
              onDragEnd();
            };
            window.addEventListener('pointermove', onDragMove);
            window.addEventListener('pointerup', end);
            window.addEventListener('pointercancel', end);
          }}>
          <FaGripLines size={14} />
        </div>
      )}
    </div>
  );
  if (!editable) return body;
  return (
    <Focusable noFocusRing onActivate={onActivate}
      onOKActionDescription={held ? 'Drop' : 'Move'}
      onFocus={() => { setLit(true); onFocused(); }} onBlur={() => setLit(false)}>
      {body}
    </Focusable>
  );
}
