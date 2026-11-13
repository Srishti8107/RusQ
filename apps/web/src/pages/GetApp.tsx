/** Website for field roles (when the server keeps the website for the control room only). */
import type { WebPolicy } from '../lib/webpolicy.ts';

export function GetApp({ policy, signedInAs, onSignOut }: { policy: WebPolicy | null; signedInAs?: string; onSignOut?: () => void }) {
  return (
    <div className="card" data-testid="get-app">
      <h1>Install the RusQ app</h1>
      <p>
        This website is for the <strong>district control room</strong>. People needing help and rescue teams use the <strong>RusQ Android app</strong>: it keeps working
        without internet and passes SOS and reports from phone to phone over Bluetooth and Wi-Fi Direct – a website cannot do that.
      </p>
      {policy?.apk ? (
        <a className="btn block" href={policy.apk} download data-testid="apk-link">
          📲 Download the Android app
        </a>
      ) : (
        <p className="banner warn">Ask the control room for the app (it is not offered for download on this server yet).</p>
      )}
      <ol className="small">
        <li>Open the downloaded file and allow installing it (“Install unknown apps”).</li>
        <li>Open RusQ, sign in with the same user ID while you have internet once.</li>
        <li>Open “Ready for offline” and allow “Nearby devices” and location – phones then find each other by themselves.</li>
      </ol>
      <p className="small muted">iPhone? The control room can switch the website on for field use (server setting RUSQ_WEB_FIELD_ROLES=1).</p>
      {signedInAs && onSignOut && (
        <p className="small">
          Signed in as {signedInAs}.{' '}
          <button className="btn small secondary" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      )}
    </div>
  );
}
