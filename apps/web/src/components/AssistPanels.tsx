/**
 * Report-form helpers. "Explain my share" ALWAYS works (deterministic template);
 * the optional AI helper only re-words it, and only if its reply passes the
 * number guard. "Tidy my notes" is offered only when the helper is on; its
 * result is a suggestion the rescuer can copy in – it never edits anything itself.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HAZARD_LABELS, RESOURCES, type AllocationResult, type ResourceQty, type StructuredNotes } from '@rusq/shared';
import { assistEnabled, assistState, explainShare, onAssistChange, structureNotes } from '../lib/assistant.ts';

function useAssist() {
  const [enabled, setEnabled] = useState(false);
  const [st, setSt] = useState(assistState());
  useEffect(() => {
    void assistEnabled().then(setEnabled);
    return onAssistChange(() => setSt(assistState()));
  }, []);
  return { enabled, ready: enabled && st.status === 'ready', st };
}

export function NotesHelper({ notes, onUse }: { notes: string; onUse: (text: string) => void }) {
  const a = useAssist();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: true; value: StructuredNotes } | { ok: false; reason: string } | null>(null);
  if (!a.enabled)
    return (
      <p className="small muted">
        AI writing helper: off (experimental, optional – <Link to="/settings">Settings</Link>).
      </p>
    );
  return (
    <div className="card" data-testid="notes-helper">
      <span className="label-exp">EXPERIMENTAL</span> <span className="label-advisory">AI SUGGESTION</span>
      <button className="btn secondary small" style={{ marginLeft: 8 }} disabled={!a.ready || busy || notes.trim().length < 10} onClick={async () => (setBusy(true), setOut(await structureNotes(notes)), setBusy(false))}>
        {busy ? 'Working…' : '✨ Tidy my notes into a list'}
      </button>
      {!a.ready && <p className="small muted">The helper is not loaded ({a.st.status}). Load it in Settings.</p>}
      {out && !out.ok && <p className="small">The helper’s answer was discarded ({out.reason}). Your notes are unchanged.</p>}
      {out?.ok && (
        <div>
          <ul>
            {out.value.observations.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
          {out.value.hazardsMentioned.length > 0 && <p className="small">Hazards mentioned: {out.value.hazardsMentioned.filter((h) => HAZARD_LABELS.includes(h)).join(', ')}</p>}
          {out.value.needsMentioned.length > 0 && <p className="small">Needs mentioned: {out.value.needsMentioned.map((k) => RESOURCES[k].label).join(', ')} (not ticked – tick them yourself if right)</p>}
          <button className="btn secondary small" onClick={() => onUse(out.value.observations.map((o) => `• ${o}`).join('\n'))}>
            Use this list as my notes
          </button>
        </div>
      )}
    </div>
  );
}

export function ExplainShare({ result, siteId, requested }: { result: AllocationResult; siteId: string; requested: ResourceQty }) {
  const a = useAssist();
  const [ex, setEx] = useState<{ text: string; source: 'assistant' | 'template'; discarded?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn secondary small" disabled={busy} onClick={async () => (setBusy(true), setEx(await explainShare(result, siteId, requested)), setBusy(false))} data-testid="explain-share">
        {busy ? 'Explaining…' : a.ready ? 'Explain my share in plain words (AI helper)' : 'Explain my share in plain words'}
      </button>
      {ex && (
        <p className="small" data-testid="share-explanation" data-source={ex.source}>
          {ex.text}
          {ex.source === 'assistant' && <> <span className="label-exp">AI WORDING – numbers checked</span></>}
          {ex.discarded && <span className="muted"> (AI wording discarded: {ex.discarded})</span>}
        </p>
      )}
    </div>
  );
}
