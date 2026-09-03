'use client';
import type { PlaybookRule } from '@/types/playbook';

interface PlaybookRuleInputProps {
  rule: PlaybookRule;
  value: unknown;
  onChange: (value: unknown) => void;
}

export default function PlaybookRuleInput({ rule, value, onChange }: PlaybookRuleInputProps) {
  if (rule.inputType === 'boolean') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        {([{ label: 'Yes', value: true }, { label: 'No', value: false }] as const).map(option => (
          <button key={option.label} type="button" onClick={() => onChange(option.value)} style={{ minHeight: 38, minWidth: 64, borderRadius: 8, border: `1px solid ${value === option.value ? 'var(--accent)' : 'var(--border)'}`, background: value === option.value ? 'var(--accent-soft)' : 'var(--bg-surface)', color: value === option.value ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontWeight: 700 }}>{option.label}</button>
        ))}
      </div>
    );
  }
  if (rule.inputType === 'single_choice') {
    return <select value={String(value ?? '')} onChange={event => onChange(event.target.value)} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }}><option value="">Select…</option>{rule.options.map(option => <option key={option} value={option}>{option}</option>)}</select>;
  }
  if (rule.inputType === 'multi_choice') {
    const selected = Array.isArray(value) ? value as string[] : [];
    return <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{rule.options.map(option => <button key={option} type="button" onClick={() => onChange(selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option])} style={{ minHeight: 36, borderRadius: 18, border: `1px solid ${selected.includes(option) ? 'var(--accent)' : 'var(--border)'}`, background: selected.includes(option) ? 'var(--accent-soft)' : 'var(--bg-surface)', color: selected.includes(option) ? 'var(--accent)' : 'var(--text-muted)', padding: '0 10px', cursor: 'pointer' }}>{option}</button>)}</div>;
  }
  if (rule.inputType === 'rating') {
    return <div><input type="range" min="1" max="10" value={Number(value || 5)} onChange={event => onChange(Number(event.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} /><div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>{Number(value || 5)}/10</div></div>;
  }
  const numericTypes = ['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward'];
  if (numericTypes.includes(rule.inputType)) {
    const defaultUnit = rule.inputType === 'percentage' ? '%' : rule.inputType === 'risk_reward' ? 'R' : '';
    return <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><input type="number" step="any" min={rule.inputType === 'percentage' || rule.inputType === 'risk_reward' ? (rule.validation?.min ?? 0) : (rule.validation?.min ?? undefined)} max={rule.inputType === 'percentage' ? (rule.validation?.max ?? 100) : (rule.validation?.max ?? undefined)} placeholder={rule.placeholder || (rule.inputType === 'risk_reward' ? 'e.g. 2 for 1:2' : undefined)} value={String(value ?? '')} onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />{(rule.unit || defaultUnit) && <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{rule.unit || defaultUnit}</span>}</div>;
  }
  if (rule.inputType === 'date' || rule.inputType === 'time') {
    return <input type={rule.inputType} value={String(value ?? '')} onChange={event => onChange(event.target.value)} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />;
  }
  if (rule.inputType === 'text') {
    return <input type="text" value={String(value ?? '')} minLength={rule.validation?.minLength ?? undefined} maxLength={rule.validation?.maxLength ?? undefined} placeholder={rule.placeholder || undefined} onChange={event => onChange(event.target.value)} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />;
  }
  return <textarea value={String(value ?? '')} minLength={rule.validation?.minLength ?? undefined} maxLength={rule.validation?.maxLength ?? undefined} placeholder={rule.placeholder || undefined} onChange={event => onChange(event.target.value)} rows={4} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: 9, resize: 'vertical' }} />;
}
