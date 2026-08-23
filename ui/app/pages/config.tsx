import { ChangeEvent, useEffect, useState } from "react";
import { clearCoverCache, getConfig, pairDevice, saveConfig, testRommConnection } from "../rpc";
import { ButtonItem, FileSelectionType, Navigation, PanelSection, PanelSectionRow, TextField, openFilePicker, staticClasses, toaster } from "@ludo/host";
import { FaCheck, FaTimes } from "react-icons/fa";
import { _coverCacheReset, _coverInflight } from "../media";
import { QrCode, pickerStart, useQrPairing } from "../pairing";
// The connection settings, reachable after setup.
//
// Same fields the wizard collects, without the guided flow around them — this
// is where a server URL or a folder gets corrected later.

// Configuration / first-time setup page
export function ConfigPage() {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [romDir, setRomDir] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [biosDir, setBiosDir] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceNameDefault, setDeviceNameDefault] = useState('SteamOS');
  const [hasPassword, setHasPassword] = useState(false);
  const [retrodeckDetected, setRetrodeckDetected] = useState(false);
  const [isFirstTime, setIsFirstTime] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const config = await getConfig();
        setUrl(config.url || '');
        setUsername(config.username || '');
        setRomDir(config.rom_directory || '');
        setSaveDir(config.save_directory || '');
        setBiosDir(config.bios_directory || '');
        setDeviceName(config.device_name || '');
        setDeviceNameDefault(config.device_name_default || 'SteamOS');
        setHasPassword(config.has_password || false);
        setRetrodeckDetected(config.retrodeck_detected || false);
        setIsFirstTime(!config.configured);
      } catch (e) {
        console.error('[ConfigPage] Failed to load config:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testRommConnection(url.trim(), username.trim(), password);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: 'Test failed unexpectedly.' });
    } finally {
      setTesting(false);
    }
  };

  const handlePair = async () => {
    if (!url.trim() || !pairCode.trim()) return;
    setPairing(true);
    try {
      const result = await pairDevice(url.trim(), pairCode.trim());
      if (result.success) {
        // No in-progress toast — NavigateBack to the connected UI is the feedback.
        setPairCode('');
        Navigation.NavigateBack();
      } else {
        toaster.toast({ title: 'Ludo Error', body: result.message || 'Pairing failed.', duration: 5000 });
      }
    } catch (e) {
      toaster.toast({ title: 'Ludo Error', body: 'Pairing failed unexpectedly.', duration: 5000 });
    } finally {
      setPairing(false);
    }
  };

  // Same QR flow the wizard offers, armed by a button for the same reason (see
  // SetupWizard: device/init is rate-limited and the URL is typed live).
  const [qrArmed, setQrArmed] = useState(false);
  useEffect(() => { setQrArmed(false); }, [url]);
  const { qr, retry: qrRetry } = useQrPairing(url, qrArmed, () => {
    setQrArmed(false);
    Navigation.NavigateBack();
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const effectiveDeviceName = deviceName.trim() || deviceNameDefault;
      const result = await saveConfig(url.trim(), username.trim(), password, romDir.trim(), saveDir.trim(), effectiveDeviceName, biosDir.trim());
      if (result.success) {
        // No in-progress toast — NavigateBack to the reconnecting UI is the feedback.
        Navigation.NavigateBack();
      } else {
        toaster.toast({ title: 'Ludo Error', body: result.error || 'Failed to save configuration.', duration: 5000 });
      }
    } catch (e) {
      toaster.toast({ title: 'Ludo Error', body: 'Failed to save configuration.', duration: 5000 });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: 'white', padding: '20px' }}>Loading configuration…</div>;
  }

  const canSubmit = url.trim().length > 0 && username.trim().length > 0 && (password.length > 0 || hasPassword);

  return (
    <div style={{ overflowY: 'auto', height: 'calc(100vh - 40px)', marginTop: '40px', paddingBottom: '40px', color: 'white' }}>

      {/* Header */}
      {isFirstTime ? (
        <div style={{ padding: '16px 16px 4px' }}>
          <div className={staticClasses.Title} style={{ marginBottom: '8px' }}>Welcome to Ludo</div>
          <div style={{ fontSize: '13px', color: '#d1d5db', lineHeight: '1.6' }}>
            Connect your SteamOS device to your RomM server to automatically sync ROMs and save files across devices.
          </div>
        </div>
      ) : (
        <div className={staticClasses.Title} style={{ margin: '0 16px 8px' }}>RomM Connection Setup</div>
      )}

      {/* RetroDECK banner */}
      {retrodeckDetected && (
        <div style={{
          margin: '8px 16px 4px',
          padding: '10px 14px',
          background: 'rgba(74, 222, 128, 0.12)',
          border: '1px solid rgba(74, 222, 128, 0.4)',
          borderRadius: '6px',
          fontSize: '13px',
          color: '#4ade80',
          lineHeight: '1.5',
        }}>
          <strong>RetroDECK detected</strong> — directories pre-filled with its defaults.
        </div>
      )}

      <PanelSection title="Connection">
        <PanelSectionRow>
          <TextField
            label="RomM URL"
            value={url}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setUrl(e.target.value); setTestResult(null); }}
            description="e.g. https://romm.example.com"
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Username"
            value={username}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setUsername(e.target.value); setTestResult(null); }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Password"
            value={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setPassword(e.target.value); setTestResult(null); }}
            description={hasPassword && !password ? 'Leave blank to keep the saved password' : undefined}
            bIsPassword={true}
          />
        </PanelSectionRow>
        {testResult && (
          <PanelSectionRow>
            <div style={{ color: testResult.success ? '#4ade80' : '#f87171', fontSize: '0.9em', padding: '4px 0' }}>
              {testResult.success ? <FaCheck size={11} style={{ verticalAlign: '-1px' }} /> : <FaTimes size={11} style={{ verticalAlign: '-1px' }} />} {testResult.message}
            </div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleTest} disabled={testing || saving || !url.trim() || !username.trim()}>
            {testing ? 'Testing…' : '🔌 Test Connection'}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Scan a QR code (recommended)">
        {!qrArmed ? (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setQrArmed(true)} disabled={!url.trim() || saving || pairing}
              description="Scan with your phone and approve there.">
              📱 Show QR Code
            </ButtonItem>
          </PanelSectionRow>
        ) : qr.status === 'error' ? (
          <PanelSectionRow>
            <ButtonItem layout="below"
              onClick={qr.unavailable ? () => setQrArmed(false) : qrRetry}
              description={qr.message}>
              {qr.unavailable ? 'Use a pairing code below' : 'Try Again'}
            </ButtonItem>
          </PanelSectionRow>
        ) : qr.status === 'starting' ? (
          <PanelSectionRow>
            <div style={{ padding: '8px 0', fontSize: '13px', opacity: 0.7 }}>Getting a code…</div>
          </PanelSectionRow>
        ) : (
          <PanelSectionRow>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '8px 0' }}>
              {qr.matrix
                ? <QrCode matrix={qr.matrix} size={190} />
                : <div style={{ fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' }}>{qr.verifyUrl}</div>}
              {/* Shown next to the QR, not in place of it — a second device that
                  is already signed in can type this at /pair/device. */}
              {qr.userCode && (
                <div style={{ fontFamily: 'monospace', fontSize: '18px', fontWeight: 700, letterSpacing: '0.2em' }}>
                  {qr.userCode}
                </div>
              )}
              <div style={{ fontSize: '12px', opacity: 0.7, textAlign: 'center' }}>
                {qr.status === 'approved' ? 'Approved!' : 'Waiting for approval…'}
              </div>
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Pair with code">
        <PanelSectionRow>
          <TextField
            label="Pairing code"
            value={pairCode}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPairCode(e.target.value)}
            description="Create a token in the RomM web UI, then enter the code here."
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handlePair} disabled={pairing || saving || !url.trim() || !pairCode.trim()}>
            {pairing ? 'Pairing…' : '🔗 Pair Device'}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Device">
        <PanelSectionRow>
          <TextField
            label="Device name"
            value={deviceName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDeviceName(e.target.value)}
            description="Identifies this device in RomM."
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Directories">
        <PanelSectionRow>
          <TextField
            label="ROM directory"
            value={romDir}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRomDir(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(romDir), false, true);
              if (res?.realpath) setRomDir(res.realpath);
            } catch { }
          }}>
            Browse…
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="Save directory"
            value={saveDir}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSaveDir(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(saveDir), false, true);
              if (res?.realpath) setSaveDir(res.realpath);
            } catch { }
          }}>
            Browse…
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField
            label="BIOS directory"
            value={biosDir}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBiosDir(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const res = await openFilePicker(FileSelectionType.FOLDER, pickerStart(biosDir), false, true);
              if (res?.realpath) setBiosDir(res.realpath);
            } catch { }
          }}>
            Browse…
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleSave} disabled={saving || testing || !canSubmit}>
            {saving ? 'Saving…' : isFirstTime ? '🚀 Connect & Start' : '💾 Save & Apply'}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            try {
              const r = await clearCoverCache();
              _coverCacheReset(); _coverInflight.clear(); // drop the frontend hot layer too
              toaster.toast({ title: 'Cover cache cleared', body: r?.success ? `${r.removed ?? 0} files removed` : (r?.message || 'Error') });
            } catch (e) { toaster.toast({ title: 'Clear failed', body: String(e) }); }
          }}>
            Clear cover cache
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => Navigation.NavigateBack()}>
            Cancel
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
}
