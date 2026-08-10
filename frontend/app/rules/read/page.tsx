'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, BookOpen, FileClock, ShieldCheck } from 'lucide-react';

interface Evidence { evidenceId: string; url: string; caption: string; kind: 'reference' | 'valid' | 'invalid'; linkedRuleId?: string }
interface Rule { ruleId: string; label: string; inputType: string; required: boolean; helpText?: string; unit?: string; options?: string[]; examples?: Evidence[]; exampleRequirement?: { required: boolean; minimumImages: number; maximumImages: number } }
interface Block { blockId: string; name: string; category: string; rules: Rule[]; evidence?: Evidence[] }
interface Version { versionId: string; versionNumber: number; schemaVersion?: number; changeNote: string; publishedAt: string; blocks: Block[] }
interface Playbook { playbookId: string; name: string; description: string; archived: boolean; versions: Version[] }

const CATEGORY_LABELS: Record<string, string> = {
  concept: 'Strategy concept', context: 'Market context', setup: 'Setup and location', entry: 'Entry confirmation',
  risk: 'Risk plan', execution: 'Execution', management: 'Trade management', exit: 'Exit', review: 'Post-trade review', custom: 'Custom stage',
};

export default function ReadPlaybookPage() {
  const router = useRouter();
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [versionId, setVersionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { router.push('/login'); return; }
    try {
      const requestedId = new URLSearchParams(window.location.search).get('playbook');
      const response = await fetch('/api/playbooks', { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load playbook');
      const selected = (body.playbooks as Playbook[]).find(item => item.playbookId === requestedId);
      if (!selected) throw new Error('Playbook not found');
      setPlaybook(selected);
      setVersionId(selected.versions[selected.versions.length - 1]?.versionId || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load playbook');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const version = useMemo(() => playbook?.versions.find(item => item.versionId === versionId) || null, [playbook, versionId]);

  if (loading) return <main className="playbook-reader-state">Opening playbook…</main>;
  if (error || !playbook || !version) return <main className="playbook-reader-state"><strong>{error || 'Published version not found'}</strong><button className="btn-ghost" onClick={() => router.push('/rules')}>Return to Playbooks</button></main>;

  return (
    <main className="playbook-reader">
      <header id="playbook-top" className="playbook-reader-cover">
        <button className="playbook-reader-back" onClick={() => router.push('/rules')}><ArrowLeft size={15} />Back to editor</button>
        <div className="playbook-reader-kicker"><ShieldCheck size={16} />Published strategy manual</div>
        <h1>{playbook.name}</h1>
        <p>{playbook.description || 'A structured trading playbook from conception through post-trade review.'}</p>
        <div className="playbook-reader-version">
          <FileClock size={15} />
          <label>Reading version
            <select value={versionId} onChange={event => setVersionId(event.target.value)}>
              {[...playbook.versions].reverse().map(item => <option key={item.versionId} value={item.versionId}>Version {item.versionNumber} · {new Date(item.publishedAt).toLocaleDateString()}</option>)}
            </select>
          </label>
          <span>Schema {version.schemaVersion || 1} · {version.changeNote}</span>
        </div>
      </header>

      <div className="playbook-reader-layout">
        <aside className="playbook-reader-toc">
          <div><BookOpen size={15} />Contents</div>
          {version.blocks.map((block, index) => <a key={block.blockId} href={`#chapter-${block.blockId}`}><span>{index + 1}</span>{block.name}</a>)}
        </aside>

        <article className="playbook-reader-book">
          {version.blocks.map((block, index) => (
            <section id={`chapter-${block.blockId}`} key={block.blockId} className="playbook-reader-chapter">
              <div className="playbook-reader-chapter-heading">
                <span>Chapter {index + 1}</span>
                <small>{CATEGORY_LABELS[block.category] || CATEGORY_LABELS.custom}</small>
                <h2>{block.name}</h2>
              </div>

              {(block.evidence || []).length > 0 && <div className="playbook-reader-gallery">
                {(block.evidence || []).map(item => <figure key={item.evidenceId} className={`playbook-reader-figure ${item.kind}`}>
                  {/* Cloudinary and local evidence URLs are user-configured, so native images are intentionally used. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt={item.caption} />
                  <figcaption><strong>{item.kind === 'valid' ? 'Valid example' : item.kind === 'invalid' ? 'Invalid example' : 'Reference'}</strong>{item.caption}</figcaption>
                </figure>)}
              </div>}

              <div className="playbook-reader-rules">
                {block.rules.map((rule, ruleIndex) => <div key={rule.ruleId} className="playbook-reader-rule">
                  <span>{String(ruleIndex + 1).padStart(2, '0')}</span>
                  <div><h3>{rule.label}{rule.required && <em>Required</em>}</h3>{rule.helpText && <p>{rule.helpText}</p>}{rule.options && rule.options.length > 0 && <div className="playbook-reader-options">{rule.options.map(option => <span key={option}>{option}</span>)}</div>}
                    {(rule.examples || []).length > 0 && <div className="playbook-reader-rule-examples">{(rule.examples || []).map(example => <figure key={example.evidenceId} className={example.kind}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={example.url} alt={example.caption} />
                      <figcaption><strong>{example.kind === 'valid' ? 'Valid' : example.kind === 'invalid' ? 'Invalid' : 'Reference'}</strong>{example.caption}</figcaption>
                    </figure>)}</div>}
                  </div>
                  <small>{rule.inputType.replaceAll('_', ' ')}{rule.unit ? ` · ${rule.unit}` : ''}</small>
                </div>)}
              </div>

              <nav className="playbook-reader-chapter-nav">
                {index > 0 ? <a href={`#chapter-${version.blocks[index - 1].blockId}`}><ArrowLeft size={14} />Previous chapter</a> : <span />}
                {index < version.blocks.length - 1 ? <a href={`#chapter-${version.blocks[index + 1].blockId}`}>Next chapter<ArrowRight size={14} /></a> : <a href="#playbook-top">Return to top<ArrowRight size={14} /></a>}
              </nav>
            </section>
          ))}
        </article>
      </div>
    </main>
  );
}
