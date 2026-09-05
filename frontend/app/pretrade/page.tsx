'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ClipboardList, Save, Trash2 } from 'lucide-react';
import PlaybookRuleInput from '@/components/PlaybookRuleInput';
import PreTradeChart, { type ChartAnnotation } from '@/components/PreTradeChart';
import type { PlaybookSnapshot } from '@/types/playbook';
import { PLAN_PHASE_CATEGORIES } from '@/types/playbook';

interface PreTradeAnalysis {
  _id: string;
  playbookId: string;
  playbookVersionId: string;
  playbookSnapshot: PlaybookSnapshot;
  responses: Record<string, unknown>;
  symbol: string;
  direction: 'long' | 'short' | '';
  notes: string;
  status: 'open' | 'linked' | 'archived';
  chartSymbol?: string;
  chartInterval?: string;
  chartAnnotations?: ChartAnnotation[];
}

function PreTradeAnalysisContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get('id');

  const [analysis, setAnalysis] = useState<PreTradeAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState('');

  const [symbol, setSymbol] = useState('');
  const [direction, setDirection] = useState<'long' | 'short' | ''>('');
  const [notes, setNotes] = useState('');
  const [responses, setResponses] = useState<Record<string, unknown>>({});
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/api/pre-trade-analyses/symbols', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.ok ? res.json() : { symbols: [] })
      .then(data => setAvailableSymbols(Array.isArray(data.symbols) ? data.symbols : []))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!id) { setError('No pre-trade analysis specified.'); setLoading(false); return; }
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    try {
      const res = await fetch(`/api/pre-trade-analyses/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load pre-trade analysis');
      setAnalysis(data);
      setSymbol(data.symbol || '');
      setDirection(data.direction || '');
      setNotes(data.notes || '');
      setResponses(data.responses || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pre-trade analysis');
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { void load(); }, [load]);

  const setResponse = (ruleId: string, value: unknown) => {
    setResponses(current => ({ ...current, [ruleId]: value }));
  };

  const handleSave = async () => {
    if (!analysis) return;
    setSaving(true);
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    try {
      const res = await fetch(`/api/pre-trade-analyses/${analysis._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ symbol, direction, notes, responses }),
      });
      if (res.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      setAnalysis(data);
      setSaveState('Saved');
      setTimeout(() => setSaveState(''), 1800);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    if (!analysis) return;
    if (!confirm('Discard this pre-trade analysis? This cannot be undone.')) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const res = await fetch(`/api/pre-trade-analyses/${analysis._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Could not discard');
      }
      router.push('/rules');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not discard');
    }
  };

  if (loading) return <div className="loading-wrap"><div className="spinner" /></div>;
  if (error || !analysis) return <div className="empty-state"><p>{error || 'Not found'}</p></div>;

  const planBlocks = analysis.playbookSnapshot.blocks.filter(block => PLAN_PHASE_CATEGORIES.includes(block.category));

  return (
    <main className="page-content">
      <header className="page-header">
        <div className="page-header-inner">
          <div>
            <h2><ClipboardList size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Pre-Trade Analysis</h2>
            <p>{analysis.playbookSnapshot.name} · v{analysis.playbookSnapshot.versionNumber}</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-danger" onClick={handleDiscard}><Trash2 size={15} /> Discard</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={15} /> {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </header>

      {saveState && <div className="account-alert success" aria-live="polite">{saveState}</div>}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Symbol</span>
            <input type="text" list="pretrade-symbol-options" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="e.g. XAUUSD" style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />
            <datalist id="pretrade-symbol-options">
              {availableSymbols.map(s => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Direction</span>
            <select value={direction} onChange={e => setDirection(e.target.value as 'long' | 'short' | '')} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }}>
              <option value="">Not set</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
        </div>
      </div>

      <PreTradeChart
        analysisId={analysis._id}
        symbol={symbol}
        initialInterval={analysis.chartInterval}
        initialAnnotations={analysis.chartAnnotations || []}
      />

      {planBlocks.length === 0 && (
        <div className="empty-state"><p>This playbook has no Plan-phase blocks (concept/context/setup/entry/risk).</p></div>
      )}

      {planBlocks.map(block => (
        <div key={block.blockId} className="journal-playbook-stage">
          <div className="journal-playbook-stage-title"><strong>{block.name}</strong></div>
          <div style={{ display: 'grid', gap: 10 }}>
            {block.rules.map(rule => (
              <div key={rule.ruleId} style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rule.label}{rule.required ? ' *' : ''}</span>
                <div className="journal-rule-context"><span>{rule.timeframes?.length ? rule.timeframes.join(' · ') : 'All timeframes'}</span></div>
                {rule.helpText && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>{rule.helpText}</span>}
                <PlaybookRuleInput rule={rule} value={responses[rule.ruleId]} onChange={value => setResponse(rule.ruleId, value)} />
                {rule.exampleRequirement?.required && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    Screenshot confirmation for this rule will be requested once this is inherited into a real trade.
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="drawer-section" style={{ marginTop: 4 }}>
        <span className="drawer-section-title">Notes</span>
        <textarea
          className="drawer-textarea"
          placeholder="Anything else about this setup worth remembering..."
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />
      </div>
    </main>
  );
}

export default function PreTradeAnalysisPage() {
  return <Suspense fallback={<div className="loading-wrap"><div className="spinner" /></div>}><PreTradeAnalysisContent /></Suspense>;
}
