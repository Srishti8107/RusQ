/**
 * Profile fields – shared by Register and My profile. Every field is visible and labelled.
 * Three plain sections (decisions.md 12.2): about you · your family · your work.
 */
import { NEED_FLAGS, NEED_LABELS, type NeedFlag, type Profile } from '@rusq/shared';

export type ProfileDraft = Omit<Profile, 'updatedAt'>;

export const EMPTY_PROFILE: ProfileDraft = { name: '', contacts: [], details: { needs: [] } };

export function ProfileForm({ value, onChange }: { value: ProfileDraft; onChange: (p: ProfileDraft) => void }) {
  const d = value.details;
  const setD = (patch: Partial<ProfileDraft['details']>) => onChange({ ...value, details: { ...d, ...patch } });
  const num = (v: string) => (v.trim() === '' ? undefined : Math.max(0, parseInt(v, 10) || 0));

  return (
    <>
      <h2>About you</h2>
      <label className="field">
        Full name *
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} required autoComplete="name" name="name" />
      </label>
      <div className="grid2">
        <label className="field">
          Age
          <input inputMode="numeric" value={d.age ?? ''} onChange={(e) => setD({ age: num(e.target.value) })} name="age" />
        </label>
        <label className="field">
          Your phone number
          <input type="tel" value={d.phone ?? ''} onChange={(e) => setD({ phone: e.target.value })} autoComplete="tel" name="phone" />
        </label>
      </div>

      <h2>Your family</h2>
      <label className="field">
        Total number of people in the house
        <input inputMode="numeric" value={d.householdSize ?? ''} onChange={(e) => setD({ householdSize: num(e.target.value) || undefined })} name="household" />
      </label>
      <fieldset className="card" style={{ margin: '10px 0' }}>
        <legend>
          <strong>Who in your home needs extra help?</strong> (tick all that apply)
        </legend>
        {NEED_FLAGS.map((n) => (
          <label className="check" key={n}>
            <input
              type="checkbox"
              checked={d.needs.includes(n)}
              onChange={(e) => setD({ needs: e.target.checked ? [...d.needs, n] : d.needs.filter((x: NeedFlag) => x !== n) })}
            />
            <span>{NEED_LABELS[n]}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        Medical notes for your family (medicines, allergies, conditions)
        <textarea value={d.medicalNotes ?? ''} onChange={(e) => setD({ medicalNotes: e.target.value })} name="medical" maxLength={500} />
      </label>

      <fieldset className="card" style={{ margin: '10px 0' }}>
        <legend>
          <strong>Family members to call in an emergency</strong> (up to 5) – rescuers call them if they cannot reach you
        </legend>
        {value.contacts.map((c, i) => (
          <div key={i} className="card" style={{ margin: '8px 0' }} data-testid="contact-row">
            <label className="field">
              Contact {i + 1} name *
              <input value={c.name} onChange={(e) => onChange({ ...value, contacts: value.contacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            </label>
            <label className="field">
              Contact {i + 1} phone *
              <input type="tel" value={c.phone} onChange={(e) => onChange({ ...value, contacts: value.contacts.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)) })} />
            </label>
            <label className="field">
              Relation (son, daughter, neighbour…)
              <input value={c.relation ?? ''} onChange={(e) => onChange({ ...value, contacts: value.contacts.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)) })} />
            </label>
            <button type="button" className="btn danger secondary small" onClick={() => onChange({ ...value, contacts: value.contacts.filter((_, j) => j !== i) })}>
              Remove contact {i + 1}
            </button>
          </div>
        ))}
        {value.contacts.length < 5 && (
          <button type="button" className="btn secondary small" onClick={() => onChange({ ...value, contacts: [...value.contacts, { name: '', phone: '', relation: '' }] })}>
            ➕ Add a family member to call
          </button>
        )}
      </fieldset>

      <h2>Your work</h2>
      <div className="grid2">
        <label className="field">
          Your work (for example farmer, driver, student)
          <input value={d.occupation ?? ''} onChange={(e) => setD({ occupation: e.target.value })} name="occupation" autoComplete="organization-title" />
        </label>
        <label className="field">
          Where you work (place or area)
          <input value={d.workplace ?? ''} onChange={(e) => setD({ workplace: e.target.value })} name="workplace" />
        </label>
      </div>
    </>
  );
}

/** Drops empty optional strings so the strict schema accepts the draft. */
export function cleanDraft(p: ProfileDraft): ProfileDraft {
  const d = { ...p.details };
  for (const k of ['phone', 'address', 'language', 'medicalNotes', 'occupation', 'workplace'] as const) if (!d[k]?.trim()) delete d[k];
  return {
    name: p.name.trim(),
    contacts: p.contacts.map((c) => ({ name: c.name.trim(), phone: c.phone.trim(), ...(c.relation?.trim() ? { relation: c.relation.trim() } : {}) })),
    details: d,
  };
}
