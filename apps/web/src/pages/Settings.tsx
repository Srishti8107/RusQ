import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, getDeviceId, getSettings, saveSettings, type Settings } from '../lib/session.ts';
import { terminateVision } from '../lib/vision.ts';

export function SettingsPage() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [device, setDevice] = useState('');
  useEffect(() => {
    void getSettings().then(setS);
    void getDeviceId().then(setDevice);
  }, []);

  async function update(p: Partial<Settings>) {
    const n = { ...s, ...p };
    setS(n);
    await saveSettings(p);
    if (p.lowPower) terminateVision();
  }

  return (
    <div>
      <h1>Settings</h1>
      <div className="card">
        <label className="check">
          <input type="checkbox" checked={s.lowPower} onChange={(e) => void update({ lowPower: e.target.checked })} data-testid="low-power" />
          <span>
            Low-power mode
            <br />
            <span className="small muted">Saves battery: photos are not analysed automatically and heavy models are unloaded.</span>
          </span>
        </label>
        <label className="field">
          Warn when the resource snapshot is older than (hours)
          <input inputMode="numeric" value={s.staleHours} onChange={(e) => void update({ staleHours: Math.max(1, parseInt(e.target.value || '6', 10)) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.visionMock} onChange={(e) => void update({ visionMock: e.target.checked })} />
          <span>
            Photo helper MOCK mode (testing only)
            <br />
            <span className="small muted">Uses a fake colour-based guess instead of the real model. Clearly marked as MOCK.</span>
          </span>
        </label>
      </div>
      <div className="card small">
        Device id: <span className="mono">{device}</span>
      </div>
    </div>
  );
}
