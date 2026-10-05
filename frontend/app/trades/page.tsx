'use client';
import { Suspense, useEffect, useState, useCallback, useRef, useMemo, Fragment } from 'react';
import { PAGE_PURPOSE } from '@/components/pagePurpose';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import InfoHint from '@/components/InfoHint';
import TradeReplayModal from '@/components/TradeReplayModal';
import ExportForAI from '@/components/ExportForAI';
import Mt5StatementImport from '@/components/Mt5StatementImport';
import PlaybookRuleInput from '@/components/PlaybookRuleInput';
import type { PlaybookRule, PlaybookBlock, PlaybookSnapshot, Playbook } from '@/types/playbook';
import {
  SlidersHorizontal, ChevronLeft, ChevronRight, List,
  X, Award, CheckSquare, Save, Info,
  Upload, Image as ImageIcon, Trash2, Copy, Check, LockKeyhole, Play, Sun, Plus, Sparkles, FileUp
} from 'lucide-react';
import { useAccountKeyFilter } from '@/hooks/useAccountKeyFilter';

const API = '/api';
const PAGE_SIZE = 50;
const GROUPED_LIMIT = 2000; // grouping needs the full filtered set, not one page

// Same UTC-hour boundaries as the "P&L by Session" breakdown on the Stats
// page (backend/routes/trades.js /api/stats) -- kept in sync deliberately so
// a trade lands in the same session bucket everywhere in the app.
const SESSION_ORDER = ['Tokyo', 'London', 'Overlap', 'NewYork', 'Pacific'] as const;
type SessionKey = typeof SESSION_ORDER[number];
const SESSION_LABELS: Record<SessionKey, string> = {
  Tokyo: 'Tokyo (Asian)',
  London: 'London (Europe)',
  Overlap: 'London/NY Overlap',
  NewYork: 'New York (US)',
  Pacific: 'Pacific/Late NY',
};
function sessionForTrade(closeTime: string): SessionKey {
  const hour = new Date(closeTime).getUTCHours();
  if (hour >= 0 && hour < 8) return 'Tokyo';
  if (hour >= 8 && hour < 13) return 'London';
  if (hour >= 13 && hour < 16) return 'Overlap';
  if (hour >= 16 && hour < 21) return 'NewYork';
  return 'Pacific';
}

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
  takeProfit?: number | null;
  riskPercent?: number | null;
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
  reEntryReason?: string;
  playbookId?: string;
  playbookVersionId?: string;
  playbookSnapshot?: PlaybookSnapshot | null;
  playbookResponses?: Record<string, unknown>;
  manualEntry?: boolean;
}

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


// What the trade did to the balance: pnlUSD is the price profit, and
// commission and swap are stored separately (as the Stats pages count them).
const netPnl = (t: { pnlUSD: number; commission?: number; swap?: number }) => t.pnlUSD + (t.commission || 0) + (t.swap || 0);
// pnlPct is the price profit over the balance before the trade; scaled to the net.
const netPct = (t: { pnlUSD: number; pnlPct: number; commission?: number; swap?: number }) => (t.pnlUSD ? (t.pnlPct * netPnl(t)) / t.pnlUSD : 0);

// A stop counts as the trade's risk only on the losing side of the entry.
function stopLossProblem(trade: { direction: string; entryPrice: number }, draft: string) {
  if (draft.trim() === '') return '';
  const stop = Number(draft);
  if (!Number.isFinite(stop) || stop <= 0) return 'Stop loss must be a price above 0.';
  const sell = String(trade.direction).toUpperCase() === 'SELL';
  if (sell ? stop <= trade.entryPrice : stop >= trade.entryPrice) {
    return `A ${sell ? 'sell' : 'buy'}'s stop loss has to be ${sell ? 'above' : 'below'} its entry price (${trade.entryPrice}).`;
  }
  return '';
}

// R on price alone (before commission and swap), for a preview while typing.
function priceR(trade: { direction: string; entryPrice: number; exitPrice: number }, stop: number) {
  const risk = Math.abs(trade.entryPrice - stop);
  if (!(risk > 0)) return null;
  const sign = String(trade.direction).toUpperCase() === 'SELL' ? -1 : 1;
  return ((trade.exitPrice - trade.entryPrice) * sign) / risk;
}

