'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, CopyPlus, FileClock, ImagePlus, Plus, Save, Settings2, ShieldCheck, Trash2, X } from 'lucide-react';
import InfoHint from '@/components/InfoHint';

type InputType = 'boolean' | 'single_choice' | 'multi_choice' | 'number' | 'percentage' | 'currency' | 'price' | 'duration' | 'risk_reward' | 'rating' | 'text' | 'long_text' | 'date' | 'time';
type PrimitiveInputType = 'boolean' | 'number' | 'text' | 'single_choice' | 'multi_choice';
type BlockCategory = 'concept' | 'context' | 'setup' | 'entry' | 'risk' | 'execution' | 'management' | 'exit' | 'review' | 'custom';
type RuleToolRole = 'observation' | 'confirmation' | 'trigger' | 'decision_gate' | 'invalidation' | 'risk_limit' | 'management_action' | 'exit_signal' | 'review_prompt';
type RuleFailureAction = 'none' | 'warn' | 'skip_trade' | 'stop_session';

interface PlaybookRule {
  ruleId: string;
  label: string;
  inputType: InputType;
  options: string[];
  required: boolean;
  helpText?: string;
  placeholder?: string;
  unit?: string;
  defaultValue?: string | number | boolean | null;
  validation?: {
    min?: number | null;
    max?: number | null;
    minLength?: number | null;
    maxLength?: number | null;
  };
  examples?: PlaybookEvidence[];
  exampleRequirement?: { required: boolean; minimumImages: number; maximumImages: number };
  toolRole?: RuleToolRole;
  timeframes?: string[];
  failureAction?: RuleFailureAction;
  failureMessage?: string;
  order?: number;
}

interface PlaybookBlock {
  blockId: string;
  name: string;
  category: BlockCategory;
  rules: PlaybookRule[];
  evidence?: PlaybookEvidence[];
  order?: number;
}

interface PlaybookEvidence {
  evidenceId: string;
  url: string;
  publicId: string;
  caption: string;
  kind: 'reference' | 'valid' | 'invalid';
  linkedRuleId?: string;
  uploadedAt: string;
  order?: number;
}

interface PlaybookVersion {
  versionId: string;
  versionNumber: number;
  schemaVersion?: number;
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
  percentage: 'Percentage',
  currency: 'Currency amount',
  price: 'Price',
  duration: 'Duration',
  risk_reward: 'Risk-to-reward',
  rating: 'Rating 1–10',
  text: 'Short text',
  long_text: 'Long explanation',
  date: 'Date',
  time: 'Time',
};

const PRIMITIVE_INPUT_LABELS: Record<PrimitiveInputType, string> = {
  boolean: 'Yes / No',
  number: 'Number',
  text: 'Text',
  single_choice: 'Single choice',
  multi_choice: 'Multiple choice',
};
const NUMBER_FORMATS: InputType[] = ['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward', 'rating'];
const TEXT_FORMATS: InputType[] = ['text', 'long_text', 'date', 'time'];
const RULE_TOOL_ROLES: Array<{ value: RuleToolRole; label: string; description: string }> = [
  { value: 'observation', label: 'Observation', description: 'Record context without deciding whether the trade is valid.' },
  { value: 'confirmation', label: 'Confirmation', description: 'Evidence that supports the setup or execution.' },
  { value: 'trigger', label: 'Entry trigger', description: 'The precise event that authorizes an entry.' },
  { value: 'decision_gate', label: 'Decision gate', description: 'A condition that must pass before the strategy continues.' },
  { value: 'invalidation', label: 'Invalidation', description: 'A condition that makes the setup or trade invalid.' },
  { value: 'risk_limit', label: 'Risk limit', description: 'A threshold that protects trade or session risk.' },
  { value: 'management_action', label: 'Management action', description: 'An action to take while the position is open.' },
  { value: 'exit_signal', label: 'Exit signal', description: 'A condition that calls for reducing or closing the position.' },
  { value: 'review_prompt', label: 'Review prompt', description: 'A question that captures a lesson after the trade.' },
];
const RULE_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
const FAILURE_ACTIONS: Array<{ value: RuleFailureAction; label: string }> = [
  { value: 'none', label: 'Record only' },
  { value: 'warn', label: 'Show a warning' },
  { value: 'skip_trade', label: 'Mark setup as skipped' },
  { value: 'stop_session', label: 'Stop the trading session' },
];

function primitiveInputType(inputType: InputType): PrimitiveInputType {
  if (NUMBER_FORMATS.includes(inputType)) return 'number';
  if (TEXT_FORMATS.includes(inputType)) return 'text';
  return inputType as PrimitiveInputType;
}

