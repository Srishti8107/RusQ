/**
 * Short codes (rescuers + control room). A rescuer with no internet sends a report as one
 * SMS-sized line. Whoever gets it pastes or types it here: this phone checks it, counts the
 * hop, carries it to linked phones and uploads it as soon as it is online. If this phone is
 * offline too, "Pass on by SMS" sends it on to the next number.
 */
import { useEffect, useState } from 'react';
import { SHORT_CODE_LETTERS, RESOURCES, RESOURCE_KEYS } from '@rusq/shared';
import { useReach, useSession } from '../lib/hooks.ts';
import { addReceived, onCodesChange, receivedCodes, smsHref, type AddResult, type ReceivedCode } from '../lib/shortcodes.ts';
import { getSettings } from '../lib/session.ts';
import { syncNow } from '../lib/sync.ts';

export function CodesPage() {
  const session = useSession();
  const reach = useReach();
  const [text, setText] = useState('');
  const [results, setResults] = useState<AddResult[]>([]);
  const [list, setList] = useState<ReceivedCode[]>([]);
  const [numbers, setNumbers] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => void receivedCodes().then(setList);
    load();
    void getSettings().then((s) => setNumbers(s.smsNumbers));
    return onCodesChange(load);
  }, []);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await addReceived(text);
      setResults(r);
      if (r.every((x) => x.ok)) setText('');
    } finally {
      setBusy(false);
    }
  }

  const admin = session?.user.role === 'admin';

  return (
    <div>
      <h1>Short codes</h1>
      <section className="card">
        <p>
          A rescuer without internet can send a report as one short line, e.g. <code className="shortcode">RQ1 Tteam-alpha … P40 U4 NF20B2 … X7Q2MZ4PA</code>.
          {admin ? ' Paste or type codes that reached you by SMS or phone call.' : ' Paste or type a code you got by SMS or that someone read out to you.'}
        </p>
        <label className="field">
          Code(s) – the whole SMS can be pasted
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} spellCheck={false} autoCapitalize="off" data-testid="code-input" />
        </label>
        <button className="btn block" disabled={busy || !text.trim()} onClick={() => void add()} data-testid="code-add">
          ✅ Check and pass on
        </button>
        {results.map((r, i) => (
          <div key={i} className={`banner ${r.ok ? 'info' : 'bad'}`} role={r.ok ? 'status' : 'alert'} data-testid="code-result">
            {r.ok ? (r.duplicate ? `Already here: ${r.item.summary}` : `Received: ${r.item.summary} (hop ${r.item.hops})`) : r.reason}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Codes on this phone</h2>
        {list.length === 0 && <p className="small muted">None yet.</p>}
        {list.map((c) => (
          <div key={c.id} className="code-row" data-testid="code-row" data-status={c.status}>
            <p style={{ margin: 0 }}>
              <strong>{c.summary}</strong>
            </p>
            <p className="small" style={{ margin: '4px 0' }}>
              {c.status === 'uploaded' && <>✅ Reached the control room ({c.serverId})</>}
              {c.status === 'waiting' && <>⏳ Waiting for internet – also passed to linked phones · hop {c.hops}</>}
              {c.status === 'rejected' && <>❌ The server refused it: {c.reason}</>}
            </p>
            <code className="shortcode small">{c.text}</code>
            {c.status === 'waiting' && (
              <div className="row" style={{ marginTop: 6 }}>
                {numbers ? (
                  <a className="btn small secondary" href={smsHref(numbers, c.text)}>
                    📨 Pass on by SMS
                  </a>
                ) : (
                  <span className="small muted">Add SMS numbers in Settings to pass it on by SMS.</span>
                )}
                <button className="btn small secondary" onClick={() => void navigator.clipboard?.writeText(c.text)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        ))}
        {list.some((c) => c.status === 'waiting') && reach === 'online' && (
          <button className="btn small" onClick={() => void syncNow('codes page')}>
            Upload now
          </button>
        )}
      </section>

      <section className="card">
        <h2>Letters for supplies</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {RESOURCE_KEYS.map((k) => (
                <tr key={k}>
                  <td>
                    <strong>{SHORT_CODE_LETTERS[k]}</strong>
                  </td>
                  <td>
                    {RESOURCES[k].label} ({RESOURCES[k].unit})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          P = people, U = urgency 1–5, N = supplies (N F20 B2 = 20 food packs, 2 boats), G = location, H = how many times it was passed on, X = signature (stops typing
          mistakes and fake codes). Life jackets count as rescue equipment (R).
        </p>
      </section>
    </div>
  );
}