const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

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
  const [openPreTradeAnalyses, setOpenPreTradeAnalyses] = useState<Array<{ _id: string; symbol: string; direction: string; playbookSnapshot: PlaybookSnapshot; responses: Record<string, unknown>; notes: string }>>([]);
  const [selectedPreTradeAnalysisId, setSelectedPreTradeAnalysisId] = useState('');

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
  const [accountKeyFilter, setAccountKeyFilter, accountFilterReady, setKnownAccounts] = useAccountKeyFilter(searchParams.get('accountKey') || undefined);
  const [from, setFrom]           = useState(() => searchParams.get('from') || '');
  const [to, setTo]               = useState(() => searchParams.get('to') || '');
  const [symbols, setSymbols]     = useState<string[]>([]);
  const [tradeAccounts, setTradeAccounts] = useState<TradeAccountOption[]>([]);
  const [unassignedAccountCount, setUnassignedAccountCount] = useState(0);
  const [groupBySession, setGroupBySession] = useState(false);

  useEffect(() => {
    if (!hasToken) return;
    const token = localStorage.getItem('token');
    fetch(`${API}/trade-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not load trading accounts')))
      .then(body => {
        setTradeAccounts(body.accounts || []);
        setUnassignedAccountCount(Number(body.unassignedCount || 0));
        setKnownAccounts(body.accounts || [], Number(body.unassignedCount || 0));
      })
      .catch(error => console.error(error));
  }, [hasToken]);

  // Journal Drawer State
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [draftNotes, setDraftNotes] = useState('');
  const [draftEmotion, setDraftEmotion] = useState('');
  const [draftGrade, setDraftGrade] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftChecklist, setDraftChecklist] = useState<ChecklistItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [screenshotCaption, setScreenshotCaption] = useState('');
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);
  // Edge Coach draft state
  const [draftAnalysisGrade, setDraftAnalysisGrade] = useState('');
  const [draftExecutionGrade, setDraftExecutionGrade] = useState('');
  const [draftPlannedRR, setDraftPlannedRR] = useState('');
  const [draftStopLoss, setDraftStopLoss] = useState('');
  const [draftTakeProfit, setDraftTakeProfit] = useState('');
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
  const [draftReEntryReason, setDraftReEntryReason] = useState('');
  const [parentSearchQuery, setParentSearchQuery] = useState('');
  const [showParentDropdown, setShowParentDropdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draftPlaybookSnapshot, setDraftPlaybookSnapshot] = useState<PlaybookSnapshot | null>(null);
  const [draftPlaybookResponses, setDraftPlaybookResponses] = useState<Record<string, unknown>>({});
  const [activePlaybookPhase, setActivePlaybookPhase] = useState<JournalPhase>('plan');
  const [replayTradeId, setReplayTradeId] = useState<string | null>(null);
  const [showAddTrade, setShowAddTrade] = useState(false);
  const [showExportAI, setShowExportAI] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    if (!accountFilterReady) return;
    setLoading(true);
    // Grouping by session needs the whole filtered set at once -- a session
    // bucket split across pages would be misleading -- so it trades
    // pagination for a single larger fetch instead.
    const params = new URLSearchParams({
      page: groupBySession ? '1' : String(page),
      limit: groupBySession ? String(GROUPED_LIMIT) : String(PAGE_SIZE),
      ...(symbol    && { symbol }),
      ...(direction && { direction }),
      ...(accountTypeFilter && { accountType: accountTypeFilter }),
      ...(accountKeyFilter && { accountKey: accountKeyFilter }),
      // Whole days in your own time zone: from the start of "From" to the end of "To".
      ...(from      && { from: new Date(`${from}T00:00:00`).toISOString() }),
      ...(to        && { to: new Date(`${to}T23:59:59.999`).toISOString() }),
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
  }, [page, symbol, direction, accountTypeFilter, accountKeyFilter, accountFilterReady, from, to, router, groupBySession]);

  useEffect(() => { load(); }, [load]);

  const resetFilters = () => {
    setSymbol(''); setDirection(''); setAccountTypeFilter(''); setAccountKeyFilter(''); setFrom(''); setTo(''); setPage(1);
    updateQuery({ symbol: null, direction: null, account: null, accountKey: null, from: null, to: null, page: null });
  };

  // Grouped-by-session view: bucket the loaded trades by the same UTC-hour
  // session boundaries the Stats page's "P&L by Session" chart uses, then
  // flatten back into one array in a fixed session order so the existing
  // row-rendering code can iterate it unchanged. Session totals are
  // computed alongside for the header row of each group.
  const sessionGroups = useMemo(() => {
    const buckets: Record<SessionKey, Trade[]> = { Tokyo: [], London: [], Overlap: [], NewYork: [], Pacific: [] };
    for (const t of trades) buckets[sessionForTrade(t.closeTime)].push(t);
    return SESSION_ORDER.map(key => {
      const group = buckets[key];
      const netPnL = group.reduce((s, t) => s + netPnl(t), 0);
      const wins = group.filter(t => netPnl(t) >= 0).length;
      return { key, label: SESSION_LABELS[key], trades: group, netPnL, winRate: group.length ? (wins / group.length) * 100 : 0 };
    }).filter(g => g.trades.length > 0);
  }, [trades]);

  const displayTradesFlat = useMemo(
    () => groupBySession ? sessionGroups.flatMap(g => g.trades) : trades,
    [groupBySession, sessionGroups, trades]
  );

  // Re-entries manually linked to a parent (currently loaded on this page)
  // render as nested rows directly under it instead of scattered by time --
  // re-entries no longer carry their own journal, so their PnL is easiest to
  // read right alongside the setup that produced it.
  const displayTrades = useMemo(() => {
    const childrenByParent = new Map<string, Trade[]>();
    for (const t of displayTradesFlat) {
      if (t.isReEntry && t.parentTradeId && displayTradesFlat.some(p => p._id === t.parentTradeId)) {
        const list = childrenByParent.get(t.parentTradeId) || [];
        list.push(t);
        childrenByParent.set(t.parentTradeId, list);
      }
    }
    if (childrenByParent.size === 0) return displayTradesFlat.map(t => ({ trade: t, nested: false }));
    const nestedIds = new Set(Array.from(childrenByParent.values()).flat().map(t => t._id));
    const result: Array<{ trade: Trade; nested: boolean }> = [];
    for (const t of displayTradesFlat) {
      if (nestedIds.has(t._id)) continue;
      result.push({ trade: t, nested: false });
      for (const child of childrenByParent.get(t._id) || []) result.push({ trade: child, nested: true });
    }
    return result;
  }, [displayTradesFlat]);

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
    setScreenshotCaption('');
    // Edge Coach
    setDraftAnalysisGrade(trade.analysisGrade || '');
    setDraftExecutionGrade(trade.executionGrade || '');
    setDraftPlannedRR(trade.plannedRR != null ? String(trade.plannedRR) : '');
    setDraftStopLoss(trade.stopLoss != null ? String(trade.stopLoss) : '');
    setDraftTakeProfit(trade.takeProfit != null ? String(trade.takeProfit) : '');
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
    setDraftReEntryReason(trade.reEntryReason || '');
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

  const toggleChecklistItem = (index: number) => {
    const copy = [...draftChecklist];
    copy[index] = { ...copy[index], complied: !copy[index].complied };
    setDraftChecklist(copy);
  };

  const handleSaveJournal = async () => {
    if (!selectedTrade) return;
    // Re-entries inherit their playbook/journal from the parent trade already --
    // don't force re-filling required fields or screenshot confirmations for one.
    if (!draftIsReEntry) {
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
    }
    const stopProblem = stopLossProblem(selectedTrade, draftStopLoss);
    if (stopProblem) { alert(stopProblem); return; }
    // Only send the stop/target when they changed, so saving notes never
    // replaces the risk a broker sync recorded.
    const priceField = (draft: string, saved?: number | null) =>
      draft.trim() === (saved != null ? String(saved) : '') ? undefined : (draft.trim() === '' ? null : Number(draft));
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
          stopLoss: priceField(draftStopLoss, selectedTrade.stopLoss),
          takeProfit: priceField(draftTakeProfit, selectedTrade.takeProfit),
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
          reEntryReason: draftReEntryReason,
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
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Could not delete screenshot');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    const playbookId = draftPlaybookSnapshot?.playbookId;
    if (!playbookId || selectedTrade?.playbookSnapshot) { setOpenPreTradeAnalyses([]); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`/api/pre-trade-analyses?playbookId=${encodeURIComponent(playbookId)}&status=open`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.ok ? res.json() : { analyses: [] })
      .then(body => setOpenPreTradeAnalyses(body.analyses || []))
      .catch(() => setOpenPreTradeAnalyses([]));
  }, [draftPlaybookSnapshot?.playbookId, selectedTrade?.playbookSnapshot]);

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

  const inheritFromPreTradeAnalysis = async () => {
    const analysis = openPreTradeAnalyses.find(item => item._id === selectedPreTradeAnalysisId);
    if (!analysis || !selectedTrade) return;
    setDraftPlaybookSnapshot(analysis.playbookSnapshot);
    setDraftPlaybookResponses(analysis.responses || {});
    if (analysis.notes) setDraftNotes(current => current ? `${current}\n\n${analysis.notes}` : analysis.notes);
    const token = localStorage.getItem('token');
    if (token) {
      await fetch(`/api/pre-trade-analyses/${analysis._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'linked', linkedTradeId: selectedTrade._id }),
      }).catch(() => {});
    }
    setOpenPreTradeAnalyses(current => current.filter(item => item._id !== analysis._id));
    setSelectedPreTradeAnalysisId('');
    alert('Pre-trade analysis inherited! You can still customize the answers before saving.');
  };

  const setPlaybookResponse = (ruleId: string, value: unknown) => {
    setDraftPlaybookResponses(current => ({ ...current, [ruleId]: value }));
  };

  const renderPlaybookInput = (rule: PlaybookRule) => (
    <PlaybookRuleInput rule={rule} value={draftPlaybookResponses[rule.ruleId]} onChange={value => setPlaybookResponse(rule.ruleId, value)} />
  );

  return (
    <div>
      <div className="page-header">
        <div className="page-header-inner">
          <div>
            <h2>Trades</h2>
            <p><strong style={{ color: 'var(--text-secondary)' }}>{PAGE_PURPOSE['/trades'].question}</strong> {PAGE_PURPOSE['/trades'].detail} {total.toLocaleString()} closed positions synced.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => setShowExportAI(true)} title="Copy your trades and stats for ChatGPT, Claude or any AI to review">
              <Sparkles size={14} />
              Export for AI
            </button>
            <button className="btn btn-ghost" onClick={() => setShowImport(true)}
              title="Upload a report saved from MT5 (History → Report → HTML). For MT5 on a Mac, or without the Windows sync app.">
              <FileUp size={14} />
              Import MT5 statement
            </button>
            <button className="btn btn-primary" onClick={() => setShowAddTrade(true)}>
              <Plus size={14} />
              Add Trade
            </button>
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
        <button
          className={`btn ${groupBySession ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setGroupBySession(current => !current)}
          style={{ alignSelf: 'flex-end', flexShrink: 0 }}
          title="Cluster trades under Tokyo / London / London-NY Overlap / New York / Pacific headers, by close time (UTC)."
        >
          <Sun size={13} />
          {groupBySession ? 'Grouped by session' : 'Group by session'}
        </button>
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
                  {displayTrades.map(({ trade: t, nested }, i) => {
                    const isProfit = netPnl(t) >= 0;
                    // Color-coded grouping: tradeGroup takes priority over shared positionId
                    const groupKey = t.tradeGroup || (t.positionId || '');
                    const prevGroupKey = i > 0 ? (displayTrades[i-1].trade.tradeGroup || displayTrades[i-1].trade.positionId || '') : '';
                    const nextGroupKey = i < displayTrades.length - 1 ? (displayTrades[i+1].trade.tradeGroup || displayTrades[i+1].trade.positionId || '') : '';
                    const isGrouped = Boolean(groupKey && (groupKey === prevGroupKey || groupKey === nextGroupKey));
                    const groupColors = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#8b5cf6','#14b8a6'];
                    const colorIdx = groupKey ? (groupKey.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0) % groupColors.length) : 0;
                    const groupColor = isGrouped ? groupColors[colorIdx] : '';
                    const sessionHere = groupBySession ? sessionForTrade(t.closeTime) : null;
                    const startsNewSession = groupBySession && (i === 0 || sessionForTrade(displayTrades[i - 1].trade.closeTime) !== sessionHere);
                    const sessionSummary = startsNewSession ? sessionGroups.find(g => g.key === sessionHere) : null;
                    return (
                      <Fragment key={t._id}>
                        {sessionSummary && (
                          <tr key={`session-${sessionSummary.key}`} className="session-group-header-row">
                            <td colSpan={16} style={{ background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '9px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <Sun size={13} color="var(--accent)" />
                                {sessionSummary.label}
                                <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {sessionSummary.trades.length} trade{sessionSummary.trades.length === 1 ? '' : 's'}</span>
                                <span className={sessionSummary.netPnL >= 0 ? 'positive' : 'negative'} style={{ fontWeight: 700 }}>
                                  {sessionSummary.netPnL >= 0 ? '+' : ''}${Math.abs(sessionSummary.netPnL).toFixed(2)}
                                </span>
                                <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {sessionSummary.winRate.toFixed(0)}% win</span>
                              </span>
                            </td>
                          </tr>
                        )}
                      <tr
                        key={t._id}
                        className="clickable"
                        onClick={() => handleRowClick(t)}
                        title={nested ? `Re-entry of #${t.parentTradeId}` : isGrouped ? `Group: ${groupKey}` : 'Click to open journal drawer'}
                        style={{
                          ...(isGrouped ? { borderLeft: `3px solid ${groupColor}` } : {}),
                          ...(nested ? { background: 'var(--bg-elevated)', opacity: 0.85 } : {}),
                        }}
                      >
                        <td style={{ color: 'var(--text-muted)', fontWeight: 500, paddingLeft: nested ? 22 : undefined }}>
                          {nested && <span style={{ marginRight: 4, color: '#818cf8' }}>↳</span>}
                          {groupBySession ? i + 1 : (page - 1) * PAGE_SIZE + i + 1}
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
                          {t.manualEntry && (
                            <span style={{
                              display: 'inline-block', marginLeft: 5, fontSize: 9, fontWeight: 700,
                              background: 'var(--bg-hover)', color: 'var(--text-muted)',
                              border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle',
                            }} title="Hand-entered, not synced from a broker">MANUAL</span>
                          )}
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
                          {isProfit ? '+' : ''}${Math.abs(netPnl(t)).toFixed(2)}
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
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="pagination">
              {groupBySession ? (
                <span>
                  Showing all {trades.length.toLocaleString()} matching trades across {sessionGroups.length} session{sessionGroups.length === 1 ? '' : 's'}
                  {trades.length >= GROUPED_LIMIT && ' (capped — narrow the filters to see more)'}
                </span>
              ) : (
                <>
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
                </>
              )}
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
                    <span className={`detail-tile-val pnl ${netPnl(selectedTrade) >= 0 ? 'positive' : 'negative'}`}>
                      {netPnl(selectedTrade) >= 0 ? '+' : ''}${netPnl(selectedTrade).toFixed(2)} ({netPct(selectedTrade) >= 0 ? '+' : ''}{netPct(selectedTrade).toFixed(2)}%)
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

              {/* Re-entries roll their PnL up into the parent's journal instead of
                  keeping their own -- nothing to fill in, so the whole Edge Coach /
                  playbook block below is skipped entirely for them. */}
              {!draftIsReEntry && <>
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
                    {openPreTradeAnalyses.length > 0 && (
                      <div style={{ marginTop: 10, padding: 10, borderRadius: 8, border: '1px solid #6366f140', background: '#6366f115' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', marginBottom: 6 }}>Planned this one ahead of time?</div>
                        <select value={selectedPreTradeAnalysisId} onChange={e => setSelectedPreTradeAnalysisId(e.target.value)} style={{ width: '100%', minHeight: 38, padding: '0 9px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 12, marginBottom: 6 }}>
                          <option value="">— Select a pre-trade analysis —</option>
                          {openPreTradeAnalyses.map(item => (
                            <option key={item._id} value={item._id}>{item.symbol || 'No symbol'}{item.direction ? ` · ${item.direction}` : ''}</option>
                          ))}
                        </select>
                        <button type="button" disabled={!selectedPreTradeAnalysisId} onClick={inheritFromPreTradeAnalysis} style={{ width: '100%', padding: '6px 0', borderRadius: 8, fontSize: 11, fontWeight: 700, border: '1px solid #6366f140', background: '#6366f115', color: '#818cf8', cursor: selectedPreTradeAnalysisId ? 'pointer' : 'not-allowed', opacity: selectedPreTradeAnalysisId ? 1 : 0.5 }}>
                          📥 Inherit From Pre-Trade Analysis
                        </button>
                      </div>
                    )}
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
                            {rule.exampleRequirement?.required && !draftIsReEntry && (() => {
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
                                <div
                                  tabIndex={0}
                                  role="button"
                                  aria-label={`Paste a screenshot for ${rule.label}`}
                                  onPaste={event => {
                                    if (uploadingScreenshot || confirmations.length >= (rule.exampleRequirement?.maximumImages ?? Infinity)) return;
                                    const items = Array.from(event.clipboardData.items || []);
                                    const imageItem = items.find(item => item.type.startsWith('image/'));
                                    const file = imageItem?.getAsFile();
                                    if (!file) return;
                                    event.preventDefault();
                                    void uploadScreenshotFile(file, rule);
                                  }}
                                >
                                  <label className={`journal-rule-confirmation-upload${uploadingScreenshot || confirmations.length >= rule.exampleRequirement.maximumImages ? ' disabled' : ''}`}>
                                    <Upload size={14} />{uploadingScreenshot ? 'Uploading…' : confirmations.length ? 'Add another screenshot (or click here and press Ctrl+V)' : 'Add trade screenshot (or click here and press Ctrl+V)'}
                                    <input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploadingScreenshot || confirmations.length >= rule.exampleRequirement.maximumImages} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadScreenshotFile(file, rule); }} />
                                  </label>
                                </div>
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

                {/* Stop loss + take profit: the stop is what R is measured against */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  {([
                    ['Stop loss', draftStopLoss, setDraftStopLoss, 'trade-stop-loss'],
                    ['Take profit', draftTakeProfit, setDraftTakeProfit, 'trade-take-profit'],
                  ] as const).map(([label, value, setValue, id]) => (
                    <div key={id}>
                      <label htmlFor={id} style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</label>
                      <input
                        id={id}
                        type="number" step="any" min="0" inputMode="decimal"
                        placeholder={label === 'Stop loss' ? (selectedTrade.direction === 'SELL' ? `above ${selectedTrade.entryPrice}` : `below ${selectedTrade.entryPrice}`) : 'optional'}
                        value={value}
                        onChange={e => setValue(e.target.value)}
                        style={{
                          width: '100%', padding: '7px 10px', borderRadius: 8,
                          background: 'var(--bg-surface)', border: `1px solid ${label === 'Stop loss' && stopLossProblem(selectedTrade, value) ? '#ef4444' : 'var(--border)'}`,
                          color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-mono)',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  ))}
                  <div style={{ gridColumn: '1 / -1', fontSize: 11, color: stopLossProblem(selectedTrade, draftStopLoss) ? '#ef4444' : 'var(--text-muted)' }}>
                    {stopLossProblem(selectedTrade, draftStopLoss)
                      || (draftStopLoss.trim() !== '' && priceR(selectedTrade, Number(draftStopLoss)) != null
                        ? `Entry ${selectedTrade.entryPrice} → exit ${selectedTrade.exitPrice}: about ${fmtR(priceR(selectedTrade, Number(draftStopLoss)) as number)} on price. Saving works out the risk in money and counts it in Avg R.`
                        : selectedTrade.stopLoss == null ? 'No stop recorded. Add the stop you had at entry to count this trade in Avg R.' : '')}
                  </div>
                </div>

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
              </>}

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

                          <div style={{ marginTop: 10 }}>
                            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                              Reason for re-entering
                            </label>
                            <textarea
                              className="drawer-textarea"
                              style={{ minHeight: 50, fontSize: 12 }}
                              placeholder="Why did you re-enter this setup? e.g. price retested the level with confirmation..."
                              value={draftReEntryReason}
                              onChange={e => setDraftReEntryReason(e.target.value)}
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
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

              {/* Journal Notes -- re-entries use the "Reason for re-entering" field above instead */}
              {!draftIsReEntry && <div className="drawer-section">
                <span className="drawer-section-title">Journal Notes</span>
                <textarea
                  className="drawer-textarea"
                  placeholder="Record your thoughts, lessons learned, chart confluence reasons, or setup observations..."
                  value={draftNotes}
                  onChange={e => setDraftNotes(e.target.value)}
                />
              </div>}
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

        </>
      )}
      {replayTradeId && selectedTrade && <TradeReplayModal
        key={replayTradeId}
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
        onNavigate={direction => {
          const index = trades.findIndex(trade => trade._id === replayTradeId);
          if (index < 0) return;
          const target = trades[direction === 'prev' ? index - 1 : index + 1];
          if (!target) return;
          setSelectedTrade(target); setReplayTradeId(target._id);
          updateQuery({ trade: target._id, replay: target._id, tf: null, phase: null });
        }}
        canNavigatePrev={trades.findIndex(trade => trade._id === replayTradeId) > 0}
        canNavigateNext={(() => { const i = trades.findIndex(trade => trade._id === replayTradeId); return i >= 0 && i < trades.length - 1; })()}
      />}
      {showExportAI && (
        <ExportForAI
          filters={{ symbol, direction, accountType: accountTypeFilter, accountKey: accountKeyFilter || '', from, to }}
          onClose={() => setShowExportAI(false)}
        />
      )}
      {showImport && <Mt5StatementImport onClose={() => setShowImport(false)} onImported={() => load()} />}
      {showAddTrade && (
        <AddTradeModal
          onClose={() => setShowAddTrade(false)}
          onSaved={() => { setShowAddTrade(false); load(); }}
        />
      )}
    </div>
  );
}

function AddTradeModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY');
  const [entryPrice, setEntryPrice] = useState('');
  const [exitPrice, setExitPrice] = useState('');
  const [lotSize, setLotSize] = useState('');
  const [pnlUSD, setPnlUSD] = useState('');
  const [openTime, setOpenTime] = useState('');
  const [closeTime, setCloseTime] = useState('');
  const [accountType, setAccountType] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const field: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8,
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    color: 'var(--text-primary)', fontSize: 13,
  };
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 };

  const submit = async () => {
    setError('');
    if (!symbol.trim()) { setError('Symbol is required.'); return; }
    if (!entryPrice || !exitPrice || !lotSize || !pnlUSD) { setError('Entry price, exit price, lot size, and P&L are all required.'); return; }
    if (!openTime || !closeTime) { setError('Open and close time are both required.'); return; }
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API}/trades/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          symbol: symbol.trim(), direction,
          entryPrice: parseFloat(entryPrice), exitPrice: parseFloat(exitPrice),
          lotSize: parseFloat(lotSize), pnlUSD: parseFloat(pnlUSD),
          openTime: new Date(openTime).toISOString(), closeTime: new Date(closeTime).toISOString(),
          accountType, notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not save trade'); setSaving(false); return; }
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Could not save trade');
      setSaving(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" style={{ width: 460 }} onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h3>Add Trade</h3>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>For a trade your broker never recorded</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>
              On a Mac with MT5? Use Import MT5 statement on the Trades page to bring in all your trades at once.
            </span>
          </div>
          <button className="drawer-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="drawer-body" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <div>
              <label style={label}>Symbol</label>
              <input style={field} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. XAUUSD" />
            </div>
            <div>
              <label style={label}>Direction</label>
              <select style={field} value={direction} onChange={e => setDirection(e.target.value as 'BUY' | 'SELL')}>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={label}>Entry price</label>
              <input style={field} type="number" step="any" value={entryPrice} onChange={e => setEntryPrice(e.target.value)} />
            </div>
            <div>
              <label style={label}>Exit price</label>
              <input style={field} type="number" step="any" value={exitPrice} onChange={e => setExitPrice(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={label}>Lot size</label>
              <input style={field} type="number" step="any" value={lotSize} onChange={e => setLotSize(e.target.value)} />
            </div>
            <div>
              <label style={label}>P&amp;L ($)</label>
              <input style={field} type="number" step="any" value={pnlUSD} onChange={e => setPnlUSD(e.target.value)} placeholder="Negative for a loss" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={label}>Open time</label>
              <input style={field} type="datetime-local" value={openTime} onChange={e => setOpenTime(e.target.value)} />
            </div>
            <div>
              <label style={label}>Close time</label>
              <input style={field} type="datetime-local" value={closeTime} onChange={e => setCloseTime(e.target.value)} />
            </div>
          </div>
          <div>
            <label style={label}>Account type (optional)</label>
            <select style={field} value={accountType} onChange={e => setAccountType(e.target.value)}>
              <option value="">Unspecified</option>
              <option value="live">Live</option>
              <option value="demo">Demo</option>
            </select>
          </div>
          <div>
            <label style={label}>Notes (optional)</label>
            <textarea className="drawer-textarea" style={{ minHeight: 60, fontSize: 12 }} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          {error && (
            <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', color: 'var(--red)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
              {error}
            </div>
          )}
          <button className="btn btn-primary" disabled={saving} onClick={submit} style={{ justifyContent: 'center' }}>
            {saving ? 'Saving...' : 'Save Trade'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TradesPage() {
  return <Suspense fallback={<div className="loading-wrap"><div className="spinner" /></div>}><TradesPageContent /></Suspense>;
}
