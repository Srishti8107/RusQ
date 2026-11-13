/** Renders the pop-up messages from lib/toast.ts on every screen. Large text, a visible Close button. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { currentToasts, dismiss, onToasts, type Toast } from '../lib/toast.ts';

export function Toasts() {
  const [items, setItems] = useState<Toast[]>(currentToasts());
  useEffect(() => onToasts((t) => setItems([...t])), []);
  if (!items.length) return null;
  return (
    <div className="popups" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`popup ${t.kind}`} data-testid="toast" data-kind={t.kind}>
          <div className="popup-text">
            <strong>{t.title}</strong>
            {t.body && <span className="small">{t.body}</span>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {t.link && (
              <Link className="btn small" to={t.link.to} onClick={() => dismiss(t.id)}>
                {t.link.label}
              </Link>
            )}
            <button className="btn small secondary" onClick={() => dismiss(t.id)} aria-label={`Close: ${t.title}`}>
              ✕ Close
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