const BLOCK_CATEGORIES: Array<{ value: BlockCategory; label: string; description: string }> = [
  { value: 'concept', label: '1. Strategy concept', description: 'The thesis, markets, sessions, and conditions behind the edge.' },
  { value: 'context', label: '2. Market context', description: 'Bias, regime, liquidity, key levels, and higher-timeframe evidence.' },
  { value: 'setup', label: '3. Setup & location', description: 'Where the opportunity must form and what makes the location valid.' },
  { value: 'entry', label: '4. Entry confirmation', description: 'The precise trigger that authorizes the trade.' },
  { value: 'risk', label: '5. Risk plan', description: 'Position sizing, stop placement, targets, and risk limits.' },
  { value: 'execution', label: '6. Execution', description: 'How the order must be placed and verified.' },
  { value: 'management', label: '7. Trade management', description: 'Break-even, partials, trailing, and intervention rules.' },
  { value: 'exit', label: '8. Exit', description: 'Valid reasons and conditions for terminating the trade.' },
  { value: 'review', label: '9. Post-trade review', description: 'Outcome, execution quality, lessons, and revision evidence.' },
  { value: 'custom', label: 'Custom stage', description: 'A user-defined stage outside the standard lifecycle.' },
];

type TemplateCategory = Exclude<BlockCategory, 'custom'>;
type TemplateRule = Omit<PlaybookRule, 'ruleId'>;

const templateRule = (label: string, inputType: InputType, helpText: string, extra: Partial<TemplateRule> = {}): TemplateRule => ({
  label, inputType, helpText, options: [], required: false, placeholder: '', unit: '', defaultValue: null, validation: {}, examples: [], exampleRequirement: { required: false, minimumImages: 0, maximumImages: 6 }, toolRole: 'observation', timeframes: [], failureAction: 'none', failureMessage: '', ...extra,
});

const CATEGORY_TEMPLATES: Record<TemplateCategory, { name: string; rules: TemplateRule[] }> = {
  concept: { name: 'Strategy concept', rules: [
    templateRule('Strategy thesis', 'text', 'Explain why this edge should exist and the behavior it is designed to exploit.', { required: true, validation: { minLength: 20 } }),
    templateRule('Suitable markets', 'multi_choice', 'Select the instruments where this strategy has been tested.', { options: ['Forex', 'Indices', 'Futures', 'Crypto', 'Stocks'] }),
    templateRule('When should this strategy be avoided?', 'text', 'Document conditions where this playbook should remain inactive.'),
  ] },
  context: { name: 'Market context', rules: [
    templateRule('Higher-timeframe bias', 'single_choice', 'Record the directional context before looking for an entry.', { required: true, options: ['Bullish', 'Bearish', 'Neutral'] }),
    templateRule('Market condition', 'single_choice', 'Classify the current market regime.', { options: ['Trending', 'Ranging', 'Expanding', 'Consolidating'] }),
    templateRule('Key context evidence', 'text', 'Describe the liquidity, level, session, or narrative visible on the chart.', { required: true }),
  ] },
  setup: { name: 'Setup and location', rules: [
    templateRule('Setup location', 'multi_choice', 'Select every location feature present before the trigger.', { required: true, options: ['Order Block', 'Fair Value Gap', 'Breaker', 'Key Level', 'Premium / Discount'] }),
    templateRule('Liquidity swept', 'boolean', 'Confirm whether the required liquidity was taken.'),
    templateRule('What invalidates this setup?', 'text', 'Describe the price action that makes the setup unacceptable.', { required: true }),
  ] },
  entry: { name: 'Entry confirmation', rules: [
    templateRule('Entry trigger', 'multi_choice', 'Record the confirmations that authorized entry.', { required: true, options: ['Market Structure Shift', 'Displacement', 'FVG Formation', 'Retest', 'Candle Confirmation'] }),
    templateRule('Entry timeframe', 'single_choice', 'Select the timeframe used to execute.', { required: true, options: ['1m', '5m', '15m', '30m', '1h'] }),
    templateRule('Entry matched the model', 'boolean', 'Confirm that entry occurred only after the documented trigger.', { required: true }),
  ] },
  risk: { name: 'Risk plan', rules: [
    templateRule('Planned risk', 'percentage', 'Enter the percentage of account equity planned for this trade.', { required: true, unit: '%', validation: { min: 0, max: 100 } }),
    templateRule('Minimum risk-to-reward', 'risk_reward', 'Enter the minimum reward multiple required, for example 2 for 1:2.', { required: true, unit: 'R', validation: { min: 0 } }),
    templateRule('Stop and target defined', 'boolean', 'Confirm both invalidation and profit objectives were defined before entry.', { required: true }),
  ] },
  execution: { name: 'Execution', rules: [
    templateRule('Entry executed as planned', 'boolean', 'Confirm price, order type, and timing matched the plan.', { required: true }),
    templateRule('Position size correct', 'boolean', 'Confirm the order used the planned risk and account size.', { required: true }),
    templateRule('Execution notes', 'text', 'Record slippage, delay, or any difference between the plan and fill.'),
  ] },
  management: { name: 'Trade management', rules: [
    templateRule('Management method', 'single_choice', 'Select the management plan used after entry.', { options: ['Fixed stop and target', 'Break-even', 'Partial profits', 'Trailing stop', 'Time-based'] }),
    templateRule('Manual intervention followed the plan', 'boolean', 'Confirm every adjustment was explicitly allowed by the playbook.', { required: true }),
    templateRule('Management notes', 'text', 'Explain stop movement, partials, or intervention decisions.'),
  ] },
  exit: { name: 'Exit', rules: [
    templateRule('Exit reason', 'single_choice', 'Record the event that terminated the trade.', { required: true, options: ['Target reached', 'Stop reached', 'Invalidation', 'Time-based exit', 'Manual close'] }),
    templateRule('Realized result', 'number', 'Record the final result as an R multiple; losses may be negative.', { unit: 'R' }),
    templateRule('Exit followed the playbook', 'boolean', 'Confirm the final exit complied with the documented plan.', { required: true }),
  ] },
  review: { name: 'Post-trade review', rules: [
    templateRule('Execution quality', 'rating', 'Rate how closely the complete trade followed the plan.', { required: true }),
    templateRule('Main lesson', 'text', 'Write the most important repeatable lesson from this trade.', { required: true, validation: { minLength: 10 } }),
    templateRule('Does the playbook need revision?', 'boolean', 'Separate a strategy problem from a one-off execution mistake.'),
  ] },
};

