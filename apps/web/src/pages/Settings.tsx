import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, getDeviceId, getSettings, saveSettings, type Settings } from '../lib/session.ts';
import { terminateVision } from '../lib/vision.ts';
import { assistState, assistSupported, LLM_DOWNLOAD_MB, loadAssistant, onAssistChange, unloadAssistant } from '../lib/assistant.ts';
import { useReach } from '../lib/hooks.ts';

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
    if (p.lowPower) {
      terminateVision();
      unloadAssistant();
    }
    if (p.assistant === false) unloadAssistant();
  }
  useReach();
  const [gpu, setGpu] = useState<boolean | null>(null);
  const [ast, setAst] = useState(assistState());
  useEffect(() => {
    void assistSupported().then(setGpu);
    return onAssistChange(() => setAst(assistState()));
  }, []);

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
      <div className="card" data-testid="sms-settings">
        <h2>Short codes by SMS</h2>
        <label className="field">
          Send short codes to these numbers (control-room SMS gateway first, then other rescuers; separate with commas)
          <input inputMode="tel" value={s.smsNumbers} placeholder="+91…, +91…" onChange={(e) => void update({ smsNumbers: e.target.value })} data-testid="sms-numbers" />
        </label>
        <p className="small muted">The SMS app opens with the code filled in – you tap Send. Works with weak signal (2G) when the internet does not.</p>
      </div>
      <div className="card" data-testid="assistant-settings">
        <h2>
          AI writing helper <span className="label-exp">EXPERIMENTAL</span> <span className="label-advisory">OPTIONAL</span>
        </h2>
        <p className="small">
          A small language model (Llama 3.2 1B) that runs on this phone. It can tidy your report notes into a list and re-word the “fair share” explanation in simpler
          words. <strong>It never calculates or changes any number</strong> – every answer is checked and thrown away if it contains a number that was not already there.
          RusQ works exactly the same without it.
        </p>
        <p className="small">
          Needs: a phone with WebGPU, about {LLM_DOWNLOAD_MB} MB download (once, from huggingface.co), lots of memory. Not tested on a 3 GB phone.
        </p>
        <p className="small" data-testid="assistant-gpu">
          This browser: {gpu === null ? 'checking…' : gpu ? 'WebGPU available' : 'no WebGPU – the helper cannot run here'}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={s.assistant}
            disabled={!gpu || s.lowPower}
            onChange={(e) => void update({ assistant: e.target.checked })}
            data-testid="assistant-toggle"
          />
          <span>
            Turn on the AI writing helper
            <br />
            <span className="small muted">{s.lowPower ? 'Not available in low-power mode.' : 'Off by default.'}</span>
          </span>
        </label>
        {s.assistant && (
          <div className="row">
            <button className="btn secondary small" disabled={ast.status === 'loading' || ast.status === 'ready'} onClick={() => void loadAssistant()}>
              {ast.status === 'ready' ? 'Helper loaded' : ast.status === 'loading' ? 'Loading…' : 'Download / load the helper'}
            </button>
            <span className="small">{ast.status === 'loading' ? ast.progressText : ast.status === 'error' ? `Error: ${ast.lastError}` : ast.status}</span>
          </div>
        )}
      </div>
      <div className="card small">
        Device id: <span className="mono">{device}</span>
      </div>
    </div>
  );
}
