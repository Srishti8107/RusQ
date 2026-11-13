/**
 * The ONLY component that renders delivery wording. It reads the label from the
 * shared state machine, so "Received" can only ever appear for a verified,
 * server-acknowledged item (§2.1).
 */
import { deliveryLabel, isDelivered, type DeliveryState } from '@rusq/shared';

export function StatusBadge({ s, long = false }: { s: Pick<DeliveryState, 'status' | 'ack' | 'via' | 'lastError'>; long?: boolean }) {
  const label = deliveryLabel(s);
  const cls = isDelivered(s) ? 'received' : s.status === 'sent' ? 'sent' : 'queued';
  const icon = cls === 'received' ? '✔' : cls === 'sent' ? '⇢' : '⏸';
  return (
    <span className="stack" style={{ gap: 4 }}>
      <span className={`status ${cls}`} data-testid="delivery-status" data-status={cls}>
        <span aria-hidden="true">{icon}</span> {label.short}
      </span>
      {long && <span className="small muted">{label.long}</span>}
      {long && s.lastError && cls !== 'received' && <span className="small" style={{ color: 'var(--bad)' }}>Last try: {s.lastError}</span>}
    </span>
  );
}
