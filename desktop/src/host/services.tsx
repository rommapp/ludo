// This shell's half of the host contract's services: RPC, toasts, modals and
// the file picker. The widget kit is next door in kit.tsx.
import { useState } from "react";
import { pushToast, pushModal, type ToastOpts } from "./overlays";

export { routerHook } from "./router";

// ── RPC ─────────────────────────────────────────────────────────────────────
// Lives in its own module because it is plain fetch: the launcher and anything
// else that only needs to reach the backend can import it without pulling in
// React and the widget kit.
// Imported as well as re-exported: this module calls it itself, and a bare
// `export ... from` creates no local binding.
import { callable } from "./rpc";
export { callable };

// ── Toasts ──────────────────────────────────────────────────────────────────

// While a game is running this window sits behind it, so a toast here is a
// chime over the game and a card nobody sees. Saves are already announced in
// RetroArch itself then (see _emit_game_sync_toast in the engine), so:
//  - the "Uploading save" indicator is dropped; the upload is over by the time
//    the game closes, and RetroArch said so when it finished;
//  - every other toast is held, and shown once the game closes.
// Desktop only: on SteamOS, Decky's toasts are Steam's own and show over games.
const gameRunning = callable<[], { running: boolean }>("game_running");
const SAVE_INDICATOR = "Uploading save";
let playing = false;
let held: ToastOpts[] = [];

async function watchGame() {
  try {
    const running = !!(await gameRunning())?.running;
    if (playing && !running) {
      const queued = held;
      held = [];
      queued.forEach((opts, i) => window.setTimeout(() => pushToast(opts), i * 300));
    }
    playing = running;
  } catch { /* backend not up yet; try again next tick */ }
}
window.setInterval(watchGame, 2000);

export const toaster = {
  toast: (opts: ToastOpts) => {
    if (!playing) return pushToast(opts);
    if (opts.title === SAVE_INDICATOR) return { data: opts, dismiss: () => {} };
    held.push(opts);
    // A caller that dismisses before the game ends never had anything to say.
    return { data: opts, dismiss: () => { held = held.filter((o) => o !== opts); } };
  },
};

// ── File picker ─────────────────────────────────────────────────────────────

export enum FileSelectionType {
  FILE = 0,
  FOLDER = 1,
}

export type FilePickerRes = { path: string; realpath: string };

type DirListing = {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isdir: boolean }[];
};

// The only host service that needs real backend support: a browser cannot
// enumerate the filesystem, and <input type=file webkitdirectory> yields file
// lists rather than a directory path. So the backend exposes a listing endpoint
// and this renders a picker over it.
const listDir = callable<[string, boolean], DirListing>("host_list_dir");

function FolderPicker({
  startPath,
  includeFiles,
  onPick,
  closeModal,
}: {
  startPath: string;
  includeFiles: boolean;
  onPick: (res: FilePickerRes | null) => void;
  closeModal?: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState(startPath);

  const load = async (path: string) => {
    try {
      setError(null);
      const res = await listDir(path, includeFiles);
      setListing(res);
      setCwd(res.path);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  if (!listing && !error) void load(startPath);

  const done = (res: FilePickerRes | null) => {
    onPick(res);
    closeModal?.();
  };

  return (
    <div className="desk-modal desk-picker">
      <div className="desk-picker-path">{cwd}</div>
      {error ? <div className="desk-picker-error">{error}</div> : null}
      <div className="desk-picker-list">
        {listing?.parent ? (
          <button
            className="desk-picker-entry"
            type="button"
            onClick={() => void load(listing.parent!)}
          >
            📁 ..
          </button>
        ) : null}
        {listing?.entries.map((e) => (
          <button
            key={e.path}
            className="desk-picker-entry"
            type="button"
            onClick={() =>
              e.isdir
                ? void load(e.path)
                : done({ path: e.path, realpath: e.path })
            }
          >
            {e.isdir ? "📁" : "📄"} {e.name}
          </button>
        ))}
      </div>
      <div className="desk-picker-actions">
        <button type="button" onClick={() => done(null)}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => done({ path: cwd, realpath: cwd })}
        >
          Select this folder
        </button>
      </div>
    </div>
  );
}

/**
 * Mirrors Decky's signature. Resolves with {path, realpath}; rejects on cancel,
 * which is what the call sites expect (they wrap it in try/catch).
 */
export function openFilePicker(
  select: FileSelectionType,
  startPath: string,
  includeFiles: boolean = false,
  _includeFolders: boolean = true,
): Promise<FilePickerRes> {
  const wantFiles = includeFiles || select === FileSelectionType.FILE;

  // Under Electron, hand off to the OS file chooser — the in-app picker below
  // exists for the GTK shell, which has no IPC to a native dialog.
  const native = (window as any).__rommDesktop?.pickFolder;
  if (typeof native === "function") {
    return native({ startPath, includeFiles: wantFiles }).then(
      (picked: string | null) => {
        if (!picked) throw new Error("cancelled");
        return { path: picked, realpath: picked };
      },
    );
  }

  return new Promise((resolve, reject) => {
    pushModal((handle) => (
      <FolderPicker
        startPath={startPath || "~"}
        includeFiles={wantFiles}
        closeModal={handle.Close}
        onPick={(res) => (res ? resolve(res) : reject(new Error("cancelled")))}
      />
    ));
  });
}
