import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { GamepadButton } from '@ludo/host';
import { _forceGamepadFocus, _gpFocusEl } from './shell';
import { tileElFor } from './tiles';
import { LibGame } from './types';

// The grid keeps its normal CSS layout; only whole rows outside the viewport
// are replaced by spacers. Two rows on either side keep directional navigation ready.
export function useVirtualGrid(count: number, resetKey: unknown, returnIndex = -1) {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ columns: 1, pitch: 220, start: 0, end: 30 });
  const [focused, setFocused] = useState(-1);
  const metrics = useRef({ columns: 1, pitch: 220 });
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    const grid = el.firstElementChild as HTMLElement | null;
    if (!grid) return;
    const style = getComputedStyle(grid);
    const width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const columns = Math.max(1, Math.floor((width + 16) / 148));
    const tile = grid.querySelector('.romm-gt-wrap') as HTMLElement | null;
    const pitch = tile ? tile.getBoundingClientRect().height + 18 : ((width - (columns - 1) * 16) / columns * 4 / 3 + 40);
    metrics.current = { columns, pitch };
    const scroller = el.closest('.romm-ui') as HTMLElement | null;
    const viewport = scroller?.getBoundingClientRect();
    const top = grid.getBoundingClientRect().top + parseFloat(style.paddingTop);
    const y = Math.max(0, (viewport?.top ?? 0) - top);
    const height = scroller?.clientHeight || window.innerHeight;
    const rows = Math.ceil(count / columns);
    const start = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor(y / pitch) - 2));
    const end = Math.min(rows, Math.ceil((y + height) / pitch) + 2);
    setLayout((old) => old.columns === columns && Math.abs(old.pitch - pitch) < 0.1 && old.start === start && old.end === end
      ? old : { columns, pitch, start, end });
  }, [count]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest('.romm-ui');
    update();
    scroller?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => { scroller?.removeEventListener('scroll', update); window.removeEventListener('resize', update); observer?.disconnect(); if (pending.current) clearTimeout(pending.current); };
  }, [update, resetKey]);
  const scrollToIndex = useCallback((index: number) => {
    const el = ref.current;
    const grid = el?.firstElementChild as HTMLElement | null;
    const scroller = el?.closest('.romm-ui') as HTMLElement | null;
    if (!grid || !scroller) return;
    const { columns, pitch } = metrics.current;
    scroller.scrollTop += grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      + parseFloat(getComputedStyle(grid).paddingTop) + Math.floor(index / columns) * pitch - scroller.clientHeight / 3;
    update();
  }, [update]);
  const navigate = (event: any, games: LibGame[]) => {
    const button = event?.detail?.button;
    const columns = metrics.current.columns;
    const current = focused >= 0 ? tileElFor(games[focused]?.rom_id) : null;
    const focus = _gpFocusEl();
    if (!current || !focus || !current.contains(focus) || !ref.current?.contains(current)) return;
    let target = focused;
    if (button === GamepadButton.DIR_UP) target -= columns;
    else if (button === GamepadButton.DIR_DOWN && Math.floor(focused / columns) < Math.floor((games.length - 1) / columns)) target = Math.min(games.length - 1, target + columns);
    else if (button === GamepadButton.DIR_LEFT && focused % columns > 0) target--;
    else if (button === GamepadButton.DIR_RIGHT && focused % columns < columns - 1) target++;
    else return;
    if (target < 0 || target >= games.length || target === focused) return;
    const existing = tileElFor(games[target].rom_id);
    if (existing && ref.current.contains(existing)) return;
    event.stopPropagation?.();
    if (pending.current) clearTimeout(pending.current);
    scrollToIndex(target);
    const focusTarget = (attempt: number) => {
      const el = tileElFor(games[target].rom_id);
      if (el && ref.current?.contains(el)) _forceGamepadFocus(el);
      else if (attempt < 12) pending.current = setTimeout(() => focusTarget(attempt + 1), 50);
    };
    pending.current = setTimeout(() => focusTarget(0), 0);
  };
  const rows = Math.ceil(count / layout.columns);
  const start = Math.min(layout.start, rows);
  const end = Math.max(start, Math.min(layout.end, rows));
  const pinIndex = focused >= 0 ? focused : returnIndex;
  const pinned = pinIndex >= 0 && pinIndex < count ? Math.floor(pinIndex / layout.columns) : -1;
  const ranges = [[start, end]];
  if (pinned >= 0 && (pinned < start || pinned >= end)) ranges.push([pinned, pinned + 1]);
  ranges.sort((a, b) => a[0] - b[0]);
  const segments: { start: number; end: number; before: number }[] = [];
  let previous = 0;
  for (const [from, to] of ranges) {
    if (from === to) continue;
    segments.push({ start: from * layout.columns, end: Math.min(count, to * layout.columns), before: from > previous ? (from - previous) * layout.pitch - 18 : 0 });
    previous = to;
  }
  return { ref, segments, after: previous < rows ? (rows - previous) * layout.pitch - 18 : 0,
    onFocus: setFocused, scrollToIndex, navigate, update };
}
