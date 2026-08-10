'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Check, ChevronRight, CopyPlus, FileClock, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import InfoHint from '@/components/InfoHint';

type InputType = 'boolean' | 'single_choice' | 'multi_choice' | 'number' | 'rating' | 'text';
type BlockCategory = 'setup' | 'context' | 'entry' | 'risk' | 'execution' | 'custom';

interface PlaybookRule {
  ruleId: string;
  label: string;
  inputType: InputType;
  options: string[];
  required: boolean;
  order?: number;
}

interface PlaybookBlock {
  blockId: string;
  name: string;
  category: BlockCategory;
  rules: PlaybookRule[];
  order?: number;
}

interface PlaybookVersion {
  versionId: string;
  versionNumber: number;
  changeNote: string;
  publishedAt: string;
  blocks: PlaybookBlock[];
}

interface Playbook {
  playbookId: string;
  name: string;
  description: string;
  archived: boolean;
  versions: PlaybookVersion[];
}

const INPUT_LABELS: Record<InputType, string> = {
  boolean: 'Yes / No',
  single_choice: 'Single choice',
  multi_choice: 'Multiple choice',
  number: 'Number',
  rating: 'Rating 1–10',
  text: 'Text',
};

function uid(prefix: string) {
  return `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

function blankBlock(): PlaybookBlock {
  return { blockId: uid('block'), name: 'New block', category: 'custom', rules: [] };
}

function latest(playbook: Playbook) {
  return playbook.versions[playbook.versions.length - 1];
}

function cloneBlocks(blocks: PlaybookBlock[]) {
  return JSON.parse(JSON.stringify(blocks)) as PlaybookBlock[];
}

export default function PlaybooksPage() {
  const router = useRouter();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [blocks, setBlocks] = useState<PlaybookBlock[]>([]);
  const [changeNote, setChangeNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const selectPlaybook = useCallback((playbook: Playbook) => {
    const version = latest(playbook);
    setSelectedId(playbook.playbookId);
    setName(playbook.name);
    setDescription(playbook.description || '');
    setBlocks(cloneBlocks(version?.blocks || []));
    setChangeNote('');
    setCreating(false);
    setDirty(false);
    setSaved(false);
  }, []);

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    try {
      const response = await fetch('/api/playbooks', { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load strategies');
      const loaded = (body.playbooks || []) as Playbook[];
      setPlaybooks(loaded);
      if (loaded.length) selectPlaybook(loaded.find(item => !item.archived) || loaded[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load strategies');
    } finally {
      setLoading(false);
    }
  }, [router, selectPlaybook]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = playbooks.find(item => item.playbookId === selectedId);
  const totalRules = useMemo(() => blocks.reduce((sum, block) => sum + block.rules.length, 0), [blocks]);

  const markDirty = () => { setDirty(true); setSaved(false); };
  const updateBlock = (blockId: string, patch: Partial<PlaybookBlock>) => {
    setBlocks(current => current.map(block => block.blockId === blockId ? { ...block, ...patch } : block));
    markDirty();
  };
  const updateRule = (blockId: string, ruleId: string, patch: Partial<PlaybookRule>) => {
    setBlocks(current => current.map(block => block.blockId === blockId ? {
      ...block, rules: block.rules.map(rule => rule.ruleId === ruleId ? { ...rule, ...patch } : rule),
    } : block));
    markDirty();
  };
  const removeBlock = (blockId: string) => {
    setBlocks(current => current.filter(block => block.blockId !== blockId));
    markDirty();
  };
  const removeRule = (blockId: string, ruleId: string) => {
    setBlocks(current => current.map(block => block.blockId === blockId ? { ...block, rules: block.rules.filter(rule => rule.ruleId !== ruleId) } : block));
    markDirty();
  };
  const addRule = (blockId: string) => {
    setBlocks(current => current.map(block => block.blockId === blockId ? {
      ...block,
      rules: [...block.rules, { ruleId: uid('rule'), label: '', inputType: 'boolean', options: [], required: false }],
    } : block));
    markDirty();
  };

  const startNew = () => {
    setSelectedId('');
    setName('');
    setDescription('');
    setBlocks([blankBlock()]);
    setChangeNote('Initial version');
    setCreating(true);
    setDirty(true);
    setError('');
  };

  const publish = async () => {
    if (!name.trim()) { setError('Give this strategy a name.'); return; }
    if (!blocks.length) { setError('Add at least one block.'); return; }
    if (blocks.some(block => !block.name.trim() || block.rules.some(rule => !rule.label.trim()))) {
      setError('Every block and rule needs a name.'); return;
    }
    const token = localStorage.getItem('token');
    if (!token) return;
    setSaving(true); setError('');
    try {
      const response = await fetch(creating ? '/api/playbooks' : `/api/playbooks/${selectedId}`, {
        method: creating ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, description, blocks, changeNote }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not publish strategy');
      setPlaybooks(current => creating ? [...current, body.playbook] : current.map(item => item.playbookId === body.playbook.playbookId ? body.playbook : item));
      selectPlaybook(body.playbook);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish strategy');
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    if (!selected) return;
    const token = localStorage.getItem('token');
    const response = await fetch(`/api/playbooks/${selected.playbookId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ archived: !selected.archived }),
    });
    const body = await response.json();
    if (!response.ok) { setError(body.error || 'Could not update strategy'); return; }
    setPlaybooks(current => current.map(item => item.playbookId === body.playbook.playbookId ? body.playbook : item));
  };

  return (
    <main className="page-content">
      <div style={{ width: '100%', paddingBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ShieldCheck size={25} color="var(--accent)" />
              <h1 style={{ margin: 0, fontSize: 25 }}>Strategy Playbooks</h1>
              <InfoHint label="What are playbooks?" text="A playbook is your complete trading strategy. It groups setup, context, entry, risk, and execution rules into a version that can be attached to trades and measured by Edge Coach." />
            </div>
            <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 13.5 }}>
              Build flexible strategies. Every publish creates an immutable version for audit and performance comparison.
            </p>
          </div>
          <button className="btn-primary" onClick={publish} disabled={saving || !dirty} style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 8 }}>
            {saved ? <Check size={16} /> : <Save size={16} />}{saving ? 'Publishing…' : saved ? 'Published' : creating ? 'Publish strategy' : 'Publish new version'}
          </button>
        </div>

        {error && <div role="alert" style={{ padding: 12, marginBottom: 16, borderRadius: 10, background: 'var(--red-bg)', border: '1px solid var(--red-border)', color: 'var(--red)' }}>{error}</div>}

        {loading ? <div style={{ padding: 50, textAlign: 'center', color: 'var(--text-muted)' }}>Loading playbooks…</div> : (
          <div className="playbook-layout">
            <aside style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 12, position: 'sticky', top: 24 }}>
              <button onClick={startNew} style={{ width: '100%', minHeight: 44, border: '1px dashed var(--accent)', borderRadius: 9, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontWeight: 700 }}><Plus size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />New strategy</button>
              <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                {playbooks.map(playbook => (
                  <button key={playbook.playbookId} onClick={() => selectPlaybook(playbook)} style={{ minHeight: 52, padding: '8px 10px', textAlign: 'left', borderRadius: 9, border: `1px solid ${selectedId === playbook.playbookId ? 'var(--accent)' : 'transparent'}`, background: selectedId === playbook.playbookId ? 'var(--accent-soft)' : 'transparent', color: playbook.archived ? 'var(--text-muted)' : 'var(--text-primary)', cursor: 'pointer' }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontWeight: 700 }}>{playbook.name}<ChevronRight size={14} /></span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>v{latest(playbook)?.versionNumber || 0} · {playbook.archived ? 'Archived' : 'Active'}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div style={{ display: 'grid', gap: 16 }}>
              <section style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
                <div className="playbook-header-grid">
                  <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}><span>Strategy name<InfoHint text="Use a distinct name for the setup you want to measure, such as London ORB or FVG Continuation." /></span><input value={name} onChange={e => { setName(e.target.value); markDirty(); }} placeholder="e.g. London ORB" style={{ minHeight: 44, border: '1px solid var(--border)', borderRadius: 9, padding: '0 12px', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }} /></label>
                  <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}>Description<input value={description} onChange={e => { setDescription(e.target.value); markDirty(); }} placeholder="When and why this strategy applies" style={{ minHeight: 44, border: '1px solid var(--border)', borderRadius: 9, padding: '0 12px', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }} /></label>
                </div>
                {!creating && selected && (
                  <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                    <FileClock size={14} /> Version {latest(selected)?.versionNumber} · {selected.versions.length} immutable version{selected.versions.length === 1 ? '' : 's'} · {totalRules} rules <InfoHint text="Published versions cannot be overwritten. Existing trades retain the exact rules they used, while new trades use the newest published version." />
                    <button onClick={toggleArchive} style={{ marginLeft: 'auto', minHeight: 36, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 10px' }}><Archive size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />{selected.archived ? 'Restore' : 'Archive strategy'}</button>
                  </div>
                )}
              </section>

              {blocks.map(block => (
                <section key={block.blockId} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
                  <div className="playbook-block-header">
                    <label style={{ display: 'grid', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}><span>Block name<InfoHint text="Blocks organize related evidence, for example Market Context, Location, Entry Confirmation, Risk, or Execution." /></span><input value={block.name} onChange={e => updateBlock(block.blockId, { name: e.target.value })} style={{ minHeight: 42, border: '1px solid var(--border)', borderRadius: 8, padding: '0 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontWeight: 700 }} /></label>
                    <label style={{ display: 'grid', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>Category<select value={block.category} onChange={e => updateBlock(block.blockId, { category: e.target.value as BlockCategory })} style={{ minHeight: 42, border: '1px solid var(--border)', borderRadius: 8, padding: '0 8px', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>{(['setup', 'context', 'entry', 'risk', 'execution', 'custom'] as BlockCategory[]).map(item => <option key={item} value={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
                    <button onClick={() => removeBlock(block.blockId)} disabled={blocks.length === 1} aria-label={`Remove ${block.name}`} className="icon-btn" style={{ color: 'var(--red)', minWidth: 42, minHeight: 42 }}><Trash2 size={15} /></button>
                  </div>

                  <div style={{ display: 'grid', gap: 9 }}>
                    {block.rules.map((rule, ruleIndex) => (
                      <div key={rule.ruleId} className="playbook-rule-row">
                        <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}>Rule {ruleIndex + 1}<input value={rule.label} onChange={e => updateRule(block.blockId, rule.ruleId, { label: e.target.value })} placeholder="Observable condition" style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, padding: '0 9px', background: 'var(--bg-surface)', color: 'var(--text-primary)' }} /></label>
                        <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}><span>Answer type<InfoHint text="Choose how this evidence is recorded on a trade. Structured answers such as Yes/No and choices are easiest for Edge Coach to compare." /></span><select value={rule.inputType} onChange={e => updateRule(block.blockId, rule.ruleId, { inputType: e.target.value as InputType, options: [] })} style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 7px' }}>{(Object.keys(INPUT_LABELS) as InputType[]).map(type => <option key={type} value={type}>{INPUT_LABELS[type]}</option>)}</select></label>
                        {['single_choice', 'multi_choice'].includes(rule.inputType) ? <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}>Choices<input value={rule.options.join(', ')} onChange={e => updateRule(block.blockId, rule.ruleId, { options: e.target.value.split(',').map(item => item.trim()).filter(Boolean) })} placeholder="A, B, C" style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, padding: '0 9px', background: 'var(--bg-surface)', color: 'var(--text-primary)' }} /></label> : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{INPUT_LABELS[rule.inputType]}</span>}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}><input type="checkbox" checked={rule.required} onChange={e => updateRule(block.blockId, rule.ruleId, { required: e.target.checked })} />Required</label>
                        <button onClick={() => removeRule(block.blockId, rule.ruleId)} aria-label={`Remove ${rule.label || 'rule'} from next version`} className="icon-btn" style={{ color: 'var(--red)' }}><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => addRule(block.blockId)} style={{ marginTop: 10, minHeight: 40, border: '1px dashed var(--border)', borderRadius: 8, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '0 12px' }}><Plus size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />Add rule</button>
                </section>
              ))}

              <button onClick={() => { setBlocks(current => [...current, blankBlock()]); markDirty(); }} style={{ minHeight: 48, border: '1px dashed var(--accent)', borderRadius: 12, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontWeight: 700 }}><CopyPlus size={16} style={{ verticalAlign: 'middle', marginRight: 7 }} />Add playbook block</button>

              <section style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
                <label style={{ display: 'grid', gap: 5, color: 'var(--text-muted)', fontSize: 12 }}><span>What changed in this version?<InfoHint text="This note creates an audit trail explaining why the strategy changed, making before-and-after performance easier to interpret." /></span><input value={changeNote} onChange={e => { setChangeNote(e.target.value); markDirty(); }} placeholder="e.g. Added Order Block location requirement" style={{ minHeight: 44, border: '1px solid var(--border)', borderRadius: 8, padding: '0 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }} /></label>
                <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 11 }}>Publishing never overwrites old versions. Trades already using a version keep their exact snapshot.</p>
              </section>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
