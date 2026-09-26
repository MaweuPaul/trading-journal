'use client';
import { useState } from 'react';
import { Icon } from './BacktestShell';
import { useBacktest } from './data';

export default function NewStrategyModal({ existing, onClose, onCreated }: {
  existing: { name: string }[]; onClose: () => void; onCreated: (name: string) => void;
}) {
  const { createStrategy } = useBacktest();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const input = 'tw:min-h-[44px] tw:px-space-md tw:bg-surface-container-low tw:text-on-surface tw:rounded tw:focus:outline-none tw:focus:bg-surface-container-high';
  const label = 'tw:font-label-caps tw:text-label-caps tw:text-on-surface-variant tw:uppercase';

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Strategy name is required.'); return; }
    if (existing.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) { setErr('A strategy with that name already exists.'); return; }
    setSaving(true); setErr('');
    const result = await createStrategy(trimmed, description.trim());
    if (result.ok) onCreated(trimmed);
    else { setErr(result.error || 'Could not create strategy'); setSaving(false); }
  };

  return (
    <div className="tw:fixed tw:inset-0 tw:z-50" role="dialog" aria-modal="true" aria-label="New Strategy">
      <div className="tw:absolute tw:inset-0 tw:bg-surface-container-lowest/85 tw:backdrop-blur-sm" onClick={onClose} />
      <div className="tw:absolute tw:top-1/2 tw:left-1/2 tw:-translate-x-1/2 tw:-translate-y-1/2 tw:w-[90%] tw:max-w-md tw:bg-surface-container tw:p-gutter tw:rounded-xl tw:shadow-2xl tw:flex tw:flex-col tw:gap-space-md">
        <div className="tw:flex tw:items-center tw:justify-between">
          <div className="tw:flex tw:items-center tw:gap-space-xs">
            <Icon name="rule" className="tw:text-primary tw:text-[20px]" />
            <h3 className="tw:font-headline-md tw:text-headline-md tw:font-bold tw:text-on-surface">New Strategy</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="tw:min-h-[44px] tw:min-w-[44px] tw:flex tw:items-center tw:justify-center tw:text-on-surface-variant tw:hover:text-on-surface">
            <Icon name="close" className="tw:text-[20px]" />
          </button>
        </div>
        <p className="tw:font-body-sm tw:text-body-sm tw:text-on-surface-variant">
          Name it once here, then pick it from the Strategy field whenever you log a backtest -- so you can compare edge across strategies on the Metrics page.
        </p>
        <label className="tw:flex tw:flex-col tw:gap-1">
          <span className={label}>Strategy Name</span>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. ICT Silver Bullet" maxLength={60} className={input} />
        </label>
        <label className="tw:flex tw:flex-col tw:gap-1">
          <span className={label}>Rules / Notes (optional)</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What's the setup? Entry/exit rules, session, timeframe..."
            rows={3} className={`${input} tw:min-h-0 tw:py-space-xs tw:resize-none`} />
        </label>
        {err && <div className="tw:bg-error-container/40 tw:text-error tw:font-body-sm tw:text-body-sm tw:px-space-sm tw:py-space-xs tw:rounded">{err}</div>}
        <button type="button" onClick={submit} disabled={saving} className="tw:min-h-[44px] tw:bg-primary tw:text-on-primary tw:rounded tw:font-label-action tw:text-label-action tw:font-semibold tw:shadow-md tw:disabled:opacity-60">
          {saving ? 'Creating…' : 'Create Strategy'}
        </button>
      </div>
    </div>
  );
}
