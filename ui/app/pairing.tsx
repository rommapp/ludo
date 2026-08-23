import { V2 } from "./theme";
import { useEffect, useRef, useState } from "react";
import { cancelQrPairing, pollQrPairing, startQrPairing } from "./rpc";
import { host } from "@ludo/host";
// Signing in, and picking a folder — the two things setup and settings share.
//
// Device pairing is the interesting half. Typing a password on a Deck is
// miserable, so RomM's device-code flow is offered alongside it: we ask the
// server for a code, draw it as a QR, and poll until the user has approved it
// on a real keyboard somewhere else. The polling has to survive the wizard
// step being re-rendered, which is why it is a hook with its own lifetime.

// QrCode — draws the backend's boolean matrix as an SVG.
//
// Deliberately not an image: the matrix is a few hundred bytes, SVG stays crisp
// at whatever size the surface gives it, and nothing has to encode a PNG. The
// quiet zone is drawn here rather than baked into the matrix so the light plate
// extends past the modules — phone scanners need that margin, and the Deck's
// dark UI would otherwise run right up to the finder patterns.
type QrState = {
  matrix: boolean[][] | null; userCode: string; verifyUrl: string;
  status: 'idle' | 'starting' | 'waiting' | 'approved' | 'error';
  message: string; unavailable: boolean;
};

export function QrCode({ matrix, size = 200 }: { matrix: boolean[][]; size?: number }) {
  const n = matrix.length;
  if (!n) return null;
  const quiet = 2;
  const span = n + quiet * 2;
  return (
    <div style={{ background: '#ffffff', borderRadius: V2.radiusMd, padding: '10px', lineHeight: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
        role="img" aria-label="Pairing QR code">
        <rect width={span} height={span} fill="#ffffff" />
        {matrix.map((row, y) => row.map((on, x) => on
          ? <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000000" />
          : null))}
      </svg>
    </div>
  );
}

// useQrPairing — owns one device-auth request: start it, poll until the user
// approves on their phone, and stop cleanly when the caller goes away.
//
// The poll interval comes from the server (RFC 8628's `interval`, widened if it
// answers slow_down), so this never hammers an endpoint that is rate-limited
// per-IP. `active` is what makes it safe to mount on a step the user can leave:
// flipping it false cancels the pending request instead of leaving a poll loop
// running behind a screen nobody is looking at.
export function useQrPairing(url: string, active: boolean, onPaired: (r: any) => void) {
  const [qr, setQr] = useState<QrState>({
    matrix: null, userCode: '', verifyUrl: '', status: 'idle', message: '', unavailable: false,
  });
  // onPaired is typically an inline closure; keep it in a ref so re-renders
  // don't restart the flow through the effect's dependency list.
  const paidRef = useRef(onPaired);
  paidRef.current = onPaired;
  const [nonce, setNonce] = useState(0);
  const retry = () => setNonce((n) => n + 1);

  useEffect(() => {
    if (!active || !url.trim()) return;
    let alive = true;
    let timer: any = null;
    setQr({ matrix: null, userCode: '', verifyUrl: '', status: 'starting', message: '', unavailable: false });

    (async () => {
      let started: any;
      try { started = await startQrPairing(url.trim()); }
      catch { started = { success: false, message: 'Could not reach the server.' }; }
      if (!alive) return;
      if (!started?.success) {
        setQr({
          matrix: null, userCode: '', verifyUrl: '', status: 'error',
          message: started?.message || 'Could not start QR pairing.',
          unavailable: !!started?.unavailable,
        });
        return;
      }
      setQr({
        matrix: started.matrix || null,
        userCode: started.user_code || '',
        verifyUrl: started.verification_url || '',
        status: 'waiting', message: '', unavailable: false,
      });

      const tick = async () => {
        if (!alive) return;
        let r: any;
        try { r = await pollQrPairing(); }
        catch { r = { status: 'pending' }; }  // a dropped poll is not a failure
        if (!alive) return;
        if (r?.status === 'approved') {
          setQr((s) => ({ ...s, status: 'approved', message: r?.message || 'Paired' }));
          paidRef.current(r);
          return;
        }
        if (r?.status === 'pending') {
          timer = setTimeout(tick, Math.max(1, Number(r?.interval) || 5) * 1000);
          return;
        }
        setQr((s) => ({
          ...s, status: 'error',
          message: r?.status === 'expired'
            ? 'This code expired. Get a new one to try again.'
            : (r?.message || 'Pairing failed.'),
        }));
      };
      timer = setTimeout(tick, 3000);
    })();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      // Drop the server-side request too, so leaving the step doesn't leave a
      // code the user could still approve into a device that stopped listening.
      cancelQrPairing().catch(() => { });
    };
  }, [url, active, nonce]);

  return { qr, retry };
}

// Where a folder picker should open. Prefer the folder already in use; with
// nothing set the Deck has a known home, while on the desktop we pass '' and let
// the shell answer with the real one — '/home/deck' does not exist there, which
// is how the picker ended up opening on an empty listing.
export function pickerStart(current?: string | null): string {
  if (current) return current;
  return host.capabilities.exit ? '' : '/home/deck';
}