function uid(prefix: string) {
  return `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

function blankBlock(): PlaybookBlock {
  return { blockId: uid('block'), name: 'New stage', category: 'custom', rules: [], evidence: [] };
}

function blockFromTemplate(category: TemplateCategory): PlaybookBlock {
  const template = CATEGORY_TEMPLATES[category];
  return {
    blockId: uid('block'),
    name: template.name,
    category,
    evidence: [],
    rules: template.rules.map(rule => ({ ...cloneRule(rule), ruleId: uid('rule') })),
  };
}

function cloneRule(rule: TemplateRule): TemplateRule {
  return JSON.parse(JSON.stringify(rule)) as TemplateRule;
}

function latest(playbook: Playbook) {
  return playbook.versions[playbook.versions.length - 1];
}

function cloneBlocks(blocks: PlaybookBlock[]) {
  const legacyCategories: Record<string, BlockCategory> = { pre_trade: 'setup', post_trade: 'review', trade_management: 'management' };
  return (JSON.parse(JSON.stringify(blocks)) as PlaybookBlock[]).map(block => ({
    ...block,
    category: legacyCategories[block.category] || block.category || 'custom',
    rules: block.rules.map(rule => ({
      ...rule,
      examples: rule.examples || [],
      exampleRequirement: rule.exampleRequirement || { required: false, minimumImages: 0, maximumImages: 6 },
      toolRole: rule.toolRole || 'observation',
      timeframes: rule.timeframes || [],
      failureAction: rule.failureAction || 'none',
      failureMessage: rule.failureMessage || '',
    })),
  }));
}

function blockIsReady(block: PlaybookBlock) {
  return block.rules.length > 0
    && block.rules.every(rule => rule.label.trim())
    && (block.evidence || []).every(item => item.caption.trim().length >= 10);
}

function blockEvidenceCount(block: PlaybookBlock) {
  return (block.evidence || []).length + block.rules.reduce((total, rule) => total + (rule.examples || []).length, 0);
}

function ChoiceOptionsInput({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) {
  // Keep the text being edited separate from the normalized array. Parsing the
  // controlled value directly removed a trailing comma immediately, making it
  // impossible to type the next choice.
  const [draft, setDraft] = useState(() => options.join(', '));

  return (
    <input
      value={draft}
      onChange={event => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        onChange(nextDraft.split(',').map(item => item.trim()).filter(Boolean));
      }}
      placeholder="A, B, C"
      style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, padding: '0 9px', background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    />
  );
}

function optionalNumber(value: string) {
  return value === '' ? null : Number(value);
}

function FieldDetails({ rule, onChange }: { rule: PlaybookRule; onChange: (patch: Partial<PlaybookRule>) => void }) {
  const validation = rule.validation || {};
  const inputStyle = { minHeight: 38, width: '100%', border: '1px solid var(--border)', borderRadius: 7, padding: '0 9px', background: 'var(--bg-surface)', color: 'var(--text-primary)' };
  const labelStyle = { display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' };

  return (
    <div className="playbook-field-details">
      <div className="playbook-advanced-section-heading">
        <strong>Guidance and validation</strong>
        <span>Optional instructions and limits shown when this rule is completed.</span>
      </div>
      <div className="playbook-field-details-grid">
        <label style={{ ...labelStyle, gridColumn: 'span 2' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Help text
            <InfoHint text="Shown to the trader right under this question while they're completing the journal — use it to explain what counts as good evidence or how to judge the answer." />
          </span>
          <input value={rule.helpText || ''} onChange={event => onChange({ helpText: event.target.value })} placeholder="Explain what evidence the trader should record" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Input placeholder
            <InfoHint text="Faint example text shown inside the empty answer field itself (not saved as the answer) — use it to model what a good response looks like." />
          </span>
          <input value={rule.placeholder || ''} onChange={event => onChange({ placeholder: event.target.value })} placeholder="Example answer or instruction" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Unit
            <InfoHint text="Only for Number-type answers (Percentage, Currency, Price, Duration, R:R, Rating). It's a label appended after whatever number the trader types — e.g. entering '15' with unit 'points' displays as '15 points'. Purely cosmetic; it doesn't convert or validate the value." />
          </span>
          <input value={rule.unit || ''} onChange={event => onChange({ unit: event.target.value })} placeholder="%, USD, points, R…" style={inputStyle} />
        </label>
        {['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward'].includes(rule.inputType) && <>
          <label style={labelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Minimum
              <InfoHint text="Smallest number the trader is allowed to enter for this answer. Leave blank for no lower limit." />
            </span>
            <input type="number" value={validation.min ?? ''} onChange={event => onChange({ validation: { ...validation, min: optionalNumber(event.target.value) } })} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Maximum
              <InfoHint text="Largest number the trader is allowed to enter for this answer. Leave blank for no upper limit." />
            </span>
            <input type="number" value={validation.max ?? ''} onChange={event => onChange({ validation: { ...validation, max: optionalNumber(event.target.value) } })} style={inputStyle} />
          </label>
        </>}
        {['text', 'long_text'].includes(rule.inputType) && <>
          <label style={labelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Minimum characters
              <InfoHint text="Shortest answer length (in characters) accepted for this text field. Use it to stop one-word non-answers on rules that need real explanation." />
            </span>
            <input type="number" min="0" value={validation.minLength ?? ''} onChange={event => onChange({ validation: { ...validation, minLength: optionalNumber(event.target.value) } })} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Maximum characters
              <InfoHint text="Longest answer length (in characters) accepted for this text field." />
            </span>
            <input type="number" min="1" value={validation.maxLength ?? ''} onChange={event => onChange({ validation: { ...validation, maxLength: optionalNumber(event.target.value) } })} style={inputStyle} />
          </label>
        </>}
        {(rule.exampleRequirement?.required || false) && <>
          <label style={labelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Minimum trade screenshots
              <InfoHint text="How many screenshots FROM THE ACTUAL TRADE the trader must attach to this rule before it counts as answered — this is evidence proving they actually checked, not the optional teaching examples above." />
            </span>
            <input type="number" min="1" max="12" value={rule.exampleRequirement?.minimumImages || 1} onChange={event => onChange({ exampleRequirement: { required: true, minimumImages: Number(event.target.value) || 1, maximumImages: rule.exampleRequirement?.maximumImages || 6 } })} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Maximum trade screenshots
              <InfoHint text="Upper limit on how many trade screenshots can be attached to this rule, so the journal doesn't balloon with unlimited uploads." />
            </span>
            <input type="number" min="1" max="12" value={rule.exampleRequirement?.maximumImages || 6} onChange={event => onChange({ exampleRequirement: { required: true, minimumImages: rule.exampleRequirement?.minimumImages || 1, maximumImages: Number(event.target.value) || 6 } })} style={inputStyle} />
          </label>
        </>}
      </div>
    </div>
  );
}

function BlockEvidenceEditor({ block, onChange, onError }: { block: PlaybookBlock; onChange: (evidence: PlaybookEvidence[]) => void; onError: (message: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const evidence = block.evidence || [];

  const upload = async (file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { onError('Use a PNG, JPEG, or WebP screenshot.'); return; }
    if (file.size > 10 * 1024 * 1024) { onError('Screenshot must be smaller than 10 MB.'); return; }
    setUploading(true); onError('');
    try {
      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read screenshot'));
        reader.readAsDataURL(file);
      });
      const token = localStorage.getItem('token');
      const response = await fetch('/api/playbooks/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageData, kind: 'reference' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not upload screenshot');
      onChange([...evidence, { ...body.evidence, order: evidence.length }]);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not upload screenshot');
    } finally {
      setUploading(false);
    }
  };

  const updateEvidence = (evidenceId: string, patch: Partial<PlaybookEvidence>) => onChange(evidence.map(item => item.evidenceId === evidenceId ? { ...item, ...patch } : item));
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= evidence.length) return;
    const next = [...evidence];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((item, order) => ({ ...item, order })));
  };

  return (
    <div className="playbook-evidence-editor">
      <div className="playbook-evidence-heading">
        <div><strong>Visual evidence</strong><span>Add the chart examples a trader must recognize at this stage.</span></div>
        <label className={`btn-ghost playbook-evidence-upload${uploading ? ' disabled' : ''}`}>
          <ImagePlus size={14} />{uploading ? 'Uploading…' : 'Add screenshot'}
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
        </label>
      </div>
      {evidence.length === 0 ? <div className="playbook-evidence-empty">No screenshots yet. Add a reference, valid example, or invalid example.</div> : (
        <div className="playbook-evidence-grid">
          {evidence.map((item, index) => (
            <article key={item.evidenceId} className="playbook-evidence-card">
              {/* Draft evidence may use Cloudinary or local URLs, so a native image preserves both sources. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.url} alt={item.caption || `${block.name} ${item.kind} example`} />
              <div className="playbook-evidence-card-fields">
                <select value={item.kind} onChange={event => updateEvidence(item.evidenceId, { kind: event.target.value as PlaybookEvidence['kind'] })}>
                  <option value="reference">Reference</option><option value="valid">Valid example</option><option value="invalid">Invalid example</option>
                </select>
                <select value={item.linkedRuleId || ''} onChange={event => updateEvidence(item.evidenceId, { linkedRuleId: event.target.value })}>
                  <option value="">Whole stage</option>{block.rules.map(rule => <option key={rule.ruleId} value={rule.ruleId}>{rule.label || 'Unnamed rule'}</option>)}
                </select>
                <textarea value={item.caption} onChange={event => updateEvidence(item.evidenceId, { caption: event.target.value })} placeholder="Explain exactly what the trader should notice…" rows={3} />
              </div>
              <div className="playbook-evidence-actions">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move screenshot earlier"><ArrowUp size={13} /></button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === evidence.length - 1} aria-label="Move screenshot later"><ArrowDown size={13} /></button>
                <button type="button" onClick={() => onChange(evidence.filter(entry => entry.evidenceId !== item.evidenceId))} aria-label="Remove screenshot from draft"><X size={13} /></button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function RuleExamplesEditor({ rule, onChange, onRequirementChange, onError }: { rule: PlaybookRule; onChange: (examples: PlaybookEvidence[]) => void; onRequirementChange: (requirement: PlaybookRule['exampleRequirement']) => void; onError: (message: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const examples = rule.examples || [];
  const maximum = rule.exampleRequirement?.maximumImages || 6;

  const upload = async (file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { onError('Use a PNG, JPEG, or WebP screenshot.'); return; }
    if (file.size > 10 * 1024 * 1024) { onError('Screenshot must be smaller than 10 MB.'); return; }
    if (examples.length >= maximum) { onError(`This rule allows at most ${maximum} example images.`); return; }
    setUploading(true); onError('');
    try {
      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read screenshot'));
        reader.readAsDataURL(file);
      });
      const token = localStorage.getItem('token');
      const response = await fetch('/api/playbooks/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ imageData, kind: 'reference' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not upload screenshot');
      onChange([...examples, { ...body.evidence, linkedRuleId: rule.ruleId, order: examples.length }]);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not upload screenshot');
    } finally {
      setUploading(false);
    }
  };
  const update = (evidenceId: string, patch: Partial<PlaybookEvidence>) => onChange(examples.map(item => item.evidenceId === evidenceId ? { ...item, ...patch } : item));
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= examples.length) return;
    const next = [...examples]; [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((item, order) => ({ ...item, order })));
  };

  return (
    <div className="playbook-rule-examples">
      <div className="playbook-rule-examples-heading">
        <div><strong>Visual reference</strong><span>Optional chart examples that teach how this rule should or should not look.</span></div>
        <label className={`btn-ghost playbook-evidence-upload${uploading || examples.length >= maximum ? ' disabled' : ''}`}><ImagePlus size={13} />{uploading ? 'Uploading…' : 'Add reference'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading || examples.length >= maximum} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} /></label>
      </div>
      <div className="playbook-trade-evidence-setting">
        <div>
          <strong>Require a trade screenshot</strong>
          <span>When enabled, the journal requires evidence from the actual trade for this rule.</span>
        </div>
        <label className="playbook-rule-example-toggle">
          <input aria-label="Require a trade screenshot when journaling this rule" type="checkbox" checked={rule.exampleRequirement?.required || false} onChange={event => onRequirementChange({ required: event.target.checked, minimumImages: event.target.checked ? Math.max(1, rule.exampleRequirement?.minimumImages || 0) : 0, maximumImages: rule.exampleRequirement?.maximumImages || 6 })} />
          <span aria-hidden="true" />
          <strong>{rule.exampleRequirement?.required ? 'On' : 'Off'}</strong>
        </label>
      </div>
      {rule.exampleRequirement?.required && <div className="playbook-rule-example-requirement met">The journal will require {rule.exampleRequirement.minimumImages || 1} trade screenshot{(rule.exampleRequirement.minimumImages || 1) === 1 ? '' : 's'}. Reference examples remain optional.</div>}
      {examples.length > 0 && <div className="playbook-rule-example-grid">{examples.map((item, index) => <article key={item.evidenceId}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.url} alt={item.caption || `${rule.label} example`} />
        <select value={item.kind} onChange={event => update(item.evidenceId, { kind: event.target.value as PlaybookEvidence['kind'] })}><option value="reference">Reference</option><option value="valid">Valid</option><option value="invalid">Invalid</option></select>
        <textarea rows={2} value={item.caption} onChange={event => update(item.evidenceId, { caption: event.target.value })} placeholder="Explain what the trader should notice…" />
        <div><button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move example earlier"><ArrowUp size={12} /></button><button type="button" disabled={index === examples.length - 1} onClick={() => move(index, 1)} aria-label="Move example later"><ArrowDown size={12} /></button><button type="button" onClick={() => onChange(examples.filter(example => example.evidenceId !== item.evidenceId))} aria-label="Remove example"><X size={12} /></button></div>
      </article>)}</div>}
    </div>
  );
}

function RuleAdvancedOptions({ rule, onChange, onError }: { rule: PlaybookRule; onChange: (patch: Partial<PlaybookRule>) => void; onError: (message: string) => void }) {
  const exampleCount = (rule.examples || []).length;
  const hasGuidance = Boolean(rule.helpText?.trim() || rule.placeholder?.trim() || rule.unit?.trim() || Object.values(rule.validation || {}).some(value => value !== null && value !== undefined));
  const selectedTimeframes = rule.timeframes || [];
  const toolRole = rule.toolRole || 'observation';
  const failureAction = rule.failureAction || 'none';
  const toggleTimeframe = (timeframe: string) => onChange({ timeframes: selectedTimeframes.includes(timeframe) ? selectedTimeframes.filter(item => item !== timeframe) : [...selectedTimeframes, timeframe] });

  return (
    <details className="playbook-rule-advanced">
      <summary>
        <span><Settings2 size={14} />More options</span>
        <span className="playbook-rule-advanced-summary">
          {toolRole !== 'observation' && <em>{RULE_TOOL_ROLES.find(item => item.value === toolRole)?.label}</em>}
          {selectedTimeframes.length > 0 && <em>{selectedTimeframes.join(' · ')}</em>}
          {failureAction !== 'none' && <em>{FAILURE_ACTIONS.find(item => item.value === failureAction)?.label}</em>}
          {hasGuidance && <em>Guidance</em>}
          {exampleCount > 0 && <em>{exampleCount} reference{exampleCount === 1 ? '' : 's'}</em>}
          {rule.exampleRequirement?.required && <em>Trade screenshot required</em>}
        </span>
      </summary>
      <div className="playbook-rule-advanced-body">
        <section className="playbook-rule-logic">
          <div className="playbook-advanced-section-heading">
            <strong>Strategy logic</strong>
            <span>Define what this rule does, where it applies, and what happens when it is not satisfied.</span>
          </div>
          <div className="playbook-rule-logic-grid">
            <label>Rule tool
              <select value={toolRole} onChange={event => onChange({ toolRole: event.target.value as RuleToolRole })}>
                {RULE_TOOL_ROLES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <small>{RULE_TOOL_ROLES.find(item => item.value === toolRole)?.description}</small>
            </label>
            <label>When not satisfied
              <select value={failureAction} onChange={event => onChange({ failureAction: event.target.value as RuleFailureAction })}>
                {FAILURE_ACTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <small>This records the intended decision; completed journals remain editable audit records.</small>
            </label>
          </div>
          <fieldset className="playbook-timeframe-picker">
            <legend>Applicable timeframes <span>Leave empty when the rule applies everywhere.</span></legend>
            <div>{RULE_TIMEFRAMES.map(timeframe => <label key={timeframe}><input type="checkbox" checked={selectedTimeframes.includes(timeframe)} onChange={() => toggleTimeframe(timeframe)} /><span>{timeframe}</span></label>)}</div>
          </fieldset>
          {failureAction !== 'none' && <label className="playbook-failure-message">Decision guidance
            <input maxLength={240} value={rule.failureMessage || ''} onChange={event => onChange({ failureMessage: event.target.value })} placeholder={failureAction === 'warn' ? 'Explain the warning shown to the trader' : failureAction === 'skip_trade' ? 'Explain why this setup must be skipped' : 'Explain why trading must stop for the session'} />
          </label>}
        </section>
        <FieldDetails rule={rule} onChange={onChange} />
        <RuleExamplesEditor
          rule={rule}
          onChange={examples => onChange({ examples })}
          onRequirementChange={exampleRequirement => onChange({ exampleRequirement })}
          onError={onError}
        />
      </div>
    </details>
  );
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
  const [newBlockCategory, setNewBlockCategory] = useState<TemplateCategory>('context');
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(() => new Set());

  const selectPlaybook = useCallback((playbook: Playbook) => {
    const version = latest(playbook);
    const nextBlocks = cloneBlocks(version?.blocks || []);
    setSelectedId(playbook.playbookId);
    setName(playbook.name);
    setDescription(playbook.description || '');
    setBlocks(nextBlocks);
    setCollapsedBlockIds(new Set(nextBlocks.slice(1).map(block => block.blockId)));
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
  const moveBlock = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= blocks.length) return;
    setBlocks(current => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((block, order) => ({ ...block, order }));
    });
    markDirty();
  };
  const toggleBlock = (blockId: string) => setCollapsedBlockIds(current => {
    const next = new Set(current);
    if (next.has(blockId)) next.delete(blockId); else next.add(blockId);
    return next;
  });
  const addRule = (blockId: string) => {
    setBlocks(current => current.map(block => block.blockId === blockId ? {
      ...block,
      rules: [...block.rules, { ruleId: uid('rule'), label: '', inputType: 'boolean', options: [], required: false, helpText: '', placeholder: '', unit: '', defaultValue: null, validation: {}, examples: [], exampleRequirement: { required: false, minimumImages: 0, maximumImages: 6 }, toolRole: 'observation', timeframes: [], failureAction: 'none', failureMessage: '' }],
    } : block));
    markDirty();
  };

  const startNew = () => {
    setSelectedId('');
    setName('');
    setDescription('');
    setBlocks([blankBlock()]);
    setCollapsedBlockIds(new Set());
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
    if (!changeNote.trim()) {
      setError('Explain what changed in this version before publishing.'); return;
    }
    if (changeNote.trim().length < 20) {
      setError('The version change note must contain at least 20 characters. Include what changed and why.'); return;
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
          {!creating && selectedId && <button className="btn-ghost" onClick={() => router.push(`/rules/read?playbook=${encodeURIComponent(selectedId)}`)} style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 8 }}><BookOpen size={16} />Read playbook</button>}
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

              {blocks.map((block, blockIndex) => (
                <section key={block.blockId} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
                  <div className="playbook-stage-toolbar">
                    <span className="playbook-stage-number">{blockIndex + 1}</span>
                    <div>
                      <strong>{block.name || 'Unnamed block'} <span className={`playbook-stage-status ${blockIsReady(block) ? 'ready' : 'draft'}`}>{blockIsReady(block) ? 'Ready' : 'Needs details'}</span></strong>
                      <span>{BLOCK_CATEGORIES.find(item => item.value === block.category)?.label || 'Custom stage'} · {block.rules.length} rule{block.rules.length === 1 ? '' : 's'} · {block.rules.filter(rule => rule.required).length} required{blockEvidenceCount(block) > 0 ? ` · ${blockEvidenceCount(block)} reference${blockEvidenceCount(block) === 1 ? '' : 's'}` : ''}</span>
                    </div>
                    <div className="playbook-stage-actions">
                      <button type="button" onClick={() => moveBlock(blockIndex, -1)} disabled={blockIndex === 0} aria-label={`Move ${block.name} earlier`}><ArrowUp size={14} /></button>
                      <button type="button" onClick={() => moveBlock(blockIndex, 1)} disabled={blockIndex === blocks.length - 1} aria-label={`Move ${block.name} later`}><ArrowDown size={14} /></button>
                      <button type="button" onClick={() => toggleBlock(block.blockId)} aria-expanded={!collapsedBlockIds.has(block.blockId)} aria-label={`${collapsedBlockIds.has(block.blockId) ? 'Expand' : 'Collapse'} ${block.name}`}><ChevronDown size={15} style={{ transform: collapsedBlockIds.has(block.blockId) ? 'rotate(-90deg)' : 'none', transition: 'transform .15s ease' }} /></button>
                    </div>
                  </div>

                  {!collapsedBlockIds.has(block.blockId) && <>
                  <details className="playbook-block-options">
                    <summary><Settings2 size={14} />Block settings{(block.evidence || []).length > 0 ? ` · ${(block.evidence || []).length} cover reference${(block.evidence || []).length === 1 ? '' : 's'}` : ''}</summary>
                    <div className="playbook-block-options-body">
                      <div className="playbook-block-header">
                        <label style={{ display: 'grid', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}><span>Block name<InfoHint text="Blocks organize related rules, for example Market Context, Entry Confirmation, Risk, or Execution." /></span><input value={block.name} onChange={e => updateBlock(block.blockId, { name: e.target.value })} style={{ minHeight: 42, border: '1px solid var(--border)', borderRadius: 8, padding: '0 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontWeight: 700 }} /></label>
                        <label style={{ display: 'grid', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>Lifecycle stage<select value={block.category} onChange={e => updateBlock(block.blockId, { category: e.target.value as BlockCategory })} style={{ minHeight: 42, border: '1px solid var(--border)', borderRadius: 8, padding: '0 8px', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>{BLOCK_CATEGORIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                        <button onClick={() => removeBlock(block.blockId)} disabled={blocks.length === 1} aria-label={`Remove ${block.name}`} className="icon-btn" style={{ color: 'var(--red)', minWidth: 42, minHeight: 42 }}><Trash2 size={15} /></button>
                      </div>
                      <p style={{ margin: '-5px 0 12px', color: 'var(--text-muted)', fontSize: 11 }}>{BLOCK_CATEGORIES.find(item => item.value === block.category)?.description || BLOCK_CATEGORIES[BLOCK_CATEGORIES.length - 1].description}</p>
                      <details className="playbook-cover-evidence">
                        <summary><ImagePlus size={14} />Optional block cover images</summary>
                        <BlockEvidenceEditor block={block} onChange={evidence => updateBlock(block.blockId, { evidence })} onError={setError} />
                      </details>
                    </div>
                  </details>

                  <div style={{ display: 'grid', gap: 9 }}>
                    {block.rules.map((rule, ruleIndex) => (
                      <div key={rule.ruleId} className="playbook-rule-row">
                        <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}>Rule {ruleIndex + 1}<input value={rule.label} onChange={e => updateRule(block.blockId, rule.ruleId, { label: e.target.value })} placeholder="Observable condition" style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, padding: '0 9px', background: 'var(--bg-surface)', color: 'var(--text-primary)' }} /></label>
                        <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}><span>Answer type<InfoHint text="Choose the primitive value stored for this rule: Boolean, Number, Text, Single choice, or Multiple choice. Number and Text presentation is configured separately under Format." /></span><select value={primitiveInputType(rule.inputType)} onChange={e => { const next = e.target.value as PrimitiveInputType; updateRule(block.blockId, rule.ruleId, { inputType: next, options: ['single_choice', 'multi_choice'].includes(next) ? rule.options : [] }); }} style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 7px' }}>{(Object.keys(PRIMITIVE_INPUT_LABELS) as PrimitiveInputType[]).map(type => <option key={type} value={type}>{PRIMITIVE_INPUT_LABELS[type]}</option>)}</select></label>
                        {['single_choice', 'multi_choice'].includes(rule.inputType) ? <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}>Choices<ChoiceOptionsInput key={`${rule.ruleId}-${rule.inputType}`} options={rule.options} onChange={options => updateRule(block.blockId, rule.ruleId, { options })} /></label> : primitiveInputType(rule.inputType) === 'number' ? <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}>Format<select value={rule.inputType} onChange={e => updateRule(block.blockId, rule.ruleId, { inputType: e.target.value as InputType })} style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 7px' }}>{NUMBER_FORMATS.map(type => <option key={type} value={type}>{INPUT_LABELS[type]}</option>)}</select></label> : primitiveInputType(rule.inputType) === 'text' ? <label style={{ display: 'grid', gap: 3, fontSize: 10.5, color: 'var(--text-muted)' }}>Format<select value={rule.inputType} onChange={e => updateRule(block.blockId, rule.ruleId, { inputType: e.target.value as InputType })} style={{ minHeight: 40, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 7px' }}>{TEXT_FORMATS.map(type => <option key={type} value={type}>{INPUT_LABELS[type]}</option>)}</select></label> : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Boolean value</span>}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}><input type="checkbox" checked={rule.required} onChange={e => updateRule(block.blockId, rule.ruleId, { required: e.target.checked })} />Required</label>
                        <button onClick={() => removeRule(block.blockId, rule.ruleId)} aria-label={`Remove ${rule.label || 'rule'} from next version`} className="icon-btn" style={{ color: 'var(--red)' }}><Trash2 size={14} /></button>
                        <RuleAdvancedOptions rule={rule} onChange={patch => updateRule(block.blockId, rule.ruleId, patch)} onError={setError} />
                      </div>
                    ))}
                  </div>
                  <button onClick={() => addRule(block.blockId)} style={{ marginTop: 10, minHeight: 40, border: '1px dashed var(--border)', borderRadius: 8, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '0 12px' }}><Plus size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />Add rule</button>
                  </>}
                </section>
              ))}

              <section className="playbook-add-stage">
                <div>
                  <strong>Add the next lifecycle stage</strong>
                  <span>Use recommended editable fields or begin with an empty custom stage.</span>
                </div>
                <select value={newBlockCategory} onChange={event => setNewBlockCategory(event.target.value as TemplateCategory)}>
                  {BLOCK_CATEGORIES.filter(item => item.value !== 'custom').map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <button className="btn-primary" onClick={() => { setBlocks(current => [...current, blockFromTemplate(newBlockCategory)]); markDirty(); }}><CopyPlus size={15} />Add recommended stage</button>
                <button className="btn-ghost" onClick={() => { setBlocks(current => [...current, blankBlock()]); markDirty(); }}><Plus size={15} />Add empty stage</button>
              </section>

              <section style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
                <label style={{ display: 'grid', gap: 7, color: 'var(--text-muted)', fontSize: 12 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    What changed in this version? <strong style={{ color: 'var(--red)', marginLeft: 4 }}>*</strong>
                    <InfoHint text="Required audit note. Describe exactly what was added, removed, or adjusted; why you made the change; and what improvement you expect. This lets Edge Coach compare performance before and after the change." />
                  </span>
                  <textarea
                    value={changeNote}
                    onChange={e => { setChangeNote(e.target.value); markDirty(); }}
                    required
                    minLength={20}
                    rows={5}
                    aria-describedby="change-note-guidance change-note-count"
                    placeholder={'Example:\nChanged: Added an Order Block tap requirement before an FVG entry.\nReason: FVG-only entries produced too many low-quality trades.\nExpected result: Fewer trades with a higher win rate and better average R.'}
                    style={{ width: '100%', minHeight: 128, resize: 'vertical', border: '1px solid var(--border)', borderRadius: 8, padding: '11px 12px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', font: 'inherit', lineHeight: 1.5 }}
                  />
                </label>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 7, color: 'var(--text-muted)', fontSize: 11 }}>
                  <span id="change-note-guidance">Include: what changed, why it changed, and the expected improvement. Publishing creates a permanent snapshot.</span>
                  <span id="change-note-count" style={{ whiteSpace: 'nowrap', color: changeNote.trim().length > 0 && changeNote.trim().length < 20 ? 'var(--red)' : 'var(--text-muted)' }}>{changeNote.trim().length}/20 minimum</span>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
