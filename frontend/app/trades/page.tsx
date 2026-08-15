'use client';
import { Suspense, useEffect, useState, useCallback, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import InfoHint from '@/components/InfoHint';
import TradeReplayModal from '@/components/TradeReplayModal';
import { 
  SlidersHorizontal, ChevronLeft, ChevronRight, List, 
  X, Smile, Award, Tag, CheckSquare, Save, Info,
  Upload, Image as ImageIcon, Trash2, Copy, Check, LockKeyhole, Play
} from 'lucide-react';

const API = '/api';
const PAGE_SIZE = 50;

interface ChecklistItem {
  ruleId?: string;
  rule: string;
  complied: boolean;
  _id?: string;
}

interface TradeScreenshot {
  _id: string;
  url: string;
  publicId: string;
  caption?: string;
  uploadedAt?: string;
  playbookRuleId?: string;
  playbookVersionId?: string;
}

interface Trade {
  _id: string;
  dealId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  pnlUSD: number;
  pnlPct: number;
  commission: number;
  swap: number;
  openTime: string;
  closeTime: string;
  durationMinutes: number;
  runningBalance: number;
  notes?: string;
  tags?: string[];
  emotion?: string;
  grade?: string;
  // Edge Coach
  analysisGrade?: string;
  executionGrade?: string;
  plannedRR?: number | null;
  exitReason?: string;
  riskUSD?: number | null;
  stopLoss?: number | null;
  manuallyIntervened?: boolean | null;
  confidenceRating?: number | null;
  accountType?: string;
  accountKey?: string;
  accountLogin?: string;
  accountServer?: string;
  accountName?: string;
  primarySetup?: string;
  setupConfirmations?: string[];
  executionChecklist?: ChecklistItem[];
  checklist?: ChecklistItem[];
  screenshots?: TradeScreenshot[];
  isReEntry?: boolean;
  positionId?: string;
  tradeGroup?: string;
  parentTradeId?: string;
  playbookId?: string;
  playbookVersionId?: string;
  playbookSnapshot?: PlaybookSnapshot | null;
  playbookResponses?: Record<string, unknown>;
}

const EMOTIONS = [
  { name: 'Calm', emoji: '😊' },
  { name: 'Disciplined', emoji: '🧠' },
  { name: 'Anxious', emoji: '😰' },
  { name: 'Greedy', emoji: '🤑' },
  { name: 'Fearful', emoji: '😨' },
  { name: 'FOMO', emoji: '💥' },
];

const GRADES = ['A', 'B', 'C', 'D', 'F'];

const DEFAULT_CHECKLIST = [
  { rule: 'HTF Trend Aligned', complied: false },
  { rule: 'Daily/H4 Key Level Tap', complied: false },
  { rule: 'Confluence / Confirmation Entry', complied: false },
  { rule: 'Risk-to-Reward Ratio >= 1:2', complied: false },
  { rule: 'Stop Loss and Take Profit Defined', complied: false },
];

const DEFAULT_EXECUTION_CHECKLIST = [
  { rule: 'Entry as planned', complied: false },
  { rule: 'Stop not moved', complied: false },
  { rule: 'Target respected', complied: false },
  { rule: 'Position size correct', complied: false },
  { rule: 'No manual close out of fear', complied: false },
];

interface TradingRule {
  ruleId: string;
  label: string;
  category: 'pre_trade' | 'execution';
  enabled: boolean;
  order: number;
}

interface TradeAccountOption {
  accountKey: string;
  accountLogin: string;
  accountServer: string;
  accountName: string;
  accountType: string;
  label: string;
  count: number;
}

interface PlaybookRule {
  ruleId: string;
  label: string;
  inputType: 'boolean' | 'single_choice' | 'multi_choice' | 'number' | 'percentage' | 'currency' | 'price' | 'duration' | 'risk_reward' | 'rating' | 'text' | 'long_text' | 'date' | 'time';
  options: string[];
  required: boolean;
  helpText?: string;
  placeholder?: string;
  unit?: string;
  defaultValue?: string | number | boolean | null;
  validation?: { min?: number | null; max?: number | null; minLength?: number | null; maxLength?: number | null };
  examples?: Array<{ evidenceId: string; url: string; caption: string; kind: 'reference' | 'valid' | 'invalid' }>;
  exampleRequirement?: { required: boolean; minimumImages: number; maximumImages: number };
  toolRole?: 'observation' | 'confirmation' | 'trigger' | 'decision_gate' | 'invalidation' | 'risk_limit' | 'management_action' | 'exit_signal' | 'review_prompt';
  timeframes?: string[];
  failureAction?: 'none' | 'warn' | 'skip_trade' | 'stop_session';
  failureMessage?: string;
}

interface PlaybookBlock {
  blockId: string;
  name: string;
  category: string;
  rules: PlaybookRule[];
  evidence?: Array<{ evidenceId: string; url: string; caption: string; kind: 'reference' | 'valid' | 'invalid'; linkedRuleId?: string }>;
}

type JournalPhase = 'plan' | 'manage' | 'review';
const JOURNAL_PHASES: Array<{ id: JournalPhase; label: string; categories: string[] }> = [
  { id: 'plan', label: '1. Plan', categories: ['concept', 'context', 'setup', 'entry', 'risk', 'pre_trade'] },
  { id: 'manage', label: '2. Manage', categories: ['execution', 'management', 'trade_management'] },
  { id: 'review', label: '3. Review', categories: ['exit', 'review', 'post_trade', 'custom'] },
];

const RULE_TOOL_LABELS: Record<string, string> = {
  observation: 'Observation', confirmation: 'Confirmation', trigger: 'Entry trigger', decision_gate: 'Decision gate', invalidation: 'Invalidation', risk_limit: 'Risk limit', management_action: 'Management action', exit_signal: 'Exit signal', review_prompt: 'Review prompt',
};
const FAILURE_ACTION_LABELS: Record<string, string> = {
  warn: 'Warning', skip_trade: 'Skip this setup', stop_session: 'Stop the trading session',
};

function hasPlaybookAnswer(value: unknown) {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
}

interface PlaybookSnapshot {
  playbookId: string;
  name: string;
  description?: string;
  versionId: string;
  versionNumber: number;
  schemaVersion?: number;
  publishedAt: string;
  blocks: PlaybookBlock[];
}

interface Playbook {
  playbookId: string;
  name: string;
  description: string;
  archived: boolean;
  versions: Array<{ versionId: string; versionNumber: number; schemaVersion?: number; publishedAt: string; blocks: PlaybookBlock[] }>;
}

function formatDuration(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function TradesPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryTradeRestored = useRef<string | null>(null);
  const updateQuery = useCallback((updates: Record<string, string | number | null | undefined>) => {
    const next = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '' || (key === 'page' && Number(value) === 1)) next.delete(key);
      else next.set(key, String(value));
    });
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [loading, setLoading] = useState(true);
  const [hasToken, setHasToken] = useState(false);
  const [tradingRules, setTradingRules] = useState<TradingRule[]>([]);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);

  // Auth checking
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    setHasToken(true);
  }, [router]);

  useEffect(() => {
    if (!hasToken) return;
    const token = localStorage.getItem('token');
    fetch(`${API}/rules`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not load trading rules')))
      .then(body => setTradingRules(body.rules || []))
      .catch(error => console.error(error));
  }, [hasToken]);

  useEffect(() => {
    if (!hasToken) return;
    const token = localStorage.getItem('token');
    fetch(`${API}/playbooks`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not load strategy playbooks')))
      .then(body => setPlaybooks(body.playbooks || []))
      .catch(error => console.error(error));
  }, [hasToken]);

  // Filters
  const [symbol, setSymbol]       = useState(() => searchParams.get('symbol') || '');
  const [direction, setDirection] = useState(() => searchParams.get('direction') || '');
  const [accountTypeFilter, setAccountTypeFilter] = useState(() => searchParams.get('account') || '');
  const [accountKeyFilter, setAccountKeyFilter] = useState(() => searchParams.get('accountKey') || '');
  const [from, setFrom]           = useState(() => searchParams.get('from') || '');
  const [to, setTo]               = useState(() => searchParams.get('to') || '');
  const [symbols, setSymbols]     = useState<string[]>([]);
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountOption[]>([]);
  const [unassignedAccountCount, setUnassignedAccountCount] = useState(0);

  useEffect(() => {
    if (!hasToken) return;
    const token = localStorage.getItem('token');
    fetch(`${API}/trade-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not load trading accounts')))
      .then(body => {
        setTradeAccounts(body.accounts || []);
        setUnassignedAccountCount(Number(body.unassignedCount || 0));
      })
      .catch(error => console.error(error));
  }, [hasToken]);

  // Journal Drawer State
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [draftNotes, setDraftNotes] = useState('');
  const [draftEmotion, setDraftEmotion] = useState('');
  const [draftGrade, setDraftGrade] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [draftChecklist, setDraftChecklist] = useState<ChecklistItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [screenshotCaption, setScreenshotCaption] = useState('');
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);
  const [previewScreenshot, setPreviewScreenshot] = useState<TradeScreenshot | null>(null);
  // Edge Coach draft state
  const [draftAnalysisGrade, setDraftAnalysisGrade] = useState('');
  const [draftExecutionGrade, setDraftExecutionGrade] = useState('');
  const [draftPlannedRR, setDraftPlannedRR] = useState('');
  const [draftExitReason, setDraftExitReason] = useState('');
  const [draftManuallyIntervened, setDraftManuallyIntervened] = useState<boolean | null>(null);
  const [draftConfidence, setDraftConfidence] = useState<number | null>(null);
  const [draftAccountType, setDraftAccountType] = useState('');
  const [draftPrimarySetup, setDraftPrimarySetup] = useState('');
  const [draftSetupConfirmations, setDraftSetupConfirmations] = useState<string[]>([]);
  const [draftExecChecklist, setDraftExecChecklist] = useState<ChecklistItem[]>([]);
  const [draftIsReEntry, setDraftIsReEntry] = useState(false);
  const [draftTradeGroup, setDraftTradeGroup] = useState('');
  const [draftParentTradeId, setDraftParentTradeId] = useState('');
  const [parentSearchQuery, setParentSearchQuery] = useState('');
  const [showParentDropdown, setShowParentDropdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draftPlaybookSnapshot, setDraftPlaybookSnapshot] = useState<PlaybookSnapshot | null>(null);
  const [draftPlaybookResponses, setDraftPlaybookResponses] = useState<Record<string, unknown>>({});
  const [activePlaybookPhase, setActivePlaybookPhase] = useState<JournalPhase>('plan');
  const [replayTradeId, setReplayTradeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      ...(symbol    && { symbol }),
      ...(direction && { direction }),
      ...(accountTypeFilter && { accountType: accountTypeFilter }),
      ...(accountKeyFilter && { accountKey: accountKeyFilter }),
      ...(from      && { from }),
      ...(to        && { to }),
    });
    try {
      const r = await fetch(`${API}/trades?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (r.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }
      const data = await r.json();
      setTrades(data.trades || []);
      setTotal(data.total || 0);
      
      // Auto-extract unique symbols list
      setSymbols(prev => {
        const all = new Set([...prev, ...(data.trades || []).map((t: Trade) => t.symbol)]);
        return Array.from(all).sort();
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [page, symbol, direction, accountTypeFilter, accountKeyFilter, from, to, router]);

  useEffect(() => { load(); }, [load]);

  const resetFilters = () => {
    setSymbol(''); setDirection(''); setAccountTypeFilter(''); setAccountKeyFilter(''); setFrom(''); setTo(''); setPage(1);
    updateQuery({ symbol: null, direction: null, account: null, accountKey: null, from: null, to: null, page: null });
  };

  const handleRowClick = (trade: Trade) => {
    const rulesFor = (category: TradingRule['category'], fallback: ChecklistItem[]) => {
      const active = tradingRules
        .filter(rule => rule.category === category && rule.enabled)
        .sort((a, b) => a.order - b.order)
        .map(rule => ({ ruleId: rule.ruleId, rule: rule.label, complied: false }));
      return active.length > 0 ? active : fallback.map(rule => ({ ...rule }));
    };
    setSelectedTrade(trade);
    updateQuery({ trade: trade._id });
    setDraftNotes(trade.notes || '');
    setDraftEmotion(trade.emotion || '');
    setDraftGrade(trade.grade || '');
    setDraftTags(trade.tags || []);
    setDraftChecklist(
      trade.checklist && trade.checklist.length > 0
        ? trade.checklist
        : rulesFor('pre_trade', DEFAULT_CHECKLIST)
    );
    setTagInput('');
    setScreenshotCaption('');
    setPreviewScreenshot(null);
    // Edge Coach
    setDraftAnalysisGrade(trade.analysisGrade || '');
    setDraftExecutionGrade(trade.executionGrade || '');
    setDraftPlannedRR(trade.plannedRR != null ? String(trade.plannedRR) : '');
    setDraftExitReason(trade.exitReason || '');
    setDraftManuallyIntervened(trade.manuallyIntervened ?? null);
    setDraftConfidence(trade.confidenceRating ?? null);
    setDraftAccountType(trade.accountType || '');
    setDraftPrimarySetup(trade.primarySetup || '');
    setDraftSetupConfirmations(trade.setupConfirmations || []);
    setDraftExecChecklist(
      trade.executionChecklist && trade.executionChecklist.length > 0
        ? trade.executionChecklist
        : rulesFor('execution', DEFAULT_EXECUTION_CHECKLIST)
    );
    setDraftIsReEntry(trade.isReEntry ?? false);
    setDraftTradeGroup(trade.tradeGroup || '');
    setDraftParentTradeId(trade.parentTradeId || '');
    setDraftPlaybookSnapshot(trade.playbookSnapshot || null);
    setDraftPlaybookResponses(trade.playbookResponses || {});
    setActivePlaybookPhase('plan');
  };

  useEffect(() => {
    const requestedId = searchParams.get('replay') || searchParams.get('trade');
    if (!requestedId || queryTradeRestored.current === requestedId) return;
    const requestedTrade = trades.find(trade => trade._id === requestedId);
    if (!requestedTrade) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      queryTradeRestored.current = requestedId;
      handleRowClick(requestedTrade);
      if (searchParams.get('replay')) setReplayTradeId(requestedId);
    });
    return () => { cancelled = true; };
    // Restoring is intentionally keyed to the loaded result set and URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, searchParams]);

  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tagInput.trim().replace(/^#/, '');
    if (clean && !draftTags.includes(clean)) {
      setDraftTags([...draftTags, clean]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setDraftTags(draftTags.filter(t => t !== tagToRemove));
  };

  const toggleChecklistItem = (index: number) => {
    const copy = [...draftChecklist];
    copy[index] = { ...copy[index], complied: !copy[index].complied };
    setDraftChecklist(copy);
  };

  const handleSaveJournal = async () => {
    if (!selectedTrade) return;
    const missingRequired = draftPlaybookSnapshot?.blocks.flatMap(block => block.rules).find(rule => {
      if (!rule.required) return false;
      const value = draftPlaybookResponses[rule.ruleId];
      return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    });
    if (missingRequired) {
      const missingBlock = draftPlaybookSnapshot?.blocks.find(block => block.rules.some(rule => rule.ruleId === missingRequired.ruleId));
      const missingPhase = JOURNAL_PHASES.find(phase => missingBlock && phase.categories.includes(missingBlock.category));
      if (missingPhase) setActivePlaybookPhase(missingPhase.id);
      alert(`Complete the required playbook field: ${missingRequired.label}`);
      return;
    }
    const missingImageRule = draftPlaybookSnapshot?.blocks.flatMap(block => block.rules).find(rule => {
      if (!rule.exampleRequirement?.required) return false;
      const count = (selectedTrade.screenshots || []).filter(screenshot => screenshot.playbookRuleId === rule.ruleId && screenshot.playbookVersionId === draftPlaybookSnapshot.versionId).length;
      return count < (rule.exampleRequirement.minimumImages || 1);
    });
    if (missingImageRule) {
      const missingBlock = draftPlaybookSnapshot?.blocks.find(block => block.rules.some(rule => rule.ruleId === missingImageRule.ruleId));
      const missingPhase = JOURNAL_PHASES.find(phase => missingBlock && phase.categories.includes(missingBlock.category));
      if (missingPhase) setActivePlaybookPhase(missingPhase.id);
      alert(`Add ${missingImageRule.exampleRequirement?.minimumImages || 1} trade screenshot confirmation${(missingImageRule.exampleRequirement?.minimumImages || 1) === 1 ? '' : 's'} for: ${missingImageRule.label}`);
      return;
    }
    const token = localStorage.getItem('token');
    if (!token) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/trades/${selectedTrade._id}`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          notes: draftNotes,
          emotion: draftEmotion,
          grade: draftGrade,
          tags: draftTags,
          checklist: draftChecklist,
          // Edge Coach
          analysisGrade: draftAnalysisGrade,
          executionGrade: draftExecutionGrade,
          plannedRR: draftPlannedRR === '' ? null : parseFloat(draftPlannedRR),
          exitReason: draftExitReason,
          manuallyIntervened: draftManuallyIntervened,
          confidenceRating: draftConfidence,
          accountType: draftAccountType,
          primarySetup: draftPrimarySetup,
          setupConfirmations: draftSetupConfirmations,
          executionChecklist: draftExecChecklist,
          playbookId: draftPlaybookSnapshot?.playbookId || '',
          playbookVersionId: draftPlaybookSnapshot?.versionId || '',
          playbookResponses: draftPlaybookResponses,
          isReEntry: draftIsReEntry,
          tradeGroup: draftTradeGroup.trim(),
          parentTradeId: draftParentTradeId,
        })
      });
      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update journal');
      }
      const updatedTrade = await res.json();
      
      // Update locally in trades list
      setTrades(prev => prev.map(t => t._id === updatedTrade._id ? updatedTrade : t));
      setSelectedTrade(updatedTrade);
      
      // Success alert style or auto close
      setSelectedTrade(null);
    } catch (e) {
      console.error(e);
      alert(e instanceof Error ? e.message : 'Error saving journal notes');
    } finally {
      setSaving(false);
    }
  };

  const updateTradeInState = (updatedTrade: Trade) => {
    setTrades(prev => prev.map(t => t._id === updatedTrade._id ? updatedTrade : t));
    setSelectedTrade(updatedTrade);
  };

  const fileToDataUrl = useCallback((file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read screenshot file'));
    reader.readAsDataURL(file);
  }), []);

  const uploadScreenshotDataUrl = useCallback(async (imageData: string, rule?: PlaybookRule) => {
    if (!selectedTrade) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    setUploadingScreenshot(true);
    try {
      const res = await fetch(`${API}/trades/${selectedTrade._id}/screenshots`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          imageData,
          caption: rule ? `Trade confirmation: ${rule.label}` : screenshotCaption,
          playbookRuleId: rule?.ruleId || '',
          playbookVersionId: rule ? draftPlaybookSnapshot?.versionId || '' : '',
        }),
      });

      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Screenshot upload failed');
      updateTradeInState(data);
      setScreenshotCaption('');
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Screenshot upload failed');
    } finally {
      setUploadingScreenshot(false);
    }
  }, [draftPlaybookSnapshot?.versionId, router, screenshotCaption, selectedTrade]);

  const uploadScreenshotFile = useCallback(async (file: File, rule?: PlaybookRule) => {
    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file.');
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      alert('Please keep screenshots under 8MB.');
      return;
    }

    try {
      await uploadScreenshotDataUrl(await fileToDataUrl(file), rule);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Screenshot upload failed');
    }
  }, [fileToDataUrl, uploadScreenshotDataUrl]);

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    await uploadScreenshotFile(file);
  };

  const handleScreenshotPaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (uploadingScreenshot) return;

    const items = Array.from(event.clipboardData.items || []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;

    event.preventDefault();
    event.stopPropagation();
    await uploadScreenshotFile(file);
  };

  useEffect(() => {
    if (!selectedTrade) return;

    const handlePaste = async (event: ClipboardEvent) => {
      if (uploadingScreenshot) return;

      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find(item => item.type.startsWith('image/'));
      if (!imageItem) return;

      const file = imageItem.getAsFile();
      if (!file) return;

      if (file.size > 8 * 1024 * 1024) {
        alert('Please keep screenshots under 8MB.');
        return;
      }

      event.preventDefault();
      await uploadScreenshotFile(file);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [selectedTrade, uploadScreenshotFile, uploadingScreenshot]);

  const handleScreenshotCaptionChange = async (screenshotId: string, caption: string) => {
    if (!selectedTrade) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const res = await fetch(`${API}/trades/${selectedTrade._id}/screenshots/${screenshotId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ caption }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Could not update screenshot caption');
      }

      updateTradeInState(await res.json());
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Could not update screenshot caption');
    }
  };

  const handleScreenshotDelete = async (screenshotId: string) => {
    if (!selectedTrade) return;
    const confirmed = window.confirm('Delete this screenshot from the trade?');
    if (!confirmed) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const res = await fetch(`${API}/trades/${selectedTrade._id}/screenshots/${screenshotId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Could not delete screenshot');
      }

      updateTradeInState(await res.json());
      setPreviewScreenshot(null);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Could not delete screenshot');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!hasToken) return null;

  const selectPlaybookForTrade = (playbookId: string) => {
    const playbook = playbooks.find(item => item.playbookId === playbookId);
    if (!playbook) {
      setDraftPlaybookSnapshot(null);
      setDraftPlaybookResponses({});
      setActivePlaybookPhase('plan');
      return;
    }
    const version = playbook.versions[playbook.versions.length - 1];
    setDraftPlaybookSnapshot({
      playbookId: playbook.playbookId,
      name: playbook.name,
      description: playbook.description,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      schemaVersion: version.schemaVersion || 1,
      publishedAt: version.publishedAt,
      blocks: JSON.parse(JSON.stringify(version.blocks)),
    });
    const defaults: Record<string, unknown> = {};
    for (const block of version.blocks) {
      for (const rule of block.rules) {
        if (rule.defaultValue !== null && rule.defaultValue !== undefined && rule.defaultValue !== '') defaults[rule.ruleId] = rule.defaultValue;
      }
    }
    setDraftPlaybookResponses(defaults);
    setActivePlaybookPhase('plan');
  };

  const setPlaybookResponse = (ruleId: string, value: unknown) => {
    setDraftPlaybookResponses(current => ({ ...current, [ruleId]: value }));
  };

  const renderPlaybookInput = (rule: PlaybookRule) => {
    const value = draftPlaybookResponses[rule.ruleId];
    if (rule.inputType === 'boolean') {
      return (
        <div style={{ display: 'flex', gap: 6 }}>
          {([{ label: 'Yes', value: true }, { label: 'No', value: false }] as const).map(option => (
            <button key={option.label} type="button" onClick={() => setPlaybookResponse(rule.ruleId, option.value)} style={{ minHeight: 38, minWidth: 64, borderRadius: 8, border: `1px solid ${value === option.value ? 'var(--accent)' : 'var(--border)'}`, background: value === option.value ? 'var(--accent-soft)' : 'var(--bg-surface)', color: value === option.value ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontWeight: 700 }}>{option.label}</button>
          ))}
        </div>
      );
    }
    if (rule.inputType === 'single_choice') {
      return <select value={String(value ?? '')} onChange={event => setPlaybookResponse(rule.ruleId, event.target.value)} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }}><option value="">Select…</option>{rule.options.map(option => <option key={option} value={option}>{option}</option>)}</select>;
    }
    if (rule.inputType === 'multi_choice') {
      const selected = Array.isArray(value) ? value as string[] : [];
      return <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{rule.options.map(option => <button key={option} type="button" onClick={() => setPlaybookResponse(rule.ruleId, selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option])} style={{ minHeight: 36, borderRadius: 18, border: `1px solid ${selected.includes(option) ? 'var(--accent)' : 'var(--border)'}`, background: selected.includes(option) ? 'var(--accent-soft)' : 'var(--bg-surface)', color: selected.includes(option) ? 'var(--accent)' : 'var(--text-muted)', padding: '0 10px', cursor: 'pointer' }}>{option}</button>)}</div>;
    }
    if (rule.inputType === 'rating') {
      return <div><input type="range" min="1" max="10" value={Number(value || 5)} onChange={event => setPlaybookResponse(rule.ruleId, Number(event.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} /><div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>{Number(value || 5)}/10</div></div>;
    }
    const numericTypes = ['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward'];
    if (numericTypes.includes(rule.inputType)) {
      const defaultUnit = rule.inputType === 'percentage' ? '%' : rule.inputType === 'risk_reward' ? 'R' : '';
      return <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><input type="number" step="any" min={rule.inputType === 'percentage' || rule.inputType === 'risk_reward' ? (rule.validation?.min ?? 0) : (rule.validation?.min ?? undefined)} max={rule.inputType === 'percentage' ? (rule.validation?.max ?? 100) : (rule.validation?.max ?? undefined)} placeholder={rule.placeholder || (rule.inputType === 'risk_reward' ? 'e.g. 2 for 1:2' : undefined)} value={String(value ?? '')} onChange={event => setPlaybookResponse(rule.ruleId, event.target.value === '' ? '' : Number(event.target.value))} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />{(rule.unit || defaultUnit) && <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{rule.unit || defaultUnit}</span>}</div>;
    }
    if (rule.inputType === 'date' || rule.inputType === 'time') {
      return <input type={rule.inputType} value={String(value ?? '')} onChange={event => setPlaybookResponse(rule.ruleId, event.target.value)} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />;
    }
    if (rule.inputType === 'text') {
      return <input type="text" value={String(value ?? '')} minLength={rule.validation?.minLength ?? undefined} maxLength={rule.validation?.maxLength ?? undefined} placeholder={rule.placeholder || undefined} onChange={event => setPlaybookResponse(rule.ruleId, event.target.value)} style={{ width: '100%', minHeight: 40, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: '0 9px' }} />;
    }
    return <textarea value={String(value ?? '')} minLength={rule.validation?.minLength ?? undefined} maxLength={rule.validation?.maxLength ?? undefined} placeholder={rule.placeholder || undefined} onChange={event => setPlaybookResponse(rule.ruleId, event.target.value)} rows={4} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: 9, resize: 'vertical' }} />;
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Trades</h2>
            <p>{total.toLocaleString()} closed positions synced from MT5</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-bar">
        <div className="filter-group">
          <label>Symbol</label>
          <select value={symbol} onChange={e => { setSymbol(e.target.value); setPage(1); updateQuery({ symbol: e.target.value, page: null }); }}>
            <option value="">All pairs</option>
            {symbols.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="filter-group">
          <label>Direction</label>
          <select value={direction} onChange={e => { setDirection(e.target.value); setPage(1); updateQuery({ direction: e.target.value, page: null }); }}>
            <option value="">All</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Account type</label>
          <select value={accountTypeFilter} onChange={e => { setAccountTypeFilter(e.target.value); setPage(1); updateQuery({ account: e.target.value, page: null }); }}>
            <option value="">Live &amp; Demo</option>
            <option value="live">Live only</option>
            <option value="demo">Demo only</option>
          </select>
        </div>
        <div className="filter-group filter-group-account">
          <label className="filter-label-with-help">
            Trading account
            <InfoHint text="Filters by the exact MT5 login and broker server recorded during sync. Run a full sync once to label older trades." label="How trading account filtering works" />
          </label>
          <select value={accountKeyFilter} onChange={e => { setAccountKeyFilter(e.target.value); setPage(1); updateQuery({ accountKey: e.target.value, page: null }); }}>
            <option value="">All trading accounts</option>
            {tradeAccounts.map(account => (
              <option key={account.accountKey} value={account.accountKey}>
                {account.label} ({account.accountType || 'unknown'}, {account.count})
              </option>
            ))}
            {unassignedAccountCount > 0 && <option value="__unassigned__">Older trades — account unknown ({unassignedAccountCount})</option>}
          </select>
        </div>
        <div className="filter-group">
          <label>From date</label>
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); updateQuery({ from: e.target.value, page: null }); }} />
        </div>
        <div className="filter-group">
          <label>To date</label>
          <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); updateQuery({ to: e.target.value, page: null }); }} />
        </div>
        <button className="btn btn-ghost" onClick={resetFilters} style={{ alignSelf: 'flex-end', flexShrink: 0 }}>
          <SlidersHorizontal size={13} />
          Reset
        </button>
      </div>

      {/* Table */}
      <div className="table-wrap">
        {loading ? (
          <div className="loading-wrap"><div className="spinner" /></div>
        ) : trades.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><List size={22} /></div>
            <h3>No trades found</h3>
            <p>Adjust your filters or run the MT5 sync script to import trades</p>
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Symbol</th>
                    <th>Direction</th>
                    <th>Grade</th>
                    <th className="hide-sm">Entry</th>
                    <th className="hide-sm">Exit</th>
                    <th className="hide-sm">Lots</th>
                    <th>P&L (USD)</th>
                    <th className="hide-sm">P&L (%)</th>
                    <th className="hide-sm" title="Realized R-multiple: P&L ÷ the stop-based risk MT5 recorded on the order at entry. Only available for trades synced with a stop loss.">R</th>
                    <th className="hide-md">Comm.</th>
                    <th className="hide-md">Swap</th>
                    <th className="hide-md">Opened</th>
                    <th className="hide-sm">Closed</th>
                    <th className="hide-sm">Duration</th>
                    <th className="hide-sm">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => {
                    const isProfit = t.pnlUSD >= 0;
                    // Color-coded grouping: tradeGroup takes priority over shared positionId
                    const groupKey = t.tradeGroup || (t.positionId || '');
                    const prevGroupKey = i > 0 ? (trades[i-1].tradeGroup || trades[i-1].positionId || '') : '';
                    const nextGroupKey = i < trades.length - 1 ? (trades[i+1].tradeGroup || trades[i+1].positionId || '') : '';
                    const isGrouped = Boolean(groupKey && (groupKey === prevGroupKey || groupKey === nextGroupKey));
                    const groupColors = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#8b5cf6','#14b8a6'];
                    const colorIdx = groupKey ? (groupKey.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0) % groupColors.length) : 0;
                    const groupColor = isGrouped ? groupColors[colorIdx] : '';
                    return (
                      <tr 
                        key={t._id} 
                        className="clickable" 
                        onClick={() => handleRowClick(t)}
                        title={isGrouped ? `Group: ${groupKey}` : 'Click to open journal drawer'}
                        style={isGrouped ? { borderLeft: `3px solid ${groupColor}` } : {}}
                      >
                        <td style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                          {(page - 1) * PAGE_SIZE + i + 1}
                          {isGrouped && t.tradeGroup && (
                            <span style={{
                              display: 'inline-block', marginLeft: 5, fontSize: 9, fontWeight: 700,
                              background: `${groupColor}20`, color: groupColor,
                              border: `1px solid ${groupColor}40`, borderRadius: 4,
                              padding: '1px 4px', maxWidth: 52, overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle'
                            }} title={t.tradeGroup}>
                              {t.tradeGroup}
                            </span>
                          )}
                        </td>
                        <td className="text" style={{ fontWeight: 600 }}>
                          <span>{t.symbol}</span>
                          {t.accountType && <span className={`trade-account-type ${t.accountType}`}>{t.accountType}</span>}
                          {t.accountLogin && <span className="trade-account-id" title={[t.accountName, t.accountLogin, t.accountServer].filter(Boolean).join(' · ')}>#{t.accountLogin}</span>}
                        </td>
                        <td>
                          <span className={`badge ${t.direction.toLowerCase()}`}>{t.direction}</span>
                        </td>
                        <td>
                          {t.isReEntry && (() => {
                            const parent = t.parentTradeId ? trades.find(pt => pt._id === t.parentTradeId) : null;
                            const label = parent ? `RE-ENT of #${parent.dealId}` : 'RE-ENT';
                            return (
                              <span style={{
                                display: 'inline-block', fontSize: 9, fontWeight: 700,
                                background: '#6366f120', color: '#818cf8',
                                border: '1px solid #6366f140', borderRadius: 4,
                                padding: '1px 5px', marginRight: 4, letterSpacing: '0.02em'
                              }}>{label}</span>
                            );
                          })()}
                          {t.grade ? (
                            <span className={`grade-pill-tag ${t.grade}`}>{t.grade}</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
                          )}
                        </td>
                        <td className="hide-sm">{t.entryPrice.toFixed(5)}</td>
                        <td className="hide-sm">{t.exitPrice.toFixed(5)}</td>
                        <td className="hide-sm">{t.lotSize.toFixed(2)}</td>
                        <td className={`pnl ${isProfit ? 'positive' : 'negative'}`}>
                          {isProfit ? '+' : ''}${Math.abs(t.pnlUSD).toFixed(2)}
                        </td>
                        <td className={`pnl ${isProfit ? 'positive' : 'negative'} hide-sm`}>
                          {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%
                        </td>
                        <td className={`hide-sm ${t.riskUSD ? `pnl ${isProfit ? 'positive' : 'negative'}` : ''}`}>
                          {t.riskUSD ? `${isProfit ? '+' : '-'}${Math.abs(t.pnlUSD / t.riskUSD).toFixed(2)}R` : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                        </td>
                        <td className="hide-md" style={{ color: 'var(--text-muted)' }}>{t.commission.toFixed(2)}</td>
                        <td className="hide-md" style={{ color: 'var(--text-muted)' }}>{t.swap.toFixed(2)}</td>
                        <td className="text hide-md" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                          {formatDate(t.openTime)}
                        </td>
                        <td className="text hide-sm" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                          {formatDate(t.closeTime)}
                        </td>
                        <td className="hide-sm" style={{ color: 'var(--text-secondary)' }}>{formatDuration(t.durationMinutes)}</td>
                        <td className="hide-sm" style={{ fontWeight: 500 }}>${t.runningBalance.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="pagination">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <div className="pagination-controls">
                <button className="page-btn" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); updateQuery({ page: next }); }}>
                  <ChevronLeft size={14} />
                </button>
                <span className="page-current">{page} / {totalPages}</span>
                <button className="page-btn" disabled={page >= totalPages} onClick={() => { const next = page + 1; setPage(next); updateQuery({ page: next }); }}>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ══════════════════════════════
         JOURNAL SIDE SLIDE DRAWER
      ══════════════════════════════ */}
      {selectedTrade && (
        <>
          <div className="drawer-overlay" onClick={() => { setSelectedTrade(null); updateQuery({ trade: null }); }} />
          <div className="drawer">
            <div className="drawer-header">
              <div>
                <h3>Trade Journal Details</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  <span>Ticket: {selectedTrade.dealId}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(selectedTrade.dealId);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    style={{
                      background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', color: copied ? '#10b981' : 'var(--text-muted)',
                      borderRadius: 4, transition: 'color 0.2s, background-color 0.2s'
                    }}
                    title="Copy Ticket ID to Clipboard"
                    aria-label="Copy ticket"
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied && <span style={{ marginLeft: 3, fontSize: 9, fontWeight: 700 }}>Copied!</span>}
                  </button>
                </div>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => { setReplayTradeId(selectedTrade._id); updateQuery({ trade: selectedTrade._id, replay: selectedTrade._id }); }} title="Open chart replay for this trade">
                <Play size={14} /> Replay
              </button>
              <button className="drawer-close" onClick={() => { setSelectedTrade(null); updateQuery({ trade: null }); }}>
                <X size={16} />
              </button>
            </div>

            <div className="drawer-body">
              {/* Tech Stats Overview */}
              <div className="drawer-section">
                <span className="drawer-section-title"><Info size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Execution Metrics</span>
                <div className="detail-grid">
                  <div className="detail-tile">
                    <span className="detail-tile-lbl">Pair / Type</span>
                    <span className="detail-tile-val">{selectedTrade.symbol} · {selectedTrade.direction}</span>
                  </div>
                  <div className="detail-tile">
                    <span className="detail-tile-lbl">Lots Size</span>
                    <span className="detail-tile-val">{selectedTrade.lotSize.toFixed(2)}</span>
                  </div>
                  <div className="detail-tile">
                    <span className="detail-tile-lbl">Net P&L</span>
                    <span className={`detail-tile-val pnl ${selectedTrade.pnlUSD >= 0 ? 'positive' : 'negative'}`}>
                      {selectedTrade.pnlUSD >= 0 ? '+' : ''}${selectedTrade.pnlUSD.toFixed(2)} ({selectedTrade.pnlPct >= 0 ? '+' : ''}{selectedTrade.pnlPct.toFixed(2)}%)
                    </span>
                  </div>
                  <div className="detail-tile">
                    <span className="detail-tile-lbl">Duration</span>
                    <span className="detail-tile-val">{formatDuration(selectedTrade.durationMinutes)}</span>
                  </div>
                  <div className="detail-tile">
                    <span className="detail-tile-lbl">Entry Price</span>
                    <span className="detail-tile-val">{selectedTrade.entryPrice.toFixed(5)}</span>
                  </div>
                  <div className="detail-tile">
                    <span className="detail-tile-lbl">Exit Price</span>
                    <span className="detail-tile-val">{selectedTrade.exitPrice.toFixed(5)}</span>
                  </div>
                </div>
              </div>

              {/* ── EDGE COACH: Execution Review ────────────────────────────── */}
              <div className="drawer-section" style={{ background: 'var(--bg-elevated)', borderRadius: 12, padding: '14px 16px', border: '1px solid var(--border)' }}>
                <span className="drawer-section-title" style={{ color: '#8b5cf6' }}>
                  <Award size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  Post-Trade Review
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  {[
                    { label: 'Analysis Grade', val: draftAnalysisGrade, set: setDraftAnalysisGrade },
                    { label: 'Execution Grade', val: draftExecutionGrade, set: setDraftExecutionGrade },
                  ].map(({ label, val, set }) => (
                    <div key={label}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {GRADES.map(g => (
                          <button key={g} onClick={() => set(val === g ? '' : g)}
                            style={{
                              flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 12, fontWeight: 700,
                              border: '1px solid var(--border)', cursor: 'pointer',
                              background: val === g ? ({ A: '#10b981', B: '#3b82f6', C: '#f59e0b', D: '#f97316', F: '#ef4444' }[g] || 'var(--accent)') : 'var(--bg-surface)',
                              color: val === g ? '#fff' : 'var(--text-muted)',
                              fontFamily: 'var(--font-sans)',
                            }}>{g}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Immutable strategy playbook snapshot */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center' }}>Strategy Playbook<InfoHint text={selectedTrade.playbookSnapshot ? "This recorded journal is permanently attached to the exact playbook version originally saved. You can edit its answers, but you cannot replace its strategy snapshot." : "Select the published strategy used for this trade. The first save permanently attaches that exact version to this journal."} /></div>
                  {selectedTrade.playbookSnapshot ? (
                    <div className="journal-playbook-lock">
                      <LockKeyhole size={16} />
                      <div><strong>{selectedTrade.playbookSnapshot.name} · v{selectedTrade.playbookSnapshot.versionNumber}</strong><span>Immutable audit snapshot · Schema {selectedTrade.playbookSnapshot.schemaVersion || 1}</span></div>
                    </div>
                  ) : <>
                    <select value={draftPlaybookSnapshot?.playbookId || ''} onChange={event => selectPlaybookForTrade(event.target.value)} style={{ width: '100%', minHeight: 42, padding: '0 10px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 12 }}>
                      <option value="">— Select a published strategy —</option>
                      {playbooks.filter(playbook => !playbook.archived).map(playbook => {
                        const version = playbook.versions[playbook.versions.length - 1];
                        return <option key={playbook.playbookId} value={playbook.playbookId}>{playbook.name} · v{version.versionNumber}</option>;
                      })}
                    </select>
                    {draftPlaybookSnapshot && <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--text-muted)' }}>This will attach {draftPlaybookSnapshot.name} v{draftPlaybookSnapshot.versionNumber} permanently when you save.</div>}
                  </>}
                </div>

                {draftPlaybookSnapshot && <>
                  <div className="journal-phase-tabs">
                    {JOURNAL_PHASES.map(phase => {
                      const phaseRules = draftPlaybookSnapshot.blocks.filter(block => phase.categories.includes(block.category)).flatMap(block => block.rules);
                      const completed = phaseRules.filter(rule => hasPlaybookAnswer(draftPlaybookResponses[rule.ruleId])).length;
                      return <button key={phase.id} type="button" className={activePlaybookPhase === phase.id ? 'active' : ''} onClick={() => setActivePlaybookPhase(phase.id)}><span>{phase.label}</span><small>{completed}/{phaseRules.length} answered</small></button>;
                    })}
                  </div>

                  {draftPlaybookSnapshot.blocks.filter(block => (JOURNAL_PHASES.find(phase => phase.id === activePlaybookPhase)?.categories || []).includes(block.category)).map(block => (
                    <div key={block.blockId} className="journal-playbook-stage">
                      <div className="journal-playbook-stage-title"><strong>{block.name}</strong><span>{block.rules.filter(rule => rule.required || rule.exampleRequirement?.required).length} required</span></div>
                      {(block.evidence || []).length > 0 && <div className="journal-playbook-evidence">
                        {(block.evidence || []).map(item => <figure key={item.evidenceId} className={item.kind}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={item.url} alt={item.caption} />
                          <figcaption><strong>{item.kind === 'valid' ? 'Valid' : item.kind === 'invalid' ? 'Avoid' : 'Reference'}</strong>{item.caption}</figcaption>
                        </figure>)}
                      </div>}
                      <div style={{ display: 'grid', gap: 10 }}>
                        {block.rules.map(rule => (
                          <div key={rule.ruleId} style={{ display: 'grid', gap: 5 }}>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rule.label}{rule.required || rule.exampleRequirement?.required ? ' *' : ''}</span>
                            <div className="journal-rule-context"><span>{RULE_TOOL_LABELS[rule.toolRole || 'observation'] || 'Observation'}</span><span>{rule.timeframes?.length ? rule.timeframes.join(' · ') : 'All timeframes'}</span></div>
                            {rule.helpText && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>{rule.helpText}</span>}
                            {rule.failureAction && rule.failureAction !== 'none' && <div className={`journal-rule-decision${rule.inputType === 'boolean' && draftPlaybookResponses[rule.ruleId] === false ? ' active' : ''}`}><strong>If not satisfied: {FAILURE_ACTION_LABELS[rule.failureAction] || rule.failureAction}</strong>{rule.failureMessage && <span>{rule.failureMessage}</span>}</div>}
                            {(rule.examples || []).length > 0 && <div className="journal-rule-examples">{(rule.examples || []).map(example => <figure key={example.evidenceId} className={example.kind}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={example.url} alt={example.caption} />
                              <figcaption><strong>{example.kind === 'valid' ? 'Valid' : example.kind === 'invalid' ? 'Avoid' : 'Reference'}</strong>{example.caption}</figcaption>
                            </figure>)}</div>}
                            {renderPlaybookInput(rule)}
                            {rule.exampleRequirement?.required && (() => {
                              const confirmations = (selectedTrade.screenshots || []).filter(screenshot => screenshot.playbookRuleId === rule.ruleId && screenshot.playbookVersionId === draftPlaybookSnapshot.versionId);
                              const minimum = rule.exampleRequirement.minimumImages || 1;
                              const complete = confirmations.length >= minimum;
                              return <div className={`journal-rule-confirmation ${complete ? 'complete' : 'missing'}`}>
                                <div className="journal-rule-confirmation-heading">
                                  <div><strong><ImageIcon size={13} /> Trade screenshot confirmation</strong><span>Upload your chart from this trade—not the playbook reference.</span></div>
                                  <span className="journal-rule-confirmation-count">{confirmations.length}/{minimum} required</span>
                                </div>
                                {confirmations.length > 0 && <div className="journal-rule-confirmation-grid">{confirmations.map(screenshot => <figure key={screenshot._id || screenshot.publicId}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={screenshot.url} alt={screenshot.caption || `Confirmation for ${rule.label}`} />
                                  <figcaption>{screenshot.caption || rule.label}</figcaption>
                                  <button type="button" onClick={() => void handleScreenshotDelete(screenshot._id)} aria-label={`Remove screenshot confirmation for ${rule.label}`}><Trash2 size={13} /></button>
                                </figure>)}</div>}
                                <label className={`journal-rule-confirmation-upload${uploadingScreenshot || confirmations.length >= rule.exampleRequirement.maximumImages ? ' disabled' : ''}`}>
                                  <Upload size={14} />{uploadingScreenshot ? 'Uploading…' : confirmations.length ? 'Add another screenshot' : 'Add trade screenshot'}
                                  <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploadingScreenshot || confirmations.length >= rule.exampleRequirement.maximumImages} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadScreenshotFile(file, rule); }} />
                                </label>
                                {!complete && <span className="journal-rule-confirmation-error" role="alert">A screenshot is required before this journal can be saved.</span>}
                              </div>;
                            })()}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {draftPlaybookSnapshot.blocks.filter(block => (JOURNAL_PHASES.find(phase => phase.id === activePlaybookPhase)?.categories || []).includes(block.category)).length === 0 && <div className="journal-phase-empty">This playbook has no fields in the {activePlaybookPhase} stage.</div>}
                </>}

                {/* Legacy fields remain in stored data for backward compatibility. */}
                {false && <>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Primary Setup</div>
                  <select
                    value={draftPrimarySetup}
                    onChange={e => setDraftPrimarySetup(e.target.value)}
                    style={{
                      width: '100%', padding: '7px 10px', borderRadius: 8,
                      background: 'var(--bg-surface)', border: '1px solid var(--border)',
                      color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-sans)',
                    }}
                  >
                    <option value="">— Select setup —</option>
                    {['HTF Supply', 'HTF Demand', 'Liquidity Sweep', 'Trendline Break', 'IFVG', 'FVG', 'ORB', 'MSS', 'BOS', 'Displacement', 'Other'].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* Setup Confirmations */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Setup Confirmations</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {['IFVG', 'FVG', 'Liquidity Sweep', 'Trendline Break', 'MSS', 'BOS', 'HTF Zone', 'Displacement', 'Session', 'News Catalyst'].map(c => {
                      const active = draftSetupConfirmations.includes(c);
                      return (
                        <button key={c} onClick={() => setDraftSetupConfirmations(
                          active ? draftSetupConfirmations.filter(x => x !== c) : [...draftSetupConfirmations, c]
                        )} style={{
                          padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          border: `1px solid ${active ? '#6366f1' : 'var(--border)'}`,
                          background: active ? '#6366f120' : 'var(--bg-surface)',
                          color: active ? '#818cf8' : 'var(--text-muted)',
                          cursor: 'pointer', fontFamily: 'var(--font-sans)',
                        }}>{c}</button>
                      );
                    })}
                  </div>
                </div>

                </>}

                {/* Planned R:R + Confidence */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Planned R:R</div>
                    <input
                      type="number" step="0.1" min="0" placeholder="e.g. 3.5"
                      value={draftPlannedRR}
                      onChange={e => setDraftPlannedRR(e.target.value)}
                      style={{
                        width: '100%', padding: '7px 10px', borderRadius: 8,
                        background: 'var(--bg-surface)', border: '1px solid var(--border)',
                        color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-mono)',
                        boxSizing: 'border-box',
                      }}
                    />
                    {/* Missed profit display */}
                    {draftPlannedRR && !['TP', 'SL', ''].includes(draftExitReason) && draftExitReason && selectedTrade.pnlUSD > 0 && (
                      <div style={{ marginTop: 5, padding: '6px 8px', background: '#ef444415', borderRadius: 6, fontSize: 11, color: '#ef4444' }}>
                        ⚠️ Planned {draftPlannedRR}R · Missed ~{(parseFloat(draftPlannedRR) - (selectedTrade.pnlPct / 1)).toFixed(1)}R
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Pre-Trade Confidence: {draftConfidence ?? '—'}/10</div>
                    <input
                      type="range" min="1" max="10" step="1"
                      value={draftConfidence ?? 5}
                      onChange={e => setDraftConfidence(Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#6366f1' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
                      <span>1 – Uncertain</span><span>10 – Confident</span>
                    </div>
                  </div>
                </div>

                {/* Exit Reason + Manual Intervention */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Exit Reason</div>
                    <select
                      value={draftExitReason}
                      onChange={e => setDraftExitReason(e.target.value)}
                      style={{
                        width: '100%', padding: '7px 10px', borderRadius: 8,
                        background: 'var(--bg-surface)', border: '1px solid var(--border)',
                        color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <option value="">— Select —</option>
                      {['TP', 'SL', 'Fear', 'Revenge', 'News', 'ManualClose', 'FOMO', 'PartialClose', 'Other'].map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Manually Intervened?</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {([{ v: true, label: 'Yes', color: '#ef4444' }, { v: false, label: 'No', color: '#10b981' }, { v: null, label: '?', color: 'var(--text-muted)' }] as const).map(({ v, label, color }) => (
                        <button key={label} onClick={() => setDraftManuallyIntervened(v as any)}
                          style={{
                            flex: 1, padding: '6px 0', borderRadius: 8, fontSize: 12, fontWeight: 700,
                            border: `1px solid ${draftManuallyIntervened === v ? color : 'var(--border)'}`,
                            background: draftManuallyIntervened === v ? `${color}20` : 'var(--bg-surface)',
                            color: draftManuallyIntervened === v ? color : 'var(--text-muted)',
                            cursor: 'pointer', fontFamily: 'var(--font-sans)',
                          }}>{label}</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Legacy execution checklist retained only for old data compatibility. */}
                {false && <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Execution Checklist (post-trade)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {draftExecChecklist.map((item, idx) => (
                      <div
                        key={idx}
                        className={`checklist-item ${item.complied ? 'checked' : ''}`}
                        onClick={() => {
                          const copy = [...draftExecChecklist];
                          copy[idx] = { ...copy[idx], complied: !copy[idx].complied };
                          setDraftExecChecklist(copy);
                        }}
                      >
                        <div className="checklist-checkbox">
                          {item.complied && <span style={{ fontSize: 10 }}>✓</span>}
                        </div>
                        <span className="checklist-label">{item.rule}</span>
                      </div>
                    ))}
                  </div>
                  {draftExecChecklist.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                      Plan adherence: <strong style={{ color: (() => { const pct = (draftExecChecklist.filter(i => i.complied).length / draftExecChecklist.length) * 100; return pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444'; })() }}>
                        {Math.round((draftExecChecklist.filter(i => i.complied).length / draftExecChecklist.length) * 100)}%
                      </strong>
                    </div>
                  )}
                </div>}
              </div>
              {/* ── END EDGE COACH ──────────────────────────────────────────── */}

              {/* ── Re-Entry Section ─────────────────────────────────────────── */}
              <div className="drawer-section" style={{ padding: '12px 16px', background: draftIsReEntry ? '#6366f108' : 'transparent', borderRadius: 10, border: draftIsReEntry ? '1px solid #6366f130' : '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: draftIsReEntry ? 10 : 0 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: draftIsReEntry ? '#818cf8' : 'var(--text-primary)' }}>
                      🔁 Re-Entry
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      Is this a re-entry on a previous trade setup?
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const newIsReEntry = !draftIsReEntry;
                      setDraftIsReEntry(newIsReEntry);
                      if (!newIsReEntry) {
                        setDraftParentTradeId('');
                      }
                    }}
                    style={{
                      width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                      background: draftIsReEntry ? '#6366f1' : 'var(--border)',
                      position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                    }}
                    aria-label="Toggle re-entry"
                  >
                    <span style={{
                      position: 'absolute', top: 3, left: draftIsReEntry ? 22 : 3,
                      width: 18, height: 18, borderRadius: '50%',
                      background: '#fff', transition: 'left 0.2s',
                    }} />
                  </button>
                </div>

                {draftIsReEntry && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10, position: 'relative' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Select Parent Trade (Same Symbol)</div>
                    {(() => {
                      // Filter trades to find potential parents: same symbol, closed before current trade
                      const potentialParents = trades.filter(t => 
                        t.symbol === selectedTrade.symbol && 
                        t._id !== selectedTrade._id && 
                        new Date(t.closeTime) <= new Date(selectedTrade.closeTime)
                      );

                      if (potentialParents.length === 0) {
                        return <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No previous trades found for {selectedTrade.symbol} on this page.</div>;
                      }

                      // Filter based on search query
                      const filteredParents = potentialParents.filter(p => 
                        !parentSearchQuery || 
                        p.dealId.includes(parentSearchQuery) || 
                        p.direction.toLowerCase().includes(parentSearchQuery.toLowerCase()) || 
                        (p.notes || '').toLowerCase().includes(parentSearchQuery.toLowerCase())
                      );

                      const selectedParentObj = potentialParents.find(p => p._id === draftParentTradeId);

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
                          <div style={{ position: 'relative' }}>
                            <input
                              type="text"
                              placeholder={selectedParentObj ? `Ticket #${selectedParentObj.dealId} selected (Type to search)` : 'Type to search ticket # or direction...'}
                              value={parentSearchQuery}
                              onChange={e => {
                                setParentSearchQuery(e.target.value);
                                setShowParentDropdown(true);
                              }}
                              onFocus={() => setShowParentDropdown(true)}
                              style={{
                                width: '100%', padding: '7px 10px', borderRadius: 8,
                                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                                color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-sans)',
                                boxSizing: 'border-box'
                              }}
                            />
                            {parentSearchQuery && (
                              <button
                                type="button"
                                onClick={() => {
                                  setParentSearchQuery('');
                                  setDraftParentTradeId('');
                                }}
                                style={{
                                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                                  background: 'none', border: 'none', color: 'var(--text-muted)',
                                  cursor: 'pointer', fontSize: 11
                                }}
                              >
                                Clear
                              </button>
                            )}
                          </div>

                          {/* Dropdown popup */}
                          {showParentDropdown && (
                            <>
                              <div 
                                onClick={() => setShowParentDropdown(false)}
                                style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }}
                              />
                              <div style={{
                                position: 'absolute', top: 36, left: 0, right: 0, maxHeight: 200,
                                overflowY: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border)',
                                borderRadius: 8, boxShadow: 'var(--shadow-lg)', zIndex: 999,
                                display: 'flex', flexDirection: 'column'
                              }}>
                                {filteredParents.length === 0 ? (
                                  <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                    No matching trades found
                                  </div>
                                ) : (
                                  filteredParents.map(p => {
                                    const pnlText = p.pnlUSD >= 0 ? `+$${p.pnlUSD.toFixed(2)}` : `-$${Math.abs(p.pnlUSD).toFixed(2)}`;
                                    const isSelected = p._id === draftParentTradeId;
                                    return (
                                      <button
                                        key={p._id}
                                        type="button"
                                        onClick={() => {
                                          setDraftParentTradeId(p._id);
                                          setParentSearchQuery(''); // reset search
                                          setShowParentDropdown(false);
                                        }}
                                        style={{
                                          width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none',
                                          background: isSelected ? '#6366f120' : 'transparent',
                                          color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer',
                                          borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-sans)',
                                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                                        }}
                                      >
                                        <div>
                                          <strong style={{ color: isSelected ? '#818cf8' : 'inherit' }}>Ticket #{p.dealId}</strong>
                                          <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>({p.direction} lots: {p.lotSize})</span>
                                        </div>
                                        <span style={{ color: p.pnlUSD >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>{pnlText}</span>
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            </>
                          )}

                          {selectedParentObj && (
                            <div style={{ 
                              padding: '8px 12px', background: 'var(--bg-elevated)', borderRadius: 8, 
                              border: '1px solid var(--border)', fontSize: 11, display: 'flex', 
                              flexDirection: 'column', gap: 4 
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ fontWeight: 600 }}>Linked Parent:</span>
                                <span style={{ fontFamily: 'var(--font-mono)' }}>Ticket #{selectedParentObj.dealId}</span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                                <span>{selectedParentObj.direction} · {selectedParentObj.lotSize} lot(s)</span>
                                <span style={{ color: selectedParentObj.pnlUSD >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                                  {selectedParentObj.pnlUSD >= 0 ? '+' : ''}${selectedParentObj.pnlUSD.toFixed(2)}
                                </span>
                              </div>
                            </div>
                          )}

                          {draftParentTradeId && (
                            <button
                              type="button"
                              onClick={() => {
                                const parent = potentialParents.find(p => p._id === draftParentTradeId);
                                if (parent) {
                                  if (parent.notes) setDraftNotes(parent.notes);
                                  if (parent.emotion) setDraftEmotion(parent.emotion);
                                  if (parent.grade) setDraftGrade(parent.grade);
                                  if (parent.tags) setDraftTags(parent.tags);
                                  if (parent.analysisGrade) setDraftAnalysisGrade(parent.analysisGrade);
                                  if (parent.executionGrade) setDraftExecutionGrade(parent.executionGrade);
                                  if (parent.primarySetup) setDraftPrimarySetup(parent.primarySetup);
                                  if (parent.setupConfirmations) setDraftSetupConfirmations(parent.setupConfirmations);
                                  if (parent.executionChecklist) setDraftExecChecklist(parent.executionChecklist);
                                  alert('Details inherited from parent! You can still customize them before saving.');
                                }
                              }}
                              style={{
                                width: '100%', padding: '6px 0', borderRadius: 8, fontSize: 11, fontWeight: 700,
                                border: '1px solid #6366f140', background: '#6366f115', color: '#818cf8',
                                cursor: 'pointer', fontFamily: 'var(--font-sans)', transition: 'background 0.2s'
                              }}
                            >
                              📥 Inherit Parent Details (Notes, Checklist, etc.)
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Trader Emotion / Mindset */}
              <div className="drawer-section">
                <span className="drawer-section-title"><Smile size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Emotional Mindset</span>
                <div className="emotion-grid">
                  {EMOTIONS.map(e => (
                    <button
                      key={e.name}
                      className={`emotion-pill ${draftEmotion === e.name ? `active ${e.name}` : ''}`}
                      onClick={() => setDraftEmotion(e.name)}
                    >
                      <span>{e.emoji}</span>
                      <span>{e.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Legacy flat checklist is preserved in stored trades but replaced by playbook blocks. */}
              {false && <div className="drawer-section">
                <span className="drawer-section-title"><CheckSquare size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Rules Checklist</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {draftChecklist.map((item, idx) => (
                    <div
                      key={idx}
                      className={`checklist-item ${item.complied ? 'checked' : ''}`}
                      onClick={() => toggleChecklistItem(idx)}
                    >
                      <div className="checklist-checkbox">
                        {item.complied && <span style={{ fontSize: 10 }}>✓</span>}
                      </div>
                      <span className="checklist-label">{item.rule}</span>
                    </div>
                  ))}
                </div>
              </div>}

              {/* Custom Tag Input */}
              <div className="drawer-section">
                <span className="drawer-section-title"><Tag size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Strategy / Custom Tags</span>
                <form onSubmit={handleAddTag} className="tags-input-wrap">
                  {draftTags.map(t => (
                    <span className="tag-badge" key={t}>
                      #{t}
                      <button type="button" onClick={() => handleRemoveTag(t)}>×</button>
                    </span>
                  ))}
                  <input
                    type="text"
                    className="tags-input-element"
                    placeholder="+ add tag..."
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                  />
                </form>
              </div>

              {/* Chart Screenshots */}
              <div className="drawer-section">
                <span className="drawer-section-title"><ImageIcon size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Chart Screenshots</span>
                <div
                  className={`screenshot-paste-zone ${uploadingScreenshot ? 'uploading' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label="Paste chart screenshot here"
                  onPaste={handleScreenshotPaste}
                >
                  <ImageIcon size={18} />
                  <div>
                    <strong>{uploadingScreenshot ? 'Uploading screenshot...' : 'Paste screenshot here'}</strong>
                    <span>Click this box, then press Ctrl+V</span>
                  </div>
                </div>
                <div className="screenshot-upload-panel">
                  <input
                    type="text"
                    className="screenshot-caption-input"
                    placeholder="Optional caption for pasted or uploaded screenshot"
                    value={screenshotCaption}
                    onChange={e => setScreenshotCaption(e.target.value)}
                    maxLength={180}
                  />
                  <label className={`btn btn-ghost screenshot-upload-btn ${uploadingScreenshot ? 'disabled' : ''}`}>
                    <Upload size={14} />
                    {uploadingScreenshot ? 'Uploading...' : 'Upload'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleScreenshotUpload}
                      disabled={uploadingScreenshot}
                      hidden
                    />
                  </label>
                </div>

                {selectedTrade.screenshots && selectedTrade.screenshots.length > 0 ? (
                  <div className="screenshot-grid">
                    {selectedTrade.screenshots.map(shot => (
                      <div className="screenshot-tile" key={shot._id}>
                        <button className="screenshot-thumb-btn" onClick={() => setPreviewScreenshot(shot)}>
                          <img src={shot.url} alt={shot.caption || `${selectedTrade.symbol} trade screenshot`} loading="lazy" />
                        </button>
                        <input
                          className="screenshot-inline-caption"
                          value={shot.caption || ''}
                          placeholder="Add caption..."
                          maxLength={180}
                          onChange={e => {
                            const caption = e.target.value;
                            const updatedScreenshots = (selectedTrade.screenshots || []).map(s =>
                              s._id === shot._id ? { ...s, caption } : s
                            );
                            updateTradeInState({ ...selectedTrade, screenshots: updatedScreenshots });
                          }}
                          onBlur={e => handleScreenshotCaptionChange(shot._id, e.target.value)}
                        />
                        <button className="screenshot-delete-btn" onClick={() => handleScreenshotDelete(shot._id)} aria-label="Delete screenshot">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="screenshot-empty">
                    <ImageIcon size={16} />
                    <span>No screenshots attached yet</span>
                  </div>
                )}
              </div>

              {/* Journal Notes */}
              <div className="drawer-section">
                <span className="drawer-section-title">Journal Notes</span>
                <textarea
                  className="drawer-textarea"
                  placeholder="Record your thoughts, lessons learned, chart confluence reasons, or setup observations..."
                  value={draftNotes}
                  onChange={e => setDraftNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="drawer-footer">
              <button 
                className="btn btn-primary" 
                style={{ flex: 1, justifyContent: 'center' }} 
                onClick={handleSaveJournal}
                disabled={saving}
              >
                <Save size={14} />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button 
                className="btn btn-ghost" 
                onClick={() => { setSelectedTrade(null); updateQuery({ trade: null }); }}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </div>

          {previewScreenshot && (
            <div className="screenshot-preview-overlay" onClick={() => setPreviewScreenshot(null)}>
              <div className="screenshot-preview-modal" onClick={e => e.stopPropagation()}>
                <div className="screenshot-preview-header">
                  <div>
                    <div className="card-title">Chart Screenshot</div>
                    {previewScreenshot.caption && (
                      <div className="card-subtitle">{previewScreenshot.caption}</div>
                    )}
                  </div>
                  <button className="drawer-close" onClick={() => setPreviewScreenshot(null)}>
                    <X size={16} />
                  </button>
                </div>
                <img
                  src={previewScreenshot.url}
                  alt={previewScreenshot.caption || `${selectedTrade.symbol} trade screenshot`}
                  className="screenshot-preview-image"
                />
                <div className="screenshot-preview-footer">
                  <button className="btn btn-danger" onClick={() => handleScreenshotDelete(previewScreenshot._id)}>
                    <Trash2 size={14} />
                    Delete Screenshot
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {replayTradeId && selectedTrade && <TradeReplayModal
        tradeId={replayTradeId}
        tradeSummary={{
          symbol: selectedTrade.symbol,
          direction: selectedTrade.direction,
          pnlUSD: selectedTrade.pnlUSD,
          pnlPct: selectedTrade.pnlPct,
          entryPrice: selectedTrade.entryPrice,
          exitPrice: selectedTrade.exitPrice,
          openTime: selectedTrade.openTime,
          closeTime: selectedTrade.closeTime,
          durationMinutes: selectedTrade.durationMinutes,
          lotSize: selectedTrade.lotSize,
        }}
        initialInterval={searchParams.get('tf') || undefined}
        initialJournalPhase={(searchParams.get('phase') as JournalPhase) || undefined}
        onIntervalChange={interval => updateQuery({ tf: interval })}
        onJournalPhaseChange={phase => updateQuery({ phase })}
        onClose={() => { setReplayTradeId(null); updateQuery({ replay: null, tf: null, phase: null }); }}
        onSaved={updates => {
          setTrades(current => current.map(trade => trade._id === replayTradeId ? { ...trade, ...updates } : trade));
          setSelectedTrade(current => current ? { ...current, ...updates } : current);
          setDraftNotes(updates.notes);
          setDraftEmotion(updates.emotion);
          setDraftGrade(updates.grade);
          setDraftTags(updates.tags);
          setReplayTradeId(null);
          updateQuery({ replay: null, tf: null, phase: null });
        }}
      />}
    </div>
  );
}

export default function TradesPage() {
  return <Suspense fallback={<div className="loading-wrap"><div className="spinner" /></div>}><TradesPageContent /></Suspense>;
}
