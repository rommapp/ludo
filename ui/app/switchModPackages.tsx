import { showModal } from '@ludo/host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaDownload, FaTrash, FaWrench } from 'react-icons/fa';
import { PickerModal, SectionHeading, V2SettingsRow } from './kit';
import { getSwitchModPackages, installSwitchModPackage, removeSwitchModPackage, recoverSwitchModPackages } from './rpc';
import { fetchLabel, runEdenChange, useFetchProgress } from './switchAddOns';
import { _broadcastSwitchModsChanged } from './events';
import { toaster } from './toast';

type ServerPackage = { package_id: string; file_id: number; file_name: string };
type InstalledPackage = { package_id: string; name: string };
type Packages = { title_id: string | null; server: ServerPackage[]; installed: InstalledPackage[]; message?: string; recovery_required?: boolean };

export function SwitchModPackagesSection({ romId }: { romId: number }) {
  const [state, setState] = useState<Packages | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const claimed = useRef(false);
  const progress = useFetchProgress(romId, busy);
  const load = useCallback(async () => {
    try {
      const result = await getSwitchModPackages(romId);
      if (active.current) setState(result);
    } catch {
      // RomM unreachable: the section stays hidden, as with no packages.
    }
  }, [romId]);
  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; };
  }, [load]);

  const change = async (apply: () => Promise<any>, title: string, onChanged?: () => void) => {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    try {
      const status = await runEdenChange(apply, 'Could not change mod package');
      if (status === 'changed') onChanged?.();
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

  const chooseInstall = (entry: ServerPackage) => showModal(<PickerModal title={entry.file_name}
    message="Use a package that matches your game update. Existing mods from other installations are preserved. Bundled desktop Eden settings are skipped."
    items={[
      { key: 'install', label: 'Install', onSelect: () => void change(
        () => installSwitchModPackage(romId, entry.file_id), 'Mod package installed') },
      { key: 'cancel', label: 'Cancel', onSelect: () => {} },
    ]} />);

  // Settings files in a mod are made to be edited, so an edit must not leave
  // the package impossible to remove: say so, and offer to remove it anyway.
  const confirmForce = (entry: InstalledPackage) => showModal(<PickerModal
    title="Files were changed" message="Some files from this package were edited after it was installed. Removing it deletes those edits too. Files that were there before Ludo are kept."
    items={[
      { key: 'force', label: 'Remove anyway', danger: true, onSelect: () => void change(
        () => removeSwitchModPackage(romId, entry.package_id, true), 'Mod package removed') },
      { key: 'keep', label: 'Keep package', onSelect: () => {} },
    ]} />);

  const chooseRemove = (entry: InstalledPackage) => showModal(<PickerModal
    title="Remove mod package?" message="Files installed by Ludo will be removed. Files that were already present are kept."
    items={[
      { key: 'remove', label: 'Remove package', danger: true, onSelect: () => void change(
        () => removeSwitchModPackage(romId, entry.package_id), 'Mod package removed',
        () => confirmForce(entry)) },
      { key: 'keep', label: 'Keep package', onSelect: () => {} },
    ]} />);

  // Nothing to offer on most games: show nothing rather than a heading and an
  // empty note on every Switch game's Files tab.
  if (!state || !state.title_id) return null;
  if (!state.server.length && !state.installed.length && !state.recovery_required) return null;
  const installed = new Set(state?.installed.map(p => p.package_id) ?? []);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <SectionHeading icon={<FaWrench size={12} />}>Mod packages</SectionHeading>
    {state?.message ? <V2SettingsRow title="Mod package status" subtitle={state.message} /> : null}
    {state?.recovery_required ? <V2SettingsRow title="Recover interrupted mod install"
      subtitle="Restore the previous files before playing. Eden must be closed."
      onClick={busy ? undefined : () => void change(recoverSwitchModPackages, 'Previous mod installation restored')} /> : null}
    {busy ? <V2SettingsRow title="Mod package" subtitle={fetchLabel(progress)} /> : null}
    {state?.server.map(entry => <V2SettingsRow key={entry.package_id}
      icon={<FaDownload size={14} />} title={entry.file_name}
      subtitle={installed.has(entry.package_id) ? 'Installed · select to reinstall' : 'On RomM · select to install in Eden'}
      onClick={busy ? undefined : () => chooseInstall(entry)} />)}
    {state?.installed.map(entry => <V2SettingsRow key={`installed:${entry.package_id}`}
      icon={<FaTrash size={14} />} title={entry.name}
      subtitle="Installed · select to remove"
      onClick={busy ? undefined : () => chooseRemove(entry)} />)}
  </div>;
}
