import { ScrollFade } from "../index";
import { v2Page } from "../focus";
import { Focusable } from "@ludo/host";
import { libBack } from "../nav";
import { GameActionButton, V2SettingsSection } from "../kit";
import { FaChevronLeft } from "react-icons/fa";
import { V2 } from "../theme";
import { PlatformSyncList, usePlatformSync } from "../emulator";
// Platform folder mapping: where each platform's roms live on this device.
//
// The sync itself is usePlatformSync, which stays shared — the setup wizard
// runs the same pass on its folders step.

// PlatformsPage — Settings ▸ Platforms. The header counts what the switches add
// up to, because the number that makes someone want to turn a platform off is
// how many games it costs, not how many platforms there are.
export function PlatformsPage() {
  const sync = usePlatformSync();
  const { rows, enabledCount, enabledRoms, totalRoms, loading } = sync;
  const summary = loading || !rows.length
    ? 'Platforms'
    : `${enabledCount} of ${rows.length} syncing · ${enabledRoms.toLocaleString()} of ${totalRoms.toLocaleString()} games`;
  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-settings")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-settings")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Platforms</div>
      </div>

      {/* Same bounded-with-fades treatment as the wizard's platform step. The
          page would happily scroll the whole list, but then the header and the
          "nothing is deleted" note scroll away with it — and on a 30-platform
          server the note is the thing a hesitant user scrolls back up looking
          for. Capping the list keeps both in view and puts the scrolling where
          the content actually is. */}
      <V2SettingsSection title={summary}>
        <ScrollFade maxHeight="calc(100vh - 300px)"
          refresh={`${rows.length}:${sync.off.size}`}
          style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '2px' }}>
          <PlatformSyncList sync={sync} />
        </ScrollFade>
      </V2SettingsSection>

      <div style={{
        fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45,
        padding: '0 4px 24px',
      }}>
        Turning a platform off stops Ludo reading it from RomM, so your library
        loads faster and stays smaller. Nothing is deleted — games you already
        downloaded stay on this device and stay playable. Turn it back on and
        Ludo fetches that platform again.
      </div>
    </Focusable>
  );
}
