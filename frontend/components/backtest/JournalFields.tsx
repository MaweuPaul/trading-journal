'use client';

export const MISTAKES = ['Early entry', 'Late entry', 'Moved stop', 'Ignored bias', 'Overmanaged', 'No confirmation'];

export interface JournalValues { setupQuality: number; executionQuality: number; planFollowed: boolean | null; mistakes: string[]; lesson: string }
export const EMPTY_JOURNAL: JournalValues = { setupQuality: 0, executionQuality: 0, planFollowed: null, mistakes: [], lesson: '' };

const caps = 'tw:text-[10px] tw:uppercase tw:tracking-wider tw:font-semibold tw:text-on-surface-variant';

function Stars({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="tw:flex tw:flex-col tw:gap-0.5">
      <span className={caps}>{label}</span>
      <div className="tw:flex" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" role="radio" aria-checked={n === value} aria-label={`${label}: ${n} of 5`} onClick={() => onChange(n === value ? 0 : n)} className="tw:p-0.5">
            <span aria-hidden="true" className={`material-symbols-outlined tw:text-[20px] ${n <= value ? 'tw:text-primary' : 'tw:text-outline-variant'}`} style={{ fontVariationSettings: `'FILL' ${n <= value ? 1 : 0}` }}>star</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Process review captured when a simulated trade closes: ratings, plan adherence, mistakes, lesson. */
export default function JournalFields({ value, onChange }: { value: JournalValues; onChange: (v: JournalValues) => void }) {
  const set = <K extends keyof JournalValues>(k: K, v: JournalValues[K]) => onChange({ ...value, [k]: v });
  const pill = (on: boolean, tone: 'good' | 'bad' | 'neutral') => `tw:px-2 tw:py-1 tw:rounded tw:border tw:text-[11px] tw:transition-colors ${on
    ? tone === 'good' ? 'tw:border-secondary tw:bg-secondary/10 tw:text-secondary' : tone === 'bad' ? 'tw:border-error tw:bg-error/10 tw:text-error' : 'tw:border-primary tw:bg-primary/10 tw:text-primary'
    : 'tw:border-outline-variant tw:text-on-surface-variant tw:hover:text-on-surface'}`;
  return (
    <div className="tw:flex tw:flex-col tw:gap-3">
      <div className="tw:grid tw:grid-cols-2 tw:gap-2">
        <Stars label="Setup quality" value={value.setupQuality} onChange={n => set('setupQuality', n)} />
        <Stars label="Execution" value={value.executionQuality} onChange={n => set('executionQuality', n)} />
      </div>
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-2">
        <span className={caps}>Followed the plan?</span>
        <div className="tw:flex tw:gap-1">
          <button type="button" aria-pressed={value.planFollowed === true} onClick={() => set('planFollowed', value.planFollowed === true ? null : true)} className={pill(value.planFollowed === true, 'good')}>Yes</button>
          <button type="button" aria-pressed={value.planFollowed === false} onClick={() => set('planFollowed', value.planFollowed === false ? null : false)} className={pill(value.planFollowed === false, 'bad')}>No</button>
        </div>
      </div>
      <div className="tw:flex tw:flex-col tw:gap-1">
        <span className={caps}>Mistakes</span>
        <div className="tw:flex tw:flex-wrap tw:gap-1">
          {MISTAKES.map(m => {
            const on = value.mistakes.includes(m);
            return <button key={m} type="button" aria-pressed={on} onClick={() => set('mistakes', on ? value.mistakes.filter(x => x !== m) : [...value.mistakes, m])} className={pill(on, 'bad')}>{m}</button>;
          })}
        </div>
      </div>
      <label className="tw:flex tw:flex-col tw:gap-1">
        <span className={caps}>One lesson to carry forward</span>
        <input value={value.lesson} maxLength={2000} onChange={e => set('lesson', e.target.value)} placeholder="Next time I will…"
          className="tw:w-full tw:bg-surface-container-lowest tw:border tw:border-outline-variant tw:rounded tw:px-2.5 tw:py-1.5 tw:text-[12px] tw:text-on-surface tw:focus:outline-none tw:focus:border-primary" />
      </label>
    </div>
  );
}
