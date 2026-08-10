'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Check, Plus, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';

type RuleCategory = 'pre_trade' | 'execution';

interface TradingRule {
  ruleId: string;
  label: string;
  category: RuleCategory;
  enabled: boolean;
  order: number;
}

const CATEGORY_COPY: Record<RuleCategory, { title: string; description: string }> = {
  pre_trade: {
    title: 'Pre-trade rules',
    description: 'Conditions that should be true before you enter a trade.',
  },
  execution: {
    title: 'Execution rules',
    description: 'Behaviors you want to follow while managing an open trade.',
  },
};

const DEFAULTS: TradingRule[] = [
  { ruleId: 'pre-htf-trend', label: 'HTF Trend Aligned', category: 'pre_trade', enabled: true, order: 0 },
  { ruleId: 'pre-key-level', label: 'Daily/H4 Key Level Tap', category: 'pre_trade', enabled: true, order: 1 },
  { ruleId: 'pre-confirmation', label: 'Confluence / Confirmation Entry', category: 'pre_trade', enabled: true, order: 2 },
  { ruleId: 'pre-risk-reward', label: 'Risk-to-Reward Ratio >= 1:2', category: 'pre_trade', enabled: true, order: 3 },
  { ruleId: 'pre-defined-exits', label: 'Stop Loss and Take Profit Defined', category: 'pre_trade', enabled: true, order: 4 },
  { ruleId: 'exec-entry-plan', label: 'Entry as planned', category: 'execution', enabled: true, order: 0 },
  { ruleId: 'exec-stop', label: 'Stop not moved', category: 'execution', enabled: true, order: 1 },
  { ruleId: 'exec-target', label: 'Target respected', category: 'execution', enabled: true, order: 2 },
  { ruleId: 'exec-size', label: 'Position size correct', category: 'execution', enabled: true, order: 3 },
  { ruleId: 'exec-fear', label: 'No manual close out of fear', category: 'execution', enabled: true, order: 4 },
];

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function TradingRulesPage() {
  const router = useRouter();
  const [rules, setRules] = useState<TradingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const loadRules = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    try {
      const response = await fetch('/api/rules', { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load rules');
      setRules(body.rules || []);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load rules');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRules(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRules]);

  const activeCount = useMemo(() => rules.filter(rule => rule.enabled).length, [rules]);

  const update = (ruleId: string, patch: Partial<TradingRule>) => {
    setRules(current => current.map(rule => rule.ruleId === ruleId ? { ...rule, ...patch } : rule));
    setDirty(true);
    setSaved(false);
  };

  const addRule = (category: RuleCategory) => {
    const count = rules.filter(rule => rule.category === category).length;
    setRules(current => [...current, {
      ruleId: newId(), label: '', category, enabled: true, order: count,
    }]);
    setDirty(true);
    setSaved(false);
  };

  const move = (category: RuleCategory, ruleId: string, direction: -1 | 1) => {
    const group = rules.filter(rule => rule.category === category && rule.enabled).sort((a, b) => a.order - b.order);
    const index = group.findIndex(rule => rule.ruleId === ruleId);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= group.length) return;
    const a = group[index];
    const b = group[swapIndex];
    setRules(current => current.map(rule => {
      if (rule.ruleId === a.ruleId) return { ...rule, order: b.order };
      if (rule.ruleId === b.ruleId) return { ...rule, order: a.order };
      return rule;
    }));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    const emptyRule = rules.find(rule => !rule.label.trim());
    if (emptyRule) {
      setError('Give every rule a name before saving.');
      return;
    }
    const token = localStorage.getItem('token');
    if (!token) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rules }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save rules');
      setRules(body.rules || rules);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save rules');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="page-content">
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '36px 24px 64px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap', marginBottom: 28 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <ShieldCheck size={25} color="var(--accent)" />
              <h1 style={{ margin: 0, fontSize: 25, color: 'var(--text-primary)' }}>Trading Rules</h1>
            </div>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.55, maxWidth: 620 }}>
              Build the checklist that defines your edge. Changes apply to future trades; completed trades keep their original rule snapshot.
            </p>
          </div>
          <button className="btn-primary" onClick={save} disabled={saving || !dirty} style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 8 }}>
            {saved ? <Check size={16} /> : <Save size={16} />}
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
          </button>
        </div>

        {error && <div role="alert" style={{ padding: '12px 14px', marginBottom: 18, borderRadius: 10, background: 'var(--red-bg)', border: '1px solid var(--red-border)', color: 'var(--red)', fontSize: 13 }}>{error}</div>}

        <div style={{ padding: '13px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>
          <strong style={{ color: 'var(--text-primary)' }}>{activeCount} active rules.</strong> Archiving a rule removes it from future checklists without changing past trades.
        </div>

        {loading ? (
          <div style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading your rules…</div>
        ) : (
          <div style={{ display: 'grid', gap: 18 }}>
            {(['pre_trade', 'execution'] as RuleCategory[]).map(category => {
              const active = rules.filter(rule => rule.category === category && rule.enabled).sort((a, b) => a.order - b.order);
              const archived = rules.filter(rule => rule.category === category && !rule.enabled);
              return (
                <section key={category} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '22px 22px 18px', boxShadow: 'var(--shadow-card)' }}>
                  <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 16 }}>{CATEGORY_COPY[category].title}</h2>
                  <p style={{ margin: '5px 0 18px', color: 'var(--text-muted)', fontSize: 12.5 }}>{CATEGORY_COPY[category].description}</p>

                  <div style={{ display: 'grid', gap: 9 }}>
                    {active.map((rule, index) => (
                      <div key={rule.ruleId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 8, alignItems: 'center' }}>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span className="sr-only">Rule {index + 1}</span>
                          <input value={rule.label} maxLength={160} onChange={event => update(rule.ruleId, { label: event.target.value })} placeholder="Describe a clear, observable rule" style={{ minHeight: 44, width: '100%', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', padding: '0 12px', fontFamily: 'var(--font-sans)', fontSize: 13 }} />
                        </label>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button aria-label={`Move ${rule.label || 'rule'} up`} title="Move up" disabled={index === 0} onClick={() => move(category, rule.ruleId, -1)} className="icon-btn"><ArrowUp size={15} /></button>
                          <button aria-label={`Move ${rule.label || 'rule'} down`} title="Move down" disabled={index === active.length - 1} onClick={() => move(category, rule.ruleId, 1)} className="icon-btn"><ArrowDown size={15} /></button>
                        </div>
                        <button aria-label={`Archive ${rule.label || 'rule'}`} title="Archive rule" onClick={() => update(rule.ruleId, { enabled: false })} className="icon-btn" style={{ color: 'var(--red)' }}><Trash2 size={15} /></button>
                      </div>
                    ))}
                  </div>

                  <button onClick={() => addRule(category)} style={{ marginTop: 12, minHeight: 44, display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: '1px dashed var(--border)', borderRadius: 9, color: 'var(--accent)', padding: '0 13px', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontWeight: 600 }}>
                    <Plus size={15} /> Add rule
                  </button>

                  {archived.length > 0 && (
                    <details style={{ marginTop: 16 }}>
                      <summary style={{ color: 'var(--text-muted)', fontSize: 12.5, cursor: 'pointer' }}>Archived rules ({archived.length})</summary>
                      <div style={{ display: 'grid', gap: 7, marginTop: 10 }}>
                        {archived.map(rule => (
                          <div key={rule.ruleId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 11px', background: 'var(--bg-elevated)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 12.5 }}>
                            <span>{rule.label}</span>
                            <button onClick={() => update(rule.ruleId, { enabled: true, order: active.length })} style={{ minHeight: 36, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}><RotateCcw size={14} /> Restore</button>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <button onClick={() => { setRules(DEFAULTS.map(rule => ({ ...rule }))); setDirty(true); setSaved(false); }} style={{ marginTop: 18, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', gap: 7 }}>
          <RotateCcw size={14} /> Restore starter rules
        </button>
      </div>
    </main>
  );
}
