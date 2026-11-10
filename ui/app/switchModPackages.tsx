import { showModal } from '@ludo/host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaDownload, FaTrash, FaWrench } from 'react-icons/fa';
import { PickerModal, SectionHeading, V2SettingsRow } from './kit';
import { getSwitchModPackages, installSwitchModPackage, removeSwitchModPackage, recoverSwitchModPackages } from './rpc';
import { fetchLabel, runEdenChange, useFetchProgress } from './switchAddOns';
import { _broadcastSwitchModsChanged } from './events';
import { toaster } from './toast';
import { V2 } from './theme';

type ServerPackage = { package_id: string; file_id: number; file_name: string };
type InstalledPackage = { package_id: string; name: string; profile: string };
type Packages = { title_id: string | null; server: ServerPackage[]; installed: InstalledPackage[]; message?: string; recovery_required?: boolean };

export function SwitchModPackagesSection({ romId }: { romId: number }) {
  const [state, setState] = useState<Packages | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const claimed = useRef(false);
  const progress = useFetchProgress(romId, busy);
  const load = useCallback(async () => {
    try {
      const result = await getSwitchModPackages(romId);
      if (active.current) { setState(result); setError(''); }
    } catch (e) {
      if (active.current) setError(String(e));
    }
  }, [romId]);
  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; };
  }, [load]);

  const change = async (apply: () => Promise<any>, title: string) => {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    try {
      const status = await runEdenChange(apply, 'Could not change mod package');
      if (status === 'ok') {
        toaster.toast({ title, body: '' });
        _broadcastSwitchModsChanged(romId);
      }
      await load();
    } catch (e) {
      toaster.toast({ title: 'Could not change mod package', body: String(e) });
    } finally {
      claimed.current = false;
      if (active.current) setBusy(false);
    }
  };

  const chooseInstall = (entry: ServerPackage) => {
    const install = (profile: string) => void change(
      () => installSwitchModPackage(romId, entry.file_id, profile), 'Mod package installed');
    showModal(<PickerModal title={entry.file_name}
      message="Use a package that matches your game update. Existing mods from other installations are preserved. Bundled desktop Eden settings are skipped."
      items={[
        ...(state?.title_id === '0100F2C0115B6000' ? [{
          key: 'handheld720', label: 'Install · UltraCam 720p, 16:9, up to 60 FPS',
          onSelect: () => install('handheld720'),
        }] : []),
        { key: 'original', label: 'Install · keep package resolution and FPS', onSelect: () => install('original') },
      ]} />);
  };

  const chooseRemove = (entry: InstalledPackage) => showModal(<PickerModal
    title="Remove mod package?" message="Only unchanged files installed by Ludo will be removed. Files that were already present are kept."
    items={[
      { key: 'remove', label: 'Remove package', danger: true, onSelect: () => void change(
        () => removeSwitchModPackage(romId, entry.package_id), 'Mod package removed') },
      { key: 'keep', label: 'Keep package', onSelect: () => {} },
    ]} />);

  if (!state && !error) return <V2SettingsRow title="Mod packages" subtitle="Loading…" />;
  if (state && !state.title_id) return null;
  const installed = new Set(state?.installed.map(p => p.package_id) ?? []);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <SectionHeading icon={<FaWrench size={12} />}>Mod packages</SectionHeading>
    {error ? <V2SettingsRow title="Could not load mod packages" subtitle={error} onClick={() => void load()} /> : null}
    {state?.message ? <V2SettingsRow title="Mod package status" subtitle={state.message} /> : null}
    {state?.recovery_required ? <V2SettingsRow title="Recover interrupted mod install"
      subtitle="Restore the previous files before playing. Eden must be closed."
      onClick={busy ? undefined : () => void change(recoverSwitchModPackages, 'Previous mod installation restored')} /> : null}
    {busy ? <V2SettingsRow title="Mod package" subtitle={fetchLabel(progress)} /> : null}
    {state?.server.map(entry => <V2SettingsRow key={entry.package_id}
      icon={<FaDownload size={14} />} title={entry.file_name}
      subtitle={installed.has(entry.package_id) ? 'Installed · select to reinstall or change preset' : 'On RomM · select to install in Eden'}
      onClick={busy ? undefined : () => chooseInstall(entry)} />)}
    {state?.installed.map(entry => <V2SettingsRow key={`installed:${entry.package_id}`}
      icon={<FaTrash size={14} />} title={entry.name}
      subtitle={`Installed · ${entry.profile === 'handheld720' ? 'UltraCam handheld preset' : 'original package settings'} · select to remove`}
      onClick={busy ? undefined : () => chooseRemove(entry)} />)}
    {state && !state.server.length && !state.installed.length ? <div style={{ color: V2.fgMuted, fontSize: '12px' }}>
      No ZIP mod packages are attached to this game in RomM.
    </div> : null}
  </div>;
}
