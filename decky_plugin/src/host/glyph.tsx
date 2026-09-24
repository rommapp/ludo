/**
 * The pad button for an action, drawn inline beside an on-screen control so the
 * control doubles as its own legend.
 *
 * Drawn with Steam's own glyph component — the one the footer legend uses — so
 * it follows whatever controller is actually driving (Deck, Xbox, PlayStation,
 * Switch…) and changes with it, exactly as the footer does. That component is
 * not part of Decky's API: it is found by its source, which mentions the
 * navigation-source glyph store and takes an `actionButton` prop. Steam updates
 * can rename that; if the lookup finds nothing, the fallback is a plain keycap
 * with the Deck's letters, which is wrong only for non-Deck pads.
 */
import { findModuleExport } from "@decky/ui";

// Steam's EGamepadButton-like enum the glyph component takes (A=0 … Start=11),
// read live off the client. Not Decky's GamepadButton, whose numbers differ.
const STEAM_BUTTON: Record<string, number> = {
  ok: 0, cancel: 1, secondary: 2, options: 3, select: 10, start: 11,
};

let steamGlyph: any = undefined;   // undefined: not looked up yet; null: absent
function findSteamGlyph(): any {
  if (steamGlyph !== undefined) return steamGlyph;
  try {
    steamGlyph = findModuleExport((e: any) => {
      if (typeof e !== "function") return false;
      const s = Function.prototype.toString.call(e);
      return s.includes("NavigationSourceGlyphInfo") && s.includes("actionButton");
    }) || null;
  } catch {
    steamGlyph = null;
  }
  return steamGlyph;
}

const LABELS: Record<string, string> = {
  ok: "A", cancel: "B", secondary: "X", options: "Y", start: "☰", select: "⧉",
};

type Slot = "ok" | "cancel" | "secondary" | "options" | "start" | "select";

export function ButtonGlyph({ slot }: { slot: Slot }) {
  const SteamGlyph = findSteamGlyph();
  if (SteamGlyph) {
    return (
      <span style={{ display: "inline-flex", flexShrink: 0, height: "20px", alignItems: "center" }}>
        <SteamGlyph actionButton={STEAM_BUTTON[slot]} style={{ height: "20px", width: "auto", display: "block" }} />
      </span>
    );
  }
  return (
    <span aria-label={LABELS[slot]} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      width: "18px", height: "18px", borderRadius: "50%", boxSizing: "border-box",
      background: "rgba(255,255,255,0.88)", color: "#111117",
      fontSize: "10px", fontWeight: 800, lineHeight: 1,
    }}>{LABELS[slot]}</span>
  );
}
