'use client';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  X, Play, Pause, SkipBack, SkipForward,
  Square, Minus, Type as TypeIcon, Loader2, AlertTriangle, ExternalLink,
  BookOpenText, Brain, Award, Tags, BarChart3, CheckCircle2, Undo2, Trash2, MapPin,
  MousePointer2, ArrowUpRight, ImagePlus, MoveHorizontal, Flag, LogIn, LogOut, Keyboard, PauseCircle,
} from 'lucide-react';
import { createChart, createSeriesMarkers, CandlestickSeries, LineStyle, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';

const API = '/api';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; }
interface ReplayPlaybookRule { ruleId: string; label: string; inputType: string; options?: string[]; required?: boolean; helpText?: string; toolRole?: string; timeframes?: string[]; failureAction?: string; failureMessage?: string; }
interface ReplayPlaybookBlock { blockId: string; name: string; category: string; rules: ReplayPlaybookRule[]; }
interface ReplayPlaybookSnapshot { name: string; versionNumber: number; versionId: string; blocks: ReplayPlaybookBlock[]; }
interface ReplayData {
  candles: Candle[]; entryPrice: number; exitPrice: number;
  direction: 'BUY' | 'SELL'; symbol: string; normalizedSymbol: string; interval: string;
  openTime: string; closeTime: string; entryTimestamp: number; exitTimestamp: number;
  entryIndex: number; exitIndex: number; pnlUSD: number; pnlPct: number;
  durationMinutes: number; lotSize: number;
  existingNotes: string; existingEmotion: string; existingGrade: string; existingTags: string[];
  source?: 'mt5' | 'twelve'; sourceLabel?: string;
  analysisGrade?: string; executionGrade?: string; plannedRR?: number | null; exitReason?: string;
  manuallyIntervened?: boolean | null; confidenceRating?: number | null; accountType?: string;
  playbookSnapshot?: ReplayPlaybookSnapshot | null; playbookResponses?: Record<string, unknown>;
}
interface ReplayDebug {
  state: 'pending' | 'processing' | 'failed'; queuedAt: string; waitSeconds: number;
  claimCount: number; lastError: string; agentSeenOnThisInstance: boolean;
  lastAgentSeenAt: string | null; backendInstance: string;
  transport?: 'mongodb-long-poll' | string;
}
interface ReplayPending { pending?: boolean; message?: string; setup?: boolean; error?: string; debug?: ReplayDebug; }
interface DrawnRect { id: string; time1: number; time2: number; price1: number; price2: number; color: string; }
interface DrawnLine { id: string; time1: number; time2: number; price1: number; price2: number; color: string; }
interface DrawnText { id: string; time: number; price: number; text: string; color: string; }
interface DrawnHorizontal { id: string; time: number; price: number; color: string; }
interface DrawnArrow { id: string; time1: number; time2: number; price1: number; price2: number; color: string; }
interface DrawnImage { id: string; time: number; price: number; url: string; caption: string; screenshotId: string; color: string; }
type ReplayAnnotation =
  | (DrawnRect & { type: 'rect' }) | (DrawnLine & { type: 'line' })
  | (DrawnHorizontal & { type: 'horizontal' }) | (DrawnArrow & { type: 'arrow' })
  | (DrawnText & { type: 'text' }) | (DrawnImage & { type: 'image' });
type DrawingTool = 'none' | 'select' | 'rect' | 'line' | 'horizontal' | 'arrow' | 'text' | 'image' | 'event';
interface AnnotationHistory { rects: DrawnRect[]; lines: DrawnLine[]; horizontals: DrawnHorizontal[]; arrows: DrawnArrow[]; texts: DrawnText[]; images: DrawnImage[]; }
interface ReplayTimelineEvent {
  eventId: string; timeframe: string; candleTime: number; price: number;
  visibilityScope?: 'timeframe' | 'all';
  eventType: string; customType: string; title: string; note: string; emotion: string;
  severity: 'minor' | 'important' | 'critical'; playbookRuleId: string; playbookVersionId: string;
  screenshotIds: string[]; createdAt: string; updatedAt?: string;
}
interface ReplayEventDraft { eventType: string; customType: string; title: string; note: string; emotion: string; severity: 'minor' | 'important' | 'critical'; playbookRuleId: string; visibilityScope: 'timeframe' | 'all'; }
interface ReplayQuickReview { followedPlan: boolean | null; primaryEmotion: string; primaryMistake: string; primaryStrength: string; lesson: string; processGrade: string; completedAt: string | null; updatedAt?: string; }
interface ReplayDraft { notes: string; emotion: string; grade: string; tags: string[]; playbookResponses: Record<string, unknown>; analysisGrade: string; executionGrade: string; plannedRR: string; confidenceRating: number | null; exitReason: string; manuallyIntervened: boolean | null; selectedInterval: string; replayIdx: number; speed: number; journalPhase: 'plan' | 'manage' | 'review'; updatedAt?: string; }
export interface TradeReplaySummary {
  symbol: string; direction: string; pnlUSD: number; pnlPct: number;
  entryPrice: number; exitPrice: number; openTime: string; closeTime: string;
  durationMinutes: number; lotSize: number;
}
interface Props {
  tradeId: string; tradeSummary: TradeReplaySummary;
  initialInterval?: string;
  initialJournalPhase?: 'plan' | 'manage' | 'review';
  onIntervalChange?: (interval: string) => void;
  onJournalPhaseChange?: (phase: 'plan' | 'manage' | 'review') => void;
  onClose: () => void;
  onSaved: (updates: { notes: string; emotion: string; grade: string; tags: string[] }) => void;
}

const EMOTIONS = [
  { name: 'Calm', emoji: '😊' }, { name: 'Disciplined', emoji: '🧠' },
  { name: 'Anxious', emoji: '😰' }, { name: 'Greedy', emoji: '🤑' },
  { name: 'Fearful', emoji: '😨' }, { name: 'FOMO', emoji: '💥' },
];
const GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
const RECT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
const REPLAY_TIMEFRAMES = [
  { value: '1min', label: '1m' }, { value: '5min', label: '5m' }, { value: '15min', label: '15m' },
  { value: '1h', label: '1H' }, { value: '4h', label: '4H' }, { value: '1day', label: '1D' },
] as const;
const defaultReplayTimeframe = (minutes: number) => minutes < 30 ? '1min' : minutes < 240 ? '5min' : minutes < 1440 ? '15min' : minutes < 10080 ? '1h' : '4h';
const JOURNAL_PHASES = [
  { id: 'plan', label: 'Plan', categories: ['concept', 'context', 'setup', 'entry', 'risk', 'pre_trade'] },
  { id: 'manage', label: 'Execution', categories: ['execution', 'management', 'trade_management'] },
  { id: 'review', label: 'Review', categories: ['exit', 'review', 'post_trade', 'custom'] },
] as const;
const RULE_TOOL_LABELS: Record<string, string> = {
  observation: 'Observation', confirmation: 'Confirmation', trigger: 'Entry trigger', decision_gate: 'Decision gate', invalidation: 'Invalidation', risk_limit: 'Risk limit', management_action: 'Management action', exit_signal: 'Exit signal', review_prompt: 'Review prompt',
};
const FAILURE_ACTION_LABELS: Record<string, string> = {
  warn: 'Warning', skip_trade: 'Skip this setup', stop_session: 'Stop the trading session',
};
const REPLAY_EVENT_TYPES = [
  ['observation', 'Observation'], ['confirmation', 'Confirmation'], ['entry', 'Entry decision'],
  ['management', 'Management'], ['exit', 'Exit decision'], ['emotion', 'Emotion'],
  ['mistake', 'Mistake'], ['violation', 'Rule violation'], ['lesson', 'Lesson'], ['custom', 'Custom'],
] as const;
const EMPTY_EVENT_DRAFT: ReplayEventDraft = { eventType: 'observation', customType: '', title: '', note: '', emotion: '', severity: 'important', playbookRuleId: '', visibilityScope: 'timeframe' };
const EMPTY_QUICK_REVIEW: ReplayQuickReview = { followedPlan: null, primaryEmotion: '', primaryMistake: '', primaryStrength: '', lesson: '', processGrade: '', completedAt: null };
const fmt = (n: number, dp = 2) => n.toFixed(dp);
const fmtDur = (mins: number) => {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

function ReplayDiagnostics({ debug }: { debug: ReplayDebug }) {
  const sharedTransport = debug.transport === 'mongodb-long-poll';
  const agentLabel = debug.agentSeenOnThisInstance ? (sharedTransport ? 'Connected to live backend' : 'Connected to this API instance') : 'Not detected by live backend';
  return (
    <div className="replay-debug" role="status" aria-label="MT5 replay diagnostics">
      <div className="replay-debug-title">Connection diagnostics</div>
      <div><span>Request</span><strong>{debug.state} · {debug.waitSeconds}s</strong></div>
      <div><span>MT5 agent</span><strong className={debug.agentSeenOnThisInstance ? 'ok' : 'warn'}>{agentLabel}</strong></div>
      <div><span>Claims</span><strong>{debug.claimCount}</strong></div>
      {sharedTransport && <div><span>Transport</span><strong className="ok">MongoDB long poll</strong></div>}
      <div><span>API instance</span><code>{debug.backendInstance}</code></div>
      {debug.lastAgentSeenAt && <div><span>Last agent poll</span><strong>{new Date(debug.lastAgentSeenAt).toLocaleTimeString()}</strong></div>}
      {debug.lastError && <div className="replay-debug-error"><span>MT5 error</span><strong>{debug.lastError}</strong></div>}
      {!debug.agentSeenOnThisInstance && (
        <p>Check that sync.py is running and API_BASE points to this live backend.</p>
      )}
    </div>
  );
}

export default function TradeReplayModal({ tradeId, tradeSummary, initialInterval, initialJournalPhase, onIntervalChange, onJournalPhaseChange, onClose, onSaved }: Props) {
  const [replayData, setReplayData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSetupError, setIsSetupError] = useState(false);
  const [waitingForMt5, setWaitingForMt5] = useState(false);
  const [replayDebug, setReplayDebug] = useState<ReplayDebug | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const annotationInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [autoPauseMarkers, setAutoPauseMarkers] = useState(true);
  const [pausedMarker, setPausedMarker] = useState('');
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>('none');
  const [rectColor, setRectColor] = useState(RECT_COLORS[0]);
  const [drawnRects, setDrawnRects] = useState<DrawnRect[]>([]);
  const [drawnLines, setDrawnLines] = useState<DrawnLine[]>([]);
  const [drawnHorizontals, setDrawnHorizontals] = useState<DrawnHorizontal[]>([]);
  const [drawnArrows, setDrawnArrows] = useState<DrawnArrow[]>([]);
  const [drawnTexts, setDrawnTexts] = useState<DrawnText[]>([]);
  const [drawnImages, setDrawnImages] = useState<DrawnImage[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState('');
  const [pendingImage, setPendingImage] = useState<Omit<DrawnImage, 'id' | 'time' | 'price' | 'color'> | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [annotationSaveState, setAnnotationSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [annotationSaveError, setAnnotationSaveError] = useState('');
  const [loadedAnnotationKey, setLoadedAnnotationKey] = useState('');
  const [showAnnotationList, setShowAnnotationList] = useState(false);
  const annotationBaselineRef = useRef('');
  const activeAnnotationKeyRef = useRef('');
  const annotationHistoryRef = useRef<AnnotationHistory[]>([]);
  const [annotationHistoryDepth, setAnnotationHistoryDepth] = useState(0);
  const annotationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [timelineEvents, setTimelineEvents] = useState<ReplayTimelineEvent[]>([]);
  const [eventSaveState, setEventSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [eventSaveError, setEventSaveError] = useState('');
  const [eventDraft, setEventDraft] = useState<ReplayEventDraft>(EMPTY_EVENT_DRAFT);
  const [eventLocation, setEventLocation] = useState<{ time: number; price: number } | null>(null);
  const [editingEventId, setEditingEventId] = useState('');
  const eventBaselineRef = useRef('');
  const eventsLoadedTradeRef = useRef('');
  const eventSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTimelineNavigationRef = useRef('');
  const [reviewMode, setReviewMode] = useState<'quick' | 'playbook'>('quick');
  const [quickReview, setQuickReview] = useState<ReplayQuickReview>(EMPTY_QUICK_REVIEW);
  const [quickReviewSaveState, setQuickReviewSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [quickReviewError, setQuickReviewError] = useState('');
  const quickReviewBaselineRef = useRef('');
  const quickReviewLoadedRef = useRef('');
  const quickReviewSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [draftSaveState, setDraftSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [draftSaveError, setDraftSaveError] = useState('');
  const pendingDraftRef = useRef<ReplayDraft | null>(null);
  const draftBaselineRef = useRef('');
  const draftAppliedTradeRef = useRef('');
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const replayJournalInitializedRef = useRef(false);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const currentPreview = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const redrawCanvasRef = useRef<() => void>(() => undefined);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [notes, setNotes] = useState('');
  const [emotion, setEmotion] = useState('');
  const [grade, setGrade] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [journalPhase, setJournalPhase] = useState<'plan' | 'manage' | 'review'>(() =>
    initialJournalPhase && ['plan', 'manage', 'review'].includes(initialJournalPhase) ? initialJournalPhase : 'plan'
  );
  const [playbookResponses, setPlaybookResponses] = useState<Record<string, unknown>>({});
  const [analysisGrade, setAnalysisGrade] = useState('');
  const [executionGrade, setExecutionGrade] = useState('');
  const [plannedRR, setPlannedRR] = useState('');
  const [confidenceRating, setConfidenceRating] = useState<number | null>(null);
  const [exitReason, setExitReason] = useState('');
  const [manuallyIntervened, setManuallyIntervened] = useState<boolean | null>(null);
  const [selectedInterval, setSelectedInterval] = useState(() =>
    initialInterval && REPLAY_TIMEFRAMES.some(timeframe => timeframe.value === initialInterval)
      ? initialInterval
      : defaultReplayTimeframe(tradeSummary.durationMinutes)
  );

  useEffect(() => {
    if (drawingTool === 'text') annotationInputRef.current?.focus();
  }, [drawingTool]);

  const allAnnotations = useMemo<ReplayAnnotation[]>(() => [
    ...drawnRects.map(annotation => ({ ...annotation, type: 'rect' as const })),
    ...drawnLines.map(annotation => ({ ...annotation, type: 'line' as const })),
    ...drawnHorizontals.map(annotation => ({ ...annotation, type: 'horizontal' as const })),
    ...drawnArrows.map(annotation => ({ ...annotation, type: 'arrow' as const })),
    ...drawnTexts.map(annotation => ({ ...annotation, type: 'text' as const })),
    ...drawnImages.map(annotation => ({ ...annotation, type: 'image' as const })),
  ], [drawnArrows, drawnHorizontals, drawnImages, drawnLines, drawnRects, drawnTexts]);
  const annotationKey = `${tradeId}:${selectedInterval}`;
  useEffect(() => { activeAnnotationKeyRef.current = annotationKey; }, [annotationKey]);
  const pushAnnotationHistory = () => {
    annotationHistoryRef.current = [...annotationHistoryRef.current.slice(-19), {
      rects: drawnRects.map(item => ({ ...item })), lines: drawnLines.map(item => ({ ...item })),
      horizontals: drawnHorizontals.map(item => ({ ...item })), arrows: drawnArrows.map(item => ({ ...item })),
      texts: drawnTexts.map(item => ({ ...item })), images: drawnImages.map(item => ({ ...item })),
    }];
    setAnnotationHistoryDepth(annotationHistoryRef.current.length);
  };

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const controller = new AbortController();
    setAnnotationSaveState('loading'); setAnnotationSaveError(''); setLoadedAnnotationKey(''); setShowAnnotationList(false);
    fetch(`${API}/trades/${tradeId}/replay-journal?interval=${selectedInterval}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load chart annotations');
        const annotations = Array.isArray(body.annotations) ? body.annotations as ReplayAnnotation[] : [];
        setDrawnRects(annotations.filter(item => item.type === 'rect').map(item => ({ ...item }) as DrawnRect));
        setDrawnLines(annotations.filter(item => item.type === 'line').map(item => ({ ...item }) as DrawnLine));
        setDrawnHorizontals(annotations.filter(item => item.type === 'horizontal').map(item => ({ ...item }) as DrawnHorizontal));
        setDrawnArrows(annotations.filter(item => item.type === 'arrow').map(item => ({ ...item }) as DrawnArrow));
        setDrawnTexts(annotations.filter(item => item.type === 'text').map(item => ({ ...item }) as DrawnText));
        setDrawnImages(annotations.filter(item => item.type === 'image').map(item => ({ ...item }) as DrawnImage));
        setSelectedAnnotationId(''); setPendingImage(null);
        annotationHistoryRef.current = [];
        setAnnotationHistoryDepth(0);
        annotationBaselineRef.current = JSON.stringify(annotations);
        if (eventsLoadedTradeRef.current !== tradeId) {
          const events = Array.isArray(body.events) ? body.events as ReplayTimelineEvent[] : [];
          setTimelineEvents(events);
          eventBaselineRef.current = JSON.stringify(events);
          eventsLoadedTradeRef.current = tradeId;
        }
        if (quickReviewLoadedRef.current !== tradeId) {
          const review = { ...EMPTY_QUICK_REVIEW, ...(body.quickReview || {}) } as ReplayQuickReview;
          setQuickReview(review); quickReviewBaselineRef.current = JSON.stringify(review); quickReviewLoadedRef.current = tradeId;
        }
        pendingDraftRef.current = body.draft && body.draft.updatedAt ? body.draft as ReplayDraft : null;
        setDraftSaveState('loading');
        setLoadedAnnotationKey(annotationKey); setAnnotationSaveState('saved');
      })
      .catch(error => {
        if (error.name === 'AbortError') return;
        setAnnotationSaveState('error'); setAnnotationSaveError(error.message || 'Could not load chart annotations');
      });
    return () => controller.abort();
  }, [annotationKey, selectedInterval, tradeId]);

  useEffect(() => {
    if (loadedAnnotationKey !== annotationKey) return;
    const serialized = JSON.stringify(allAnnotations);
    if (serialized === annotationBaselineRef.current) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setAnnotationSaveState('saving'); setAnnotationSaveError('');
    const timer = setTimeout(() => {
      const annotations = JSON.parse(serialized) as ReplayAnnotation[];
      annotationSaveQueueRef.current = annotationSaveQueueRef.current.then(async () => {
        const response = await fetch(`${API}/trades/${tradeId}/replay-journal/annotations`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ interval: selectedInterval, annotations }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not save chart annotations');
        if (activeAnnotationKeyRef.current === annotationKey) {
          annotationBaselineRef.current = serialized;
          setAnnotationSaveState('saved');
        }
      }).catch(error => {
        if (activeAnnotationKeyRef.current === annotationKey) {
          setAnnotationSaveState('error'); setAnnotationSaveError(error.message || 'Could not save chart annotations');
        }
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [allAnnotations, annotationKey, loadedAnnotationKey, selectedInterval, tradeId]);

  useEffect(() => {
    if (eventsLoadedTradeRef.current !== tradeId) return;
    const serialized = JSON.stringify(timelineEvents);
    if (serialized === eventBaselineRef.current) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setEventSaveState('saving'); setEventSaveError('');
    const timer = setTimeout(() => {
      const events = JSON.parse(serialized) as ReplayTimelineEvent[];
      eventSaveQueueRef.current = eventSaveQueueRef.current.then(async () => {
        const response = await fetch(`${API}/trades/${tradeId}/replay-journal/events`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ events }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not save timeline events');
        eventBaselineRef.current = serialized; setEventSaveState('saved');
      }).catch(error => { setEventSaveState('error'); setEventSaveError(error.message || 'Could not save timeline events'); });
    }, 700);
    return () => clearTimeout(timer);
  }, [timelineEvents, tradeId]);

  useEffect(() => {
    if (quickReviewLoadedRef.current !== tradeId) return;
    const serialized = JSON.stringify(quickReview);
    if (serialized === quickReviewBaselineRef.current) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setQuickReviewSaveState('saving'); setQuickReviewError('');
    const timer = setTimeout(() => {
      const review = JSON.parse(serialized) as ReplayQuickReview;
      quickReviewSaveQueueRef.current = quickReviewSaveQueueRef.current.then(async () => {
        const response = await fetch(`${API}/trades/${tradeId}/replay-journal/quick-review`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ quickReview: review }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not save Quick Review');
        quickReviewBaselineRef.current = serialized; setQuickReviewSaveState('saved');
      }).catch(error => { setQuickReviewSaveState('error'); setQuickReviewError(error.message || 'Could not save Quick Review'); });
    }, 700);
    return () => clearTimeout(timer);
  }, [quickReview, tradeId]);

  useEffect(() => {
    if (!replayData || draftAppliedTradeRef.current === tradeId || loadedAnnotationKey !== annotationKey) return;
    const draft = pendingDraftRef.current;
    if (draft) {
      setNotes(draft.notes || ''); setEmotion(draft.emotion || ''); setGrade(draft.grade || ''); setTags(draft.tags || []);
      setPlaybookResponses(draft.playbookResponses || {}); setAnalysisGrade(draft.analysisGrade || ''); setExecutionGrade(draft.executionGrade || '');
      setPlannedRR(draft.plannedRR || ''); setConfidenceRating(draft.confidenceRating ?? null); setExitReason(draft.exitReason || '');
      setManuallyIntervened(draft.manuallyIntervened ?? null); setSpeed(draft.speed || 1); setJournalPhase(draft.journalPhase || 'plan');
      if (draft.selectedInterval === selectedInterval) setReplayIdx(Math.min(replayData.candles.length - 1, Math.max(0, draft.replayIdx || 0)));
      draftBaselineRef.current = JSON.stringify({ ...draft, updatedAt: undefined });
    }
    draftAppliedTradeRef.current = tradeId; setDraftSaveState('saved');
  }, [annotationKey, loadedAnnotationKey, replayData, selectedInterval, tradeId]);

  const replayDraft = useMemo<ReplayDraft>(() => ({
    notes, emotion, grade, tags, playbookResponses, analysisGrade, executionGrade, plannedRR, confidenceRating, exitReason,
    manuallyIntervened, selectedInterval, replayIdx, speed, journalPhase,
  }), [analysisGrade, confidenceRating, emotion, executionGrade, exitReason, grade, journalPhase, manuallyIntervened, notes, plannedRR, playbookResponses, replayIdx, selectedInterval, speed, tags]);

  useEffect(() => {
    if (draftAppliedTradeRef.current !== tradeId) return;
    const serialized = JSON.stringify(replayDraft);
    if (serialized === draftBaselineRef.current) return;
    const token = localStorage.getItem('token'); if (!token) return;
    setDraftSaveState('saving'); setDraftSaveError('');
    const timer = setTimeout(() => {
      const draft = JSON.parse(serialized) as ReplayDraft;
      draftSaveQueueRef.current = draftSaveQueueRef.current.then(async () => {
        const response = await fetch(`${API}/trades/${tradeId}/replay-journal/draft`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ draft }),
        });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not save Replay draft');
        draftBaselineRef.current = serialized; setDraftSaveState('saved');
      }).catch(error => { setDraftSaveState('error'); setDraftSaveError(error.message || 'Could not save Replay draft'); });
    }, 900);
    return () => clearTimeout(timer);
  }, [replayDraft, tradeId]);

  const applyReplay = useCallback((data: ReplayData) => {
    if (!Array.isArray(data?.candles) || data.candles.length === 0) {
      throw new Error('The replay service returned no candle data. Restart the backend and MT5 sync agent, then try again.');
    }
    const replay = { ...data };
    replay.candles = data.candles.map(candle => ({ ...candle, time: Number(candle.time) as UTCTimestamp }));
    setReplayData(replay);
    if (!replayJournalInitializedRef.current) {
      setNotes(data.existingNotes || ''); setEmotion(data.existingEmotion || '');
      setGrade(data.existingGrade || ''); setTags(data.existingTags || []);
      setPlaybookResponses(data.playbookResponses || {});
      setAnalysisGrade(data.analysisGrade || ''); setExecutionGrade(data.executionGrade || '');
      setPlannedRR(data.plannedRR == null ? '' : String(data.plannedRR));
      setConfidenceRating(data.confidenceRating ?? null); setExitReason(data.exitReason || '');
      setManuallyIntervened(data.manuallyIntervened ?? null);
      replayJournalInitializedRef.current = true;
    }
    setReplayIdx(Math.max(0, data.entryIndex - 8));
    setWaitingForMt5(false); setError(''); setLoading(false);
    setReplayDebug(null);
  }, []);

  const loadTwelveFallback = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setLoading(true); setWaitingForMt5(false); setError(''); setIsSetupError(false);
    try {
      const response = await fetch(`${API}/trades/${tradeId}/replay?fallback=twelve&interval=${selectedInterval}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json() as ReplayData & ReplayPending;
      if (!response.ok) { setError(data.error || 'Failed to load fallback chart data'); setIsSetupError(Boolean(data.setup)); setLoading(false); return; }
      applyReplay(data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Network error'); setLoading(false); }
  }, [applyReplay, selectedInterval, tradeId]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const controller = new AbortController();
    const poll = async () => {
      for (let attempt = 0; attempt < 8 && !controller.signal.aborted; attempt += 1) {
        try {
          const response = await fetch(`${API}/trades/${tradeId}/replay?interval=${selectedInterval}&wait=8`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
          const data = await response.json() as ReplayData & ReplayPending;
          if (response.status === 202 || data.pending === true) {
            setReplayDebug(data.debug || null);
            if (data.debug?.state === 'failed') {
              setWaitingForMt5(true); setLoading(false);
              setError(data.debug.lastError || 'MT5 could not return candles for this trade.');
              return;
            }
            setWaitingForMt5(true); setLoading(true);
            await new Promise(resolve => setTimeout(resolve, 200));
            continue;
          }
          if (!response.ok) { setError(data.error || 'Failed to load replay data'); setIsSetupError(Boolean(data.setup)); setLoading(false); return; }
          applyReplay(data);
          return;
        } catch (e) {
          if ((e as Error).name !== 'AbortError') { setError((e as Error).message || 'Network error'); setLoading(false); }
          return;
        }
      }
      if (!controller.signal.aborted) { setLoading(false); setWaitingForMt5(true); setError('MT5 has not supplied these candles yet. Keep the sync agent running or use the Twelve Data fallback.'); }
    };
    poll();
    return () => controller.abort();
  }, [applyReplay, selectedInterval, tradeId]);

  useEffect(() => {
    if (!replayData || !chartContainerRef.current) return;
    const el = chartContainerRef.current;
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#0d1117' }, textColor: '#8b95b0' },
      grid: { vertLines: { color: '#1a2035' }, horzLines: { color: '#1a2035' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: '#1a2035', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1a2035' },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', downColor: '#ef4444', borderVisible: false,
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
    });
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    series.createPriceLine({
      price: replayData.entryPrice,
      color: replayData.direction === 'BUY' ? '#10b981' : '#ef4444',
      lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
      title: `Entry ${replayData.direction}`,
    });
    series.createPriceLine({
      price: replayData.exitPrice,
      color: replayData.pnlUSD >= 0 ? '#10b981' : '#ef4444',
      lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Exit',
    });
    const syncCanvas = () => {
      if (!canvasRef.current) return;
      canvasRef.current.width = el.clientWidth; canvasRef.current.height = el.clientHeight;
    };
    syncCanvas();
    const redrawAnnotations = () => requestAnimationFrame(() => redrawCanvasRef.current());
    const ro = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); syncCanvas(); redrawAnnotations(); });
    ro.observe(el);
    chart.timeScale().subscribeVisibleTimeRangeChange(redrawAnnotations);
    return () => { ro.disconnect(); chart.timeScale().unsubscribeVisibleTimeRangeChange(redrawAnnotations); markersRef.current?.detach(); chart.remove(); chartRef.current = null; seriesRef.current = null; markersRef.current = null; };
  }, [replayData]);

  useEffect(() => {
    if (!replayData || !seriesRef.current || !markersRef.current) return;
    seriesRef.current.setData(replayData.candles.slice(0, replayIdx + 1));
    const markers: SeriesMarker<Time>[] = [];
    if (replayIdx >= replayData.entryIndex) {
      markers.push({ time: replayData.candles[replayData.entryIndex].time as UTCTimestamp,
        position: replayData.direction === 'BUY' ? 'belowBar' : 'aboveBar', color: '#10b981',
        shape: replayData.direction === 'BUY' ? 'arrowUp' : 'arrowDown', text: replayData.direction, size: 2 });
    }
    if (replayIdx >= replayData.exitIndex) {
      markers.push({ time: replayData.candles[replayData.exitIndex].time as UTCTimestamp,
        position: replayData.direction === 'BUY' ? 'aboveBar' : 'belowBar',
        color: replayData.pnlUSD >= 0 ? '#10b981' : '#ef4444', shape: 'square',
        text: `${replayData.pnlUSD >= 0 ? '+' : ''}$${fmt(replayData.pnlUSD)}`, size: 1 });
    }
    timelineEvents.filter(event => event.timeframe === selectedInterval || event.visibilityScope === 'all').forEach(event => {
      const candleIndex = replayData.candles.findIndex(candle => Number(candle.time) >= Number(event.candleTime));
      if (candleIndex < 0 || candleIndex > replayIdx) return;
      const label = REPLAY_EVENT_TYPES.find(([value]) => value === event.eventType)?.[1] || event.customType || 'Event';
      markers.push({
        time: replayData.candles[candleIndex].time as UTCTimestamp,
        position: event.price >= replayData.candles[candleIndex].high ? 'aboveBar' : 'belowBar',
        color: event.severity === 'critical' ? '#ef4444' : event.severity === 'important' ? '#f59e0b' : '#60a5fa',
        shape: 'circle', text: label, size: 1,
      });
    });
    markersRef.current.setMarkers(markers);
  }, [replayIdx, replayData, selectedInterval, timelineEvents]);

  useEffect(() => {
    if (!replayData || !pendingTimelineNavigationRef.current) return;
    const event = timelineEvents.find(item => item.eventId === pendingTimelineNavigationRef.current && (item.timeframe === selectedInterval || item.visibilityScope === 'all'));
    if (!event) return;
    const index = replayData.candles.findIndex(candle => Number(candle.time) >= event.candleTime);
    if (index < 0) return;
    pendingTimelineNavigationRef.current = '';
    queueMicrotask(() => {
      setPlaying(false); setReplayIdx(index);
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, index - 30), to: Math.min(replayData.candles.length - 1, index + 10) });
    });
  }, [replayData, selectedInterval, timelineEvents]);

  useEffect(() => {
    if (!replayData) return;
    if (playing) {
      const ms = Math.max(50, 300 / speed);
      intervalRef.current = setInterval(() => {
        setReplayIdx(prev => {
          if (prev >= replayData.candles.length - 1) { setPlaying(false); return prev; }
          const next = prev + 1;
          if (autoPauseMarkers && (next === replayData.entryIndex || next === replayData.exitIndex)) {
            const label = next === replayData.entryIndex && next === replayData.exitIndex ? 'Entry and exit' : next === replayData.entryIndex ? 'Entry' : 'Exit';
            setPlaying(false); setPausedMarker(label);
          }
          return next;
        });
      }, ms);
    } else { if (intervalRef.current) clearInterval(intervalRef.current); }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoPauseMarkers, playing, speed, replayData]);

  useEffect(() => {
    if (!pausedMarker) return;
    const timer = window.setTimeout(() => setPausedMarker(''), 3000);
    return () => window.clearTimeout(timer);
  }, [pausedMarker]);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const revealedTime = Number(replayData?.candles[Math.min(replayIdx, (replayData?.candles.length || 1) - 1)]?.time || Number.POSITIVE_INFINITY);
    const selected = (id: string) => id === selectedAnnotationId;
    const drawSelection = (x: number, y: number, width: number, height: number) => {
      ctx.save(); ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 4, y - 4, width + 8, height + 8); ctx.restore();
    };
    const drawArrowHead = (x1: number, y1: number, x2: number, y2: number, color: string) => {
      const angle = Math.atan2(y2 - y1, x2 - x1); const size = 10;
      ctx.save(); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
      ctx.closePath(); ctx.fill(); ctx.restore();
    };
    for (const r of drawnRects) {
      if (Math.max(r.time1, r.time2) > revealedTime) continue;
      const x1 = chart.timeScale().timeToCoordinate(r.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(r.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(r.price1); const y2 = series.priceToCoordinate(r.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = r.color; ctx.fillStyle = r.color + '22'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
      ctx.fill(); ctx.stroke(); ctx.restore();
      if (selected(r.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    }
    for (const line of drawnLines) {
      if (Math.max(line.time1, line.time2) > revealedTime) continue;
      const x1 = chart.timeScale().timeToCoordinate(line.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(line.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(line.price1); const y2 = series.priceToCoordinate(line.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      if (selected(line.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
    }
    for (const level of drawnHorizontals) {
      if (level.time > revealedTime) continue;
      const x = chart.timeScale().timeToCoordinate(level.time as UTCTimestamp); const y = series.priceToCoordinate(level.price);
      if (x == null || y == null) continue;
      ctx.save(); ctx.strokeStyle = level.color; ctx.lineWidth = 1.5; ctx.setLineDash([7, 4]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      ctx.fillStyle = level.color; ctx.font = '700 10px sans-serif'; ctx.fillText(level.price.toFixed(2), x + 6, y - 6); ctx.restore();
      if (selected(level.id)) drawSelection(x, y - 2, Math.max(2, canvas.width - x), 4);
    }
    for (const arrow of drawnArrows) {
      if (Math.max(arrow.time1, arrow.time2) > revealedTime) continue;
      const x1 = chart.timeScale().timeToCoordinate(arrow.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(arrow.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(arrow.price1); const y2 = series.priceToCoordinate(arrow.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = arrow.color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
      drawArrowHead(x1, y1, x2, y2, arrow.color);
      if (selected(arrow.id)) drawSelection(Math.min(x1, x2), Math.min(y1, y2), Math.max(2, Math.abs(x2 - x1)), Math.max(2, Math.abs(y2 - y1)));
    }
    for (const note of drawnTexts) {
      if (note.time > revealedTime) continue;
      const x = chart.timeScale().timeToCoordinate(note.time as UTCTimestamp);
      const y = series.priceToCoordinate(note.price);
      if (x == null || y == null) continue;
      ctx.save(); ctx.font = '600 12px sans-serif';
      const width = ctx.measureText(note.text).width;
      ctx.fillStyle = '#0a0d14dd'; ctx.fillRect(x - 5, y - 17, width + 10, 23);
      ctx.strokeStyle = note.color; ctx.strokeRect(x - 5, y - 17, width + 10, 23);
      ctx.fillStyle = note.color; ctx.fillText(note.text, x, y); ctx.restore();
      if (selected(note.id)) drawSelection(x - 5, y - 17, width + 10, 23);
    }
    for (const pin of drawnImages) {
      if (pin.time > revealedTime) continue;
      const x = chart.timeScale().timeToCoordinate(pin.time as UTCTimestamp); const y = series.priceToCoordinate(pin.price);
      if (x == null || y == null) continue;
      const cardX = Math.min(canvas.width - 110, Math.max(8, x + 10)); const cardY = Math.max(8, y - 78);
      let image = imageCacheRef.current.get(pin.url);
      if (!image) {
        image = new window.Image(); image.crossOrigin = 'anonymous'; image.onload = () => redrawCanvasRef.current(); image.src = pin.url;
        imageCacheRef.current.set(pin.url, image);
      }
      ctx.save(); ctx.fillStyle = '#0a0e14ee'; ctx.strokeStyle = pin.color; ctx.lineWidth = selected(pin.id) ? 2.5 : 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cardX, cardY + 58); ctx.stroke();
      ctx.fillRect(cardX, cardY, 100, 66);
      if (image.complete && image.naturalWidth > 0) ctx.drawImage(image, cardX + 3, cardY + 3, 94, 48);
      else { ctx.fillStyle = '#182033'; ctx.fillRect(cardX + 3, cardY + 3, 94, 48); }
      ctx.strokeRect(cardX, cardY, 100, 66); ctx.fillStyle = '#cbd5e1'; ctx.font = '600 9px sans-serif';
      ctx.fillText((pin.caption || 'Chart evidence').slice(0, 18), cardX + 5, cardY + 61); ctx.restore();
      if (selected(pin.id)) drawSelection(cardX, cardY, 100, 66);
    }
    if (currentPreview.current) {
      const { x1, y1, x2, y2 } = currentPreview.current;
      ctx.save(); ctx.strokeStyle = rectColor; ctx.fillStyle = rectColor + '18'; ctx.lineWidth = 1.5; ctx.setLineDash([4,4]);
      ctx.beginPath();
      if (drawingTool === 'line' || drawingTool === 'arrow') { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); if (drawingTool === 'arrow') drawArrowHead(x1, y1, x2, y2, rectColor); }
      else { ctx.rect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1)); ctx.fill(); ctx.stroke(); }
      ctx.restore();
    }
  }, [drawingTool, drawnArrows, drawnHorizontals, drawnImages, drawnLines, drawnRects, drawnTexts, rectColor, replayData, replayIdx, selectedAnnotationId]);

  useEffect(() => { redrawCanvasRef.current = redrawCanvas; redrawCanvas(); }, [redrawCanvas, replayIdx]);

  const findAnnotationAt = (x: number, y: number) => {
    const chart = chartRef.current, series = seriesRef.current, canvas = canvasRef.current;
    if (!chart || !series || !canvas) return null;
    const distanceToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
      const dx = x2 - x1, dy = y2 - y1; if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    };
    for (const annotation of [...allAnnotations].reverse()) {
      if (annotation.type === 'text' || annotation.type === 'image' || annotation.type === 'horizontal') {
        const ax = chart.timeScale().timeToCoordinate(annotation.time as UTCTimestamp); const ay = series.priceToCoordinate(annotation.price);
        if (ax == null || ay == null) continue;
        if (annotation.type === 'horizontal' && x >= ax - 8 && Math.abs(y - ay) <= 8) return annotation;
        if (annotation.type === 'image') {
          const cardX = Math.min(canvas.width - 110, Math.max(8, ax + 10)); const cardY = Math.max(8, ay - 78);
          if ((x >= cardX - 5 && x <= cardX + 105 && y >= cardY - 5 && y <= cardY + 71) || Math.hypot(x - ax, y - ay) <= 12) return annotation;
        }
        if (annotation.type === 'text') {
          const ctx = canvas.getContext('2d'); if (!ctx) continue; ctx.font = '600 12px sans-serif'; const width = ctx.measureText(annotation.text).width;
          if (x >= ax - 9 && x <= ax + width + 9 && y >= ay - 21 && y <= ay + 7) return annotation;
        }
        continue;
      }
      const x1 = chart.timeScale().timeToCoordinate(annotation.time1 as UTCTimestamp); const x2 = chart.timeScale().timeToCoordinate(annotation.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(annotation.price1); const y2 = series.priceToCoordinate(annotation.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      if (annotation.type === 'rect') {
        const left = Math.min(x1, x2), right = Math.max(x1, x2), top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        if (x >= left - 7 && x <= right + 7 && y >= top - 7 && y <= bottom + 7) return annotation;
      } else if (distanceToSegment(x, y, x1, y1, x2, y2) <= 9) return annotation;
    }
    return null;
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawingTool === 'none') return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (drawingTool === 'select') { setSelectedAnnotationId(findAnnotationAt(x, y)?.id || ''); return; }
    if (drawingTool === 'event') {
      const chart = chartRef.current, series = seriesRef.current;
      if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x);
      const price = series.coordinateToPrice(y);
      if (time != null && price != null) {
        setEditingEventId(''); setEventDraft(EMPTY_EVENT_DRAFT); setEventLocation({ time: Number(time), price });
      }
      return;
    }
    if (drawingTool === 'horizontal' || drawingTool === 'image') {
      const chart = chartRef.current, series = seriesRef.current; if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time == null || price == null || (drawingTool === 'image' && !pendingImage)) return;
      pushAnnotationHistory(); setSelectedAnnotationId('');
      if (drawingTool === 'horizontal') setDrawnHorizontals(current => [...current, { id: `horizontal-${Date.now()}`, time: Number(time), price, color: rectColor }]);
      else if (pendingImage) {
        setDrawnImages(current => [...current, { id: `image-${Date.now()}`, time: Number(time), price, color: rectColor, ...pendingImage }]);
        setPendingImage(null); setDrawingTool('select');
      }
      return;
    }
    if (drawingTool === 'text') {
      const chart = chartRef.current, series = seriesRef.current;
      const text = annotationText.trim();
      if (!chart || !series || !text) return;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time != null && price != null) {
        pushAnnotationHistory();
        setDrawnTexts(current => [...current, { id: `text-${Date.now()}`, time: time as number, price, text: text.slice(0, 80), color: rectColor }]);
        setAnnotationText('');
        queueMicrotask(() => annotationInputRef.current?.focus());
      }
      return;
    }
    drawStart.current = { x, y };
  };
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!['rect', 'line', 'arrow'].includes(drawingTool) || !drawStart.current) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    currentPreview.current = { x1: drawStart.current.x, y1: drawStart.current.y, x2: e.clientX - r.left, y2: e.clientY - r.top };
    redrawCanvas();
  };
  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!['rect', 'line', 'arrow'].includes(drawingTool) || !drawStart.current) return;
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const r = canvas.getBoundingClientRect(); const x2 = e.clientX - r.left; const y2 = e.clientY - r.top;
    if (Math.hypot(x2 - drawStart.current.x, y2 - drawStart.current.y) > 6) {
      const t1 = chart.timeScale().coordinateToTime(drawStart.current.x);
      const t2 = chart.timeScale().coordinateToTime(x2);
      const p1 = series.coordinateToPrice(drawStart.current.y);
      const p2 = series.coordinateToPrice(y2);
      if (t1 != null && t2 != null && p1 != null && p2 != null) {
        pushAnnotationHistory();
        const shape = { id: `${drawingTool}-${Date.now()}`, time1: t1 as number, time2: t2 as number, price1: p1, price2: p2, color: rectColor };
        if (drawingTool === 'line') setDrawnLines(prev => [...prev, shape]);
        else if (drawingTool === 'arrow') setDrawnArrows(prev => [...prev, shape]);
        else setDrawnRects(prev => [...prev, shape]);
      }
    }
    drawStart.current = null; currentPreview.current = null; redrawCanvas();
  };

  const handleReplayImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Choose an image file to attach to the chart.'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('Please keep chart images under 8MB.'); return; }
    const token = localStorage.getItem('token'); if (!token) return;
    setUploadingImage(true); setPendingImage(null);
    try {
      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the image')); reader.readAsDataURL(file);
      });
      const caption = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || 'Replay chart evidence';
      const response = await fetch(`${API}/trades/${tradeId}/screenshots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageData, caption: `Replay evidence: ${caption}` }),
      });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not upload chart image');
      const screenshots = Array.isArray(body.screenshots) ? body.screenshots : [];
      const uploaded = screenshots[screenshots.length - 1];
      if (!uploaded?.url) throw new Error('The image uploaded but no image URL was returned');
      setPendingImage({ url: String(uploaded.url), caption, screenshotId: String(uploaded._id || uploaded.publicId || '') });
      setDrawingTool('image'); setSelectedAnnotationId('');
    } catch (uploadError) {
      alert(uploadError instanceof Error ? uploadError.message : 'Could not upload chart image'); setDrawingTool('none');
    } finally { setUploadingImage(false); }
  };

  const handleSave = async () => {
    const token = localStorage.getItem('token'); if (!token) return;
    setSaving(true);
    try {
      const completedQuickReview = { ...quickReview, completedAt: new Date().toISOString() };
      const quickResponse = await fetch(`${API}/trades/${tradeId}/replay-journal/quick-review`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ quickReview: completedQuickReview }),
      });
      if (!quickResponse.ok) { setReviewMode('quick'); throw new Error((await quickResponse.json()).error || 'Complete Quick Review before saving'); }
      setQuickReview(completedQuickReview);
      const finalEmotion = quickReview.primaryEmotion || emotion;
      const finalGrade = quickReview.processGrade || grade;
      const res = await fetch(`${API}/trades/${tradeId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          notes, emotion: finalEmotion, grade: finalGrade, tags, playbookResponses,
          analysisGrade, executionGrade, plannedRR: plannedRR === '' ? null : Number(plannedRR),
          confidenceRating, exitReason, manuallyIntervened,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      onSaved({ notes, emotion: finalEmotion, grade: finalGrade, tags }); onClose();
    } catch (e) { alert(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showShortcutHelp) { e.preventDefault(); setShowShortcutHelp(false); }
      else if (eventLocation || selectedAnnotationId || drawingTool !== 'none' || pendingImage) {
        e.preventDefault(); setEventLocation(null); setEditingEventId(''); setSelectedAnnotationId(''); setPendingImage(null); setDrawingTool('none');
      } else onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('replay-open');
    closeButtonRef.current?.focus();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove('replay-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [drawingTool, eventLocation, onClose, pendingImage, selectedAnnotationId, showShortcutHelp]);

  const totalCandles = replayData?.candles.length ?? 1;
  const progressPct = ((replayIdx + 1) / totalCandles) * 100;
  const entryProgressPct = replayData ? ((replayData.entryIndex + 1) / totalCandles) * 100 : 0;
  const exitProgressPct = replayData ? ((replayData.exitIndex + 1) / totalCandles) * 100 : 0;
  const isProfit = tradeSummary.pnlUSD >= 0;
  const playbook = replayData?.playbookSnapshot;
  const activePhase = JOURNAL_PHASES.find(phase => phase.id === journalPhase) || JOURNAL_PHASES[0];
  const phaseBlocks = playbook?.blocks.filter(block => activePhase.categories.includes(block.category as never)) || [];
  const allPlaybookRules = playbook?.blocks.flatMap(block => block.rules) || [];
  const visibleTimelineEvents = timelineEvents.filter(event => event.timeframe === selectedInterval || event.visibilityScope === 'all').sort((a, b) => a.candleTime - b.candleTime);
  const timelineProgressMarkers = replayData ? visibleTimelineEvents.map(event => {
    const index = replayData.candles.findIndex(candle => Number(candle.time) >= event.candleTime);
    return { event, index, progress: index >= 0 ? ((index + 1) / totalCandles) * 100 : 0 };
  }).filter(marker => marker.index >= 0) : [];
  const previousTimelineMarker = [...timelineProgressMarkers].reverse().find(marker => marker.index < replayIdx);
  const nextTimelineMarker = timelineProgressMarkers.find(marker => marker.index > replayIdx);
  const globalTimelineEventCount = timelineEvents.filter(event => event.visibilityScope === 'all').length;
  const answeredRules = allPlaybookRules.filter(rule => {
    const value = playbookResponses[rule.ruleId];
    return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
  }).length;
  const quickReviewReadyForGrade = quickReview.followedPlan !== null && Boolean(quickReview.primaryEmotion) && Boolean(quickReview.lesson.trim())
    && (quickReview.followedPlan ? Boolean(quickReview.primaryStrength.trim()) : Boolean(quickReview.primaryMistake.trim()));
  const quickReviewContradiction = quickReview.processGrade && (
    (quickReview.followedPlan === true && ['C', 'D', 'F'].includes(quickReview.processGrade))
    || (quickReview.followedPlan === false && ['A', 'B'].includes(quickReview.processGrade))
  ) ? (quickReview.followedPlan ? 'You followed the plan but gave the process a low grade. Recheck what still needs improvement.' : 'You did not follow the plan but gave the process a high grade. Make sure the grade reflects execution, not P&L.') : '';
  const setRuleAnswer = (ruleId: string, value: unknown) => setPlaybookResponses(current => ({ ...current, [ruleId]: value }));
  const jumpToReplayIndex = useCallback((index: number) => {
    if (!replayData) return;
    const target = Math.max(0, Math.min(replayData.candles.length - 1, index));
    setPlaying(false); setPausedMarker(''); setReplayIdx(target);
    queueMicrotask(() => chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, target - 30), to: Math.min(replayData.candles.length - 1, target + 10) }));
  }, [replayData]);
  const switchTimeframe = (interval: string) => {
    if (interval === selectedInterval) return;
    setPlaying(false); setReplayData(null); setLoading(true); setError(''); setReplayDebug(null); setWaitingForMt5(false);
    setDrawnRects([]); setDrawnLines([]); setDrawnHorizontals([]); setDrawnArrows([]); setDrawnTexts([]); setDrawnImages([]);
    setSelectedAnnotationId(''); setPendingImage(null); currentPreview.current = null;
    annotationHistoryRef.current = []; setAnnotationHistoryDepth(0);
    setSelectedInterval(interval);
    onIntervalChange?.(interval);
  };
  const undoAnnotation = () => {
    const previous = annotationHistoryRef.current.pop();
    if (!previous) return;
    setAnnotationHistoryDepth(annotationHistoryRef.current.length);
    setDrawnRects(previous.rects); setDrawnLines(previous.lines); setDrawnHorizontals(previous.horizontals); setDrawnArrows(previous.arrows); setDrawnTexts(previous.texts); setDrawnImages(previous.images);
    setSelectedAnnotationId('');
  };
  const deleteAnnotation = (annotation: ReplayAnnotation) => {
    pushAnnotationHistory();
    if (annotation.type === 'rect') setDrawnRects(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'line') setDrawnLines(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'horizontal') setDrawnHorizontals(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'arrow') setDrawnArrows(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'text') setDrawnTexts(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'image') setDrawnImages(current => current.filter(item => item.id !== annotation.id));
    setSelectedAnnotationId(current => current === annotation.id ? '' : current);
  };
  const deleteSelectedAnnotation = () => {
    const annotation = allAnnotations.find(item => item.id === selectedAnnotationId); if (annotation) deleteAnnotation(annotation);
  };
  useEffect(() => {
    const onDelete = (event: KeyboardEvent) => {
      if (!selectedAnnotationId || !['Delete', 'Backspace'].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); deleteSelectedAnnotation();
    };
    window.addEventListener('keydown', onDelete); return () => window.removeEventListener('keydown', onDelete);
  });
  const clearAnnotations = () => {
    if (allAnnotations.length === 0 || !window.confirm(`Clear all ${allAnnotations.length} annotations from ${selectedInterval}?`)) return;
    pushAnnotationHistory(); setDrawnRects([]); setDrawnLines([]); setDrawnHorizontals([]); setDrawnArrows([]); setDrawnTexts([]); setDrawnImages([]);
    setSelectedAnnotationId(''); currentPreview.current = null; redrawCanvas();
  };
  const saveTimelineEvent = () => {
    if (!eventLocation || !eventDraft.title.trim()) return;
    const existing = timelineEvents.find(event => event.eventId === editingEventId);
    const event: ReplayTimelineEvent = {
      eventId: existing?.eventId || `event-${Date.now()}`,
      timeframe: existing?.timeframe || selectedInterval,
      visibilityScope: eventDraft.visibilityScope,
      candleTime: eventLocation.time, price: eventLocation.price,
      eventType: eventDraft.eventType, customType: eventDraft.eventType === 'custom' ? eventDraft.customType.trim() : '',
      title: eventDraft.title.trim().slice(0, 100), note: eventDraft.note.trim().slice(0, 1000), emotion: eventDraft.emotion,
      severity: eventDraft.severity, playbookRuleId: eventDraft.playbookRuleId,
      playbookVersionId: eventDraft.playbookRuleId ? replayData?.playbookSnapshot?.versionId || '' : '',
      screenshotIds: existing?.screenshotIds || [], createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setTimelineEvents(current => [...current.filter(item => item.eventId !== event.eventId), event].sort((a, b) => a.candleTime - b.candleTime));
    setEventLocation(null); setEditingEventId(''); setEventDraft(EMPTY_EVENT_DRAFT); setDrawingTool('none');
  };
  const editTimelineEvent = (event: ReplayTimelineEvent) => {
    setEditingEventId(event.eventId); setEventLocation({ time: event.candleTime, price: event.price });
    setEventDraft({ eventType: event.eventType, customType: event.customType || '', title: event.title, note: event.note || '', emotion: event.emotion || '', severity: event.severity, playbookRuleId: event.playbookRuleId || '', visibilityScope: event.visibilityScope === 'all' ? 'all' : 'timeframe' });
  };
  const deleteTimelineEvent = (eventId: string) => setTimelineEvents(current => current.filter(event => event.eventId !== eventId));
  const navigateToTimelineEvent = (event: ReplayTimelineEvent) => {
    if (!replayData) { pendingTimelineNavigationRef.current = event.eventId; return; }
    if (event.visibilityScope !== 'all' && event.timeframe !== selectedInterval) {
      pendingTimelineNavigationRef.current = event.eventId; switchTimeframe(event.timeframe);
      return;
    }
    const index = replayData.candles.findIndex(candle => Number(candle.time) >= event.candleTime);
    if (index < 0) return;
    jumpToReplayIndex(index);
  };
  useEffect(() => {
    const onReplayShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.key === '?') { event.preventDefault(); setShowShortcutHelp(current => !current); return; }
      if (!replayData) return;
      if (event.code === 'Space') { event.preventDefault(); setPausedMarker(''); setPlaying(current => !current); return; }
      if (event.key === 'ArrowLeft') { event.preventDefault(); jumpToReplayIndex(replayIdx - 1); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); jumpToReplayIndex(replayIdx + 1); return; }
      if (key === 'e') { event.preventDefault(); jumpToReplayIndex(replayData.entryIndex); return; }
      if (key === 'x') { event.preventDefault(); jumpToReplayIndex(replayData.exitIndex); return; }
      if (event.key === '[' && previousTimelineMarker) { event.preventDefault(); jumpToReplayIndex(previousTimelineMarker.index); return; }
      if (event.key === ']' && nextTimelineMarker) { event.preventDefault(); jumpToReplayIndex(nextTimelineMarker.index); return; }
      if (reviewMode !== 'quick') return;
      if (key === 'y' || key === 'n') {
        event.preventDefault(); const followedPlan = key === 'y';
        setQuickReview(current => ({ ...current, followedPlan, primaryMistake: followedPlan ? '' : current.primaryMistake, primaryStrength: followedPlan ? current.primaryStrength : '', completedAt: null }));
        return;
      }
      const emotionIndex = Number(event.key) - 1;
      if (emotionIndex >= 0 && emotionIndex < EMOTIONS.length) {
        event.preventDefault(); const value = EMOTIONS[emotionIndex].name;
        setQuickReview(current => ({ ...current, primaryEmotion: value, completedAt: null })); setEmotion(value); return;
      }
      const gradeKey = event.key.toUpperCase();
      if (quickReviewReadyForGrade && GRADES.includes(gradeKey as typeof GRADES[number])) {
        event.preventDefault(); setQuickReview(current => ({ ...current, processGrade: gradeKey, completedAt: null })); setGrade(gradeKey);
      }
    };
    window.addEventListener('keydown', onReplayShortcut); return () => window.removeEventListener('keydown', onReplayShortcut);
  }, [jumpToReplayIndex, nextTimelineMarker, previousTimelineMarker, quickReviewReadyForGrade, replayData, replayIdx, reviewMode]);
  const renderRuleInput = (rule: ReplayPlaybookRule) => {
    const value = playbookResponses[rule.ruleId];
    if (rule.inputType === 'boolean') return (
      <div className="replay-rule-options">
        {[true, false].map(option => <button type="button" key={String(option)} className={value === option ? 'selected' : ''} onClick={() => setRuleAnswer(rule.ruleId, option)}>{option ? 'Yes' : 'No'}</button>)}
      </div>
    );
    if (rule.inputType === 'single_choice') return (
      <select className="replay-rule-input" value={String(value ?? '')} onChange={event => setRuleAnswer(rule.ruleId, event.target.value)}>
        <option value="">Select an answer</option>{(rule.options || []).map(option => <option key={option}>{option}</option>)}
      </select>
    );
    if (rule.inputType === 'multi_choice') {
      const selected = Array.isArray(value) ? value as string[] : [];
      return <div className="replay-rule-options wrap">{(rule.options || []).map(option => <button type="button" key={option} className={selected.includes(option) ? 'selected' : ''} onClick={() => setRuleAnswer(rule.ruleId, selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option])}>{option}</button>)}</div>;
    }
    const numeric = ['number', 'percentage', 'currency', 'price', 'duration', 'risk_reward', 'rating'].includes(rule.inputType);
    if (rule.inputType === 'long_text') return <textarea className="replay-rule-input" value={String(value ?? '')} onChange={event => setRuleAnswer(rule.ruleId, event.target.value)} />;
    return <input className="replay-rule-input" type={numeric ? 'number' : rule.inputType === 'date' ? 'date' : rule.inputType === 'time' ? 'time' : 'text'} value={String(value ?? '')} onChange={event => setRuleAnswer(rule.ruleId, numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />;
  };

  return (
    <div className="replay-overlay" role="dialog" aria-modal="true" aria-label="Trade Replay">
      <div className="replay-topbar">
        <div className="replay-trade-summary">
          <span className="replay-topbar-symbol">{tradeSummary.symbol}<span className={`replay-direction ${tradeSummary.direction.toLowerCase()}`}>{tradeSummary.direction}</span></span>
          <span className={`replay-topbar-pnl ${isProfit ? 'positive' : 'negative'}`}>{isProfit ? '+' : ''}{tradeSummary.pnlUSD.toFixed(2)} USD ({isProfit ? '+' : ''}{tradeSummary.pnlPct.toFixed(2)}%)</span>
          <span className="replay-topbar-meta">{tradeSummary.entryPrice.toFixed(5)} → {tradeSummary.exitPrice.toFixed(5)} · {fmtDur(tradeSummary.durationMinutes)} · {tradeSummary.lotSize.toFixed(2)} lots</span>
        </div>
        <button ref={closeButtonRef} className="replay-close-btn" onClick={onClose} title="Close Replay (Esc)" aria-label="Close Replay"><X size={16} /> Close</button>
      </div>

      <div className="replay-workspace-toolbar" aria-label="Replay chart tools">
        <div className="replay-tool-group timeframe-group">
          <span className="replay-tool-group-label">Timeframe</span>
          <div className="replay-timeframes" role="group" aria-label="Chart timeframe">
            {REPLAY_TIMEFRAMES.map(timeframe => <button type="button" key={timeframe.value} aria-pressed={selectedInterval === timeframe.value} className={selectedInterval === timeframe.value ? 'active' : ''} onClick={() => switchTimeframe(timeframe.value)}>{timeframe.label}</button>)}
          </div>
        </div>
        <div className="replay-toolbar-divider" />
        <div className="replay-tool-group">
          <span className="replay-tool-group-label">Annotate</span>
          <button type="button" aria-pressed={drawingTool === 'select'} className={`replay-tool-btn${drawingTool === 'select' ? ' active' : ''}`} onClick={() => { setDrawingTool(tool => tool === 'select' ? 'none' : 'select'); setPendingImage(null); }} title="Select an annotation to inspect or delete"><MousePointer2 size={16} /> Select</button>
          <button type="button" aria-pressed={drawingTool === 'rect'} className={`replay-tool-btn${drawingTool === 'rect' ? ' active' : ''}`} onClick={() => setDrawingTool(t => t === 'rect' ? 'none' : 'rect')} title="Draw rectangle zones"><Square size={16} /> Zone</button>
          <button type="button" aria-pressed={drawingTool === 'line'} className={`replay-tool-btn${drawingTool === 'line' ? ' active' : ''}`} onClick={() => setDrawingTool(t => t === 'line' ? 'none' : 'line')} title="Draw a trend line"><Minus size={16} /> Line</button>
          <button type="button" aria-pressed={drawingTool === 'horizontal'} className={`replay-tool-btn${drawingTool === 'horizontal' ? ' active' : ''}`} onClick={() => setDrawingTool(t => t === 'horizontal' ? 'none' : 'horizontal')} title="Place a horizontal support or resistance level"><MoveHorizontal size={16} /> Level</button>
          <button type="button" aria-pressed={drawingTool === 'arrow'} className={`replay-tool-btn${drawingTool === 'arrow' ? ' active' : ''}`} onClick={() => setDrawingTool(t => t === 'arrow' ? 'none' : 'arrow')} title="Draw a directional arrow"><ArrowUpRight size={16} /> Arrow</button>
          <button type="button" aria-pressed={drawingTool === 'text'} className={`replay-tool-btn${drawingTool === 'text' ? ' active' : ''}`} onClick={() => setDrawingTool(t => t === 'text' ? 'none' : 'text')} title="Place text on the chart"><TypeIcon size={16} /> Text</button>
          <input ref={imageInputRef} className="replay-hidden-file" type="file" accept="image/*" onChange={handleReplayImageUpload} />
          <button type="button" disabled={uploadingImage} aria-pressed={drawingTool === 'image'} className={`replay-tool-btn${drawingTool === 'image' ? ' active' : ''}`} onClick={() => imageInputRef.current?.click()} title="Upload an image and pin it to a candle and price"><ImagePlus size={16} /> {uploadingImage ? 'Uploading…' : 'Image'}</button>
          <button type="button" aria-pressed={drawingTool === 'event'} className={`replay-tool-btn${drawingTool === 'event' ? ' active' : ''}`} onClick={() => { setDrawingTool(tool => tool === 'event' ? 'none' : 'event'); setEventLocation(null); setEditingEventId(''); }} title="Attach a journal event to a candle"><MapPin size={16} /> Event</button>
        </div>
        {['rect', 'line', 'horizontal', 'arrow', 'text', 'image'].includes(drawingTool) && <div className="replay-tool-group replay-color-group" role="group" aria-label="Drawing color">
          <span className="replay-tool-group-label">Color</span>
          {RECT_COLORS.map(color => <button type="button" key={color} aria-label={`Use drawing color ${color}`} aria-pressed={color === rectColor} className={color === rectColor ? 'active' : ''} onClick={() => setRectColor(color)} style={{ '--replay-swatch': color } as React.CSSProperties} />)}
        </div>}
        <span className="replay-toolbar-spacer" />
        <span className={`replay-annotation-status ${annotationSaveState}`} role="status" title={annotationSaveError || 'Chart annotations save automatically'}>{annotationSaveState === 'loading' ? 'Loading notes…' : annotationSaveState === 'saving' ? 'Saving notes…' : annotationSaveState === 'error' ? 'Notes not saved' : 'Notes saved'}</span>
        <div className="replay-tool-group replay-tool-actions">
          <button type="button" className="replay-tool-btn" disabled={annotationHistoryDepth === 0} onClick={undoAnnotation} title="Undo the last annotation change"><Undo2 size={16} /> Undo</button>
          <button type="button" className="replay-tool-btn replay-delete-tool" disabled={!selectedAnnotationId} onClick={deleteSelectedAnnotation} title="Delete the selected annotation (Delete)"><Trash2 size={16} /> Delete</button>
          {allAnnotations.length > 0 && <button type="button" aria-pressed={showAnnotationList} className={`replay-tool-btn${showAnnotationList ? ' active' : ''}`} title="Manage saved annotations" onClick={() => setShowAnnotationList(current => !current)}>Objects ({allAnnotations.length})</button>}
        </div>
      </div>

      <div className="replay-body">
        <div className="replay-chart-wrap">
          <div ref={chartContainerRef} className="replay-chart-container" />
          {drawingTool === 'text' && (
            <div className="replay-chart-text-editor" role="group" aria-label="Write on chart">
              <TypeIcon size={15} />
              <input
                ref={annotationInputRef}
                aria-label="Text to place on chart"
                placeholder="Write a note…"
                maxLength={80}
                value={annotationText}
                onChange={event => setAnnotationText(event.target.value)}
              />
              <span>{annotationText.trim() ? 'Click the chart to place it' : 'Type your note first'}</span>
            </div>
          )}
          {drawingTool === 'image' && pendingImage && (
            <div className="replay-chart-image-placer" role="status">
              <ImagePlus size={16} /><div><strong>Image ready to place</strong><input aria-label="Image caption" maxLength={180} value={pendingImage.caption} onChange={event => setPendingImage(current => current ? { ...current, caption: event.target.value } : current)} /><span>Describe the evidence, then click the candle and price where it belongs.</span></div>
              <button type="button" onClick={() => { setPendingImage(null); setDrawingTool('none'); }}>Cancel</button>
            </div>
          )}
          {eventLocation && (
            <div className="replay-event-editor" role="dialog" aria-label={editingEventId ? 'Edit timeline event' : 'Add timeline event'}>
              <div className="replay-event-editor-head"><strong>{editingEventId ? 'Edit chart event' : 'What happened here?'}</strong><button type="button" onClick={() => { setEventLocation(null); setEditingEventId(''); }}>×</button></div>
              <div className="replay-event-editor-grid">
                <label>Event type<select value={eventDraft.eventType} onChange={event => setEventDraft(current => ({ ...current, eventType: event.target.value }))}>{REPLAY_EVENT_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label>Importance<select value={eventDraft.severity} onChange={event => setEventDraft(current => ({ ...current, severity: event.target.value as ReplayEventDraft['severity'] }))}><option value="minor">Minor</option><option value="important">Important</option><option value="critical">Critical</option></select></label>
              </div>
              {eventDraft.eventType === 'custom' && <label>Custom type<input maxLength={60} value={eventDraft.customType} onChange={event => setEventDraft(current => ({ ...current, customType: event.target.value }))} placeholder="e.g. News reaction" /></label>}
              <fieldset className="replay-event-visibility">
                <legend>Show this event on</legend>
                <div>
                  <label><input type="radio" name="event-visibility" checked={eventDraft.visibilityScope === 'timeframe'} onChange={() => setEventDraft(current => ({ ...current, visibilityScope: 'timeframe' }))} /><span>This timeframe <small>{editingEventId ? timelineEvents.find(item => item.eventId === editingEventId)?.timeframe || selectedInterval : selectedInterval}</small></span></label>
                  <label><input type="radio" name="event-visibility" checked={eventDraft.visibilityScope === 'all'} onChange={() => setEventDraft(current => ({ ...current, visibilityScope: 'all' }))} /><span>All timeframes <small>Shared trade decision</small></span></label>
                </div>
                <p>Use one timeframe for chart-specific observations. Use all timeframes for decisions or lessons that belong to the whole trade.</p>
              </fieldset>
              <label>Short title<input autoFocus maxLength={100} value={eventDraft.title} onChange={event => setEventDraft(current => ({ ...current, title: event.target.value }))} placeholder="e.g. Entered before confirmation" /></label>
              <label>Details<textarea maxLength={1000} value={eventDraft.note} onChange={event => setEventDraft(current => ({ ...current, note: event.target.value }))} placeholder="What did you see, decide, or feel?" /></label>
              <div className="replay-event-editor-grid">
                <label>Emotion<select value={eventDraft.emotion} onChange={event => setEventDraft(current => ({ ...current, emotion: event.target.value }))}><option value="">None</option>{EMOTIONS.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
                <label>Playbook rule<select value={eventDraft.playbookRuleId} onChange={event => setEventDraft(current => ({ ...current, playbookRuleId: event.target.value }))}><option value="">No linked rule</option>{allPlaybookRules.map(rule => <option value={rule.ruleId} key={rule.ruleId}>{rule.label}</option>)}</select></label>
              </div>
              <div className="replay-event-editor-actions"><button type="button" onClick={() => { setEventLocation(null); setEditingEventId(''); }}>Cancel</button><button type="button" className="primary" disabled={!eventDraft.title.trim()} onClick={saveTimelineEvent}>{editingEventId ? 'Update event' : 'Add to timeline'}</button></div>
            </div>
          )}
          {showAnnotationList && allAnnotations.length > 0 && (
            <div className="replay-annotation-manager" aria-label="Chart annotations">
              <div className="replay-annotation-manager-head"><strong>Saved annotations</strong><button type="button" onClick={clearAnnotations}>Clear all</button></div>
              {allAnnotations.map((annotation, index) => (
                <div className={`replay-annotation-row${selectedAnnotationId === annotation.id ? ' selected' : ''}`} key={annotation.id}>
                  <button type="button" className="replay-annotation-select" aria-pressed={selectedAnnotationId === annotation.id} onClick={() => { setSelectedAnnotationId(annotation.id); setDrawingTool('select'); }}>
                    <i style={{ background: annotation.color }} />
                    <span><b>{annotation.type === 'rect' ? 'Zone' : annotation.type === 'line' ? 'Trend line' : annotation.type === 'horizontal' ? 'Level' : annotation.type === 'arrow' ? 'Arrow' : annotation.type === 'image' ? 'Image' : 'Text'}</b>{annotation.type === 'text' ? ` — ${annotation.text}` : annotation.type === 'image' ? ` — ${annotation.caption || 'Chart evidence'}` : ` ${index + 1}`}</span>
                  </button>
                  <button type="button" onClick={click => { click.stopPropagation(); deleteAnnotation(annotation); }} aria-label={`Delete ${annotation.type} annotation`}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
          <canvas ref={canvasRef}
            className={`replay-canvas-overlay${drawingTool !== 'none' ? ' drawing-active' : ''}${drawingTool === 'select' ? ' selecting' : ''}`}
            aria-label={drawingTool === 'select' ? 'Select a chart annotation' : 'Place a chart annotation'}
            onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp}
            onMouseLeave={() => { if (drawStart.current) { drawStart.current = null; currentPreview.current = null; redrawCanvas(); } }} />
          {pausedMarker && <div className="replay-marker-pause" role="status"><PauseCircle size={18} /><div><strong>Paused at {pausedMarker}</strong><span>Review what you knew and what you decided here.</span></div></div>}
          {showShortcutHelp && (
            <div className="replay-shortcut-help" role="dialog" aria-label="Replay keyboard shortcuts">
              <div className="replay-shortcut-head"><div><Keyboard size={17} /><strong>Keyboard review</strong></div><button type="button" onClick={() => setShowShortcutHelp(false)} aria-label="Close keyboard shortcuts"><X size={15} /></button></div>
              <p>Shortcuts pause while you type in any journal field.</p>
              <div className="replay-shortcut-grid">
                <kbd>Space</kbd><span>Play or pause</span><kbd>← / →</kbd><span>Step one candle</span>
                <kbd>E / X</kbd><span>Jump to entry / exit</span><kbd>[ / ]</kbd><span>Previous / next review moment</span>
                <kbd>Y / N</kbd><span>Followed the plan</span><kbd>1–6</kbd><span>Choose emotion</span>
                <kbd>A–F</kbd><span>Process grade</span><kbd>?</kbd><span>Show or hide this guide</span>
              </div>
            </div>
          )}
          {loading && (
            <div className="replay-chart-state">
              <div className="replay-spinner" />
              <h4>{waitingForMt5 ? 'Waiting for MT5…' : 'Loading chart data…'}</h4>
              <p>{waitingForMt5 ? `Requesting exact ${tradeSummary.symbol} candles from your broker terminal` : 'Preparing trade replay'}</p>
              {replayDebug && <ReplayDiagnostics debug={replayDebug} />}
              {waitingForMt5 && <button type="button" className="replay-setup-link" onClick={loadTwelveFallback}>Use Twelve Data fallback</button>}
            </div>
          )}
          {!loading && error && (
            <div className="replay-chart-state">
              <AlertTriangle size={32} color="#f59e0b" />
              <h4>{isSetupError ? 'Replay Not Configured' : 'Chart Data Unavailable'}</h4>
              <p>{error}</p>
              {replayDebug && <ReplayDiagnostics debug={replayDebug} />}
              {waitingForMt5 && <button type="button" className="replay-setup-link" onClick={loadTwelveFallback}>Use Twelve Data fallback</button>}
              {isSetupError && (
                <>
                  <a href="https://twelvedata.com/register" target="_blank" rel="noopener noreferrer" className="replay-setup-link">
                    Get Free API Key <ExternalLink size={12} />
                  </a>
                  <p style={{ fontSize: 11, maxWidth: 300, marginTop: 4 }}>
                    Then add <code style={{ background: '#1a2035', padding: '1px 5px', borderRadius: 4 }}>TWELVE_DATA_API_KEY=your_key</code> to{' '}
                    <code style={{ background: '#1a2035', padding: '1px 5px', borderRadius: 4 }}>backend/.env</code> and restart the server.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="replay-journal-panel">
          <div className={`replay-draft-status ${draftSaveState}`} title={draftSaveError || 'Unfinished journal fields and Replay position save automatically'}>
            <span>{draftSaveState === 'loading' ? 'Restoring draft…' : draftSaveState === 'saving' ? 'Saving draft…' : draftSaveState === 'error' ? 'Draft not saved' : 'Draft saved'}</span>
            <small>{draftSaveState === 'error' ? draftSaveError : 'Safe to refresh or close'}</small>
          </div>
          <section className="replay-timeline">
            <div className="replay-timeline-head">
              <div><span>Trade timeline</span><strong>{visibleTimelineEvents.length} visible on {selectedInterval}{globalTimelineEventCount ? ` · ${globalTimelineEventCount} shared` : ''} · {timelineEvents.length} total</strong></div>
              <small className={eventSaveState} title={eventSaveError}>{eventSaveState === 'saving' ? 'Saving…' : eventSaveState === 'error' ? 'Not saved' : 'Saved'}</small>
            </div>
            {visibleTimelineEvents.length === 0 ? (
              <button type="button" className="replay-timeline-empty" onClick={() => setDrawingTool('event')}><MapPin size={14} /> Select Event, then click a candle to tell the trade story.</button>
            ) : visibleTimelineEvents.map(event => (
              <article className="replay-timeline-event" key={event.eventId} onClick={() => navigateToTimelineEvent(event)}>
                <i className={event.severity} />
                <div><span>{new Date(event.candleTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {REPLAY_EVENT_TYPES.find(([value]) => value === event.eventType)?.[1] || event.customType} <em>{event.visibilityScope === 'all' ? 'All charts' : event.timeframe}</em></span><strong>{event.title}</strong>{event.note && <p>{event.note}</p>}</div>
                <div className="replay-timeline-actions"><button type="button" onClick={click => { click.stopPropagation(); editTimelineEvent(event); }}>Edit</button><button type="button" onClick={click => { click.stopPropagation(); if (window.confirm('Delete this timeline event?')) deleteTimelineEvent(event.eventId); }}><Trash2 size={12} /></button></div>
              </article>
            ))}
          </section>
          <div className="replay-review-mode" role="tablist" aria-label="Review depth">
            <button type="button" role="tab" aria-selected={reviewMode === 'quick'} className={reviewMode === 'quick' ? 'active' : ''} onClick={() => setReviewMode('quick')}>Quick Review</button>
            <button type="button" role="tab" aria-selected={reviewMode === 'playbook'} className={reviewMode === 'playbook' ? 'active' : ''} onClick={() => setReviewMode('playbook')}>Deep Playbook</button>
          </div>
          {reviewMode === 'quick' && (
            <section className="replay-quick-review">
              <div className="replay-quick-head"><div><span>20–30 second review</span><strong>Grade the process, not the P&amp;L</strong></div><small className={quickReviewSaveState} title={quickReviewError}>{quickReviewSaveState === 'saving' ? 'Saving…' : quickReviewSaveState === 'error' ? 'Not saved' : quickReview.completedAt ? 'Complete' : 'Draft saved'}</small></div>
              <div className="replay-quick-question"><label>1. Did you follow the plan?</label><div className="replay-quick-options"><button type="button" aria-keyshortcuts="Y" className={quickReview.followedPlan === true ? 'selected good' : ''} onClick={() => setQuickReview(current => ({ ...current, followedPlan: true, primaryMistake: '', completedAt: null }))}>Yes <kbd>Y</kbd></button><button type="button" aria-keyshortcuts="N" className={quickReview.followedPlan === false ? 'selected bad' : ''} onClick={() => setQuickReview(current => ({ ...current, followedPlan: false, primaryStrength: '', completedAt: null }))}>No <kbd>N</kbd></button></div></div>
              <div className="replay-quick-question"><label>2. What was the main emotion?</label><div className="replay-quick-emotions">{EMOTIONS.map((item, index) => <button type="button" key={item.name} title={`${item.name} (${index + 1})`} aria-keyshortcuts={String(index + 1)} className={quickReview.primaryEmotion === item.name ? 'selected' : ''} onClick={() => { const value = quickReview.primaryEmotion === item.name ? '' : item.name; setQuickReview(current => ({ ...current, primaryEmotion: value, completedAt: null })); setEmotion(value); }}>{item.emoji}<span>{item.name}</span><kbd>{index + 1}</kbd></button>)}</div></div>
              {quickReview.followedPlan === false && <div className="replay-quick-question"><label>3. What was the main mistake?</label><input value={quickReview.primaryMistake} maxLength={100} onChange={event => setQuickReview(current => ({ ...current, primaryMistake: event.target.value, completedAt: null }))} placeholder="e.g. Entered before confirmation" /></div>}
              {quickReview.followedPlan === true && <div className="replay-quick-question"><label>3. What should you repeat?</label><input value={quickReview.primaryStrength} maxLength={100} onChange={event => setQuickReview(current => ({ ...current, primaryStrength: event.target.value, completedAt: null }))} placeholder="e.g. Waited for the sweep and confirmation" /></div>}
              {quickReview.followedPlan === null && <div className="replay-quick-hint">Choose Yes or No to reveal the next question.</div>}
              <div className="replay-quick-question"><label>4. What is the main lesson?</label><textarea value={quickReview.lesson} maxLength={500} onChange={event => setQuickReview(current => ({ ...current, lesson: event.target.value, completedAt: null }))} placeholder="One clear action for the next trade" /></div>
              <div className="replay-quick-question"><label>5. Process grade</label>{!quickReviewReadyForGrade && <p className="replay-grade-lock">Complete questions 1–4 before grading the process.</p>}<div className="replay-quick-grades">{GRADES.map(item => <button type="button" key={item} disabled={!quickReviewReadyForGrade} aria-keyshortcuts={item} className={quickReview.processGrade === item ? 'selected' : ''} onClick={() => { const value = quickReview.processGrade === item ? '' : item; setQuickReview(current => ({ ...current, processGrade: value, completedAt: null })); setGrade(value); }}>{item}</button>)}</div>{quickReviewContradiction && <p className="replay-review-check" role="status">{quickReviewContradiction}</p>}</div>
            </section>
          )}
          {reviewMode === 'playbook' && <>
          <div className="replay-playbook-head">
            <div>
              <span>Strategy playbook</span>
              <strong>{playbook ? `${playbook.name} · v${playbook.versionNumber}` : 'No playbook attached'}</strong>
            </div>
            {playbook && <div className="replay-compliance">{answeredRules}/{allPlaybookRules.length}</div>}
          </div>
          {playbook && (
            <>
              <div className="replay-phase-tabs" role="tablist" aria-label="Journal phase">
                {JOURNAL_PHASES.map(phase => (
                  <button type="button" role="tab" aria-selected={journalPhase === phase.id} key={phase.id} className={journalPhase === phase.id ? 'active' : ''} onClick={() => { setJournalPhase(phase.id); onJournalPhaseChange?.(phase.id); }}>{phase.label}</button>
                ))}
              </div>
              <div className="replay-playbook-rules">
                {phaseBlocks.length === 0 && <div className="replay-empty-phase">No rules in this phase.</div>}
                {phaseBlocks.map(block => (
                  <section key={block.blockId} className="replay-rule-block">
                    <h4>{block.name}</h4>
                    {block.rules.map(rule => (
                      <div key={rule.ruleId} className="replay-rule-field">
                        <label>{rule.label}{rule.required && <span> *</span>}</label>
                        <div className="replay-rule-context"><span>{RULE_TOOL_LABELS[rule.toolRole || 'observation'] || 'Observation'}</span><span>{rule.timeframes?.length ? rule.timeframes.join(' · ') : 'All timeframes'}</span></div>
                        {rule.helpText && <p>{rule.helpText}</p>}
                        {rule.failureAction && rule.failureAction !== 'none' && <div className={`replay-rule-decision${rule.inputType === 'boolean' && playbookResponses[rule.ruleId] === false ? ' active' : ''}`}><strong>If not satisfied: {FAILURE_ACTION_LABELS[rule.failureAction] || rule.failureAction}</strong>{rule.failureMessage && <span>{rule.failureMessage}</span>}</div>}
                        {renderRuleInput(rule)}
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </>
          )}
          {journalPhase === 'review' && (
            <section className="replay-rule-block">
              <h4>Outcome review</h4>
              <div className="replay-grade-pair">
                {[{ label: 'Analysis', value: analysisGrade, set: setAnalysisGrade }, { label: 'Execution', value: executionGrade, set: setExecutionGrade }].map(group => (
                  <div key={group.label}><label>{group.label} grade</label><div className="replay-rule-options">{GRADES.map(item => <button type="button" key={item} className={group.value === item ? 'selected' : ''} onClick={() => group.set(group.value === item ? '' : item)}>{item}</button>)}</div></div>
                ))}
              </div>
              <div className="replay-review-grid">
                <label>Planned R:R<input className="replay-rule-input" type="number" min="0" step="0.1" value={plannedRR} onChange={event => setPlannedRR(event.target.value)} /></label>
                <label>Exit reason<select className="replay-rule-input" value={exitReason} onChange={event => setExitReason(event.target.value)}><option value="">Select</option>{['TP', 'SL', 'Fear', 'Revenge', 'News', 'ManualClose', 'FOMO', 'PartialClose', 'Other'].map(item => <option key={item}>{item}</option>)}</select></label>
              </div>
              <label className="replay-confidence">Pre-trade confidence <strong>{confidenceRating ?? '—'}/10</strong><input type="range" min="1" max="10" value={confidenceRating ?? 5} onChange={event => setConfidenceRating(Number(event.target.value))} /></label>
              <div className="replay-rule-field"><label>Manually intervened?</label><div className="replay-rule-options">{[{ label: 'Yes', value: true }, { label: 'No', value: false }, { label: 'Unknown', value: null }].map(item => <button type="button" key={item.label} className={manuallyIntervened === item.value ? 'selected' : ''} onClick={() => setManuallyIntervened(item.value)}>{item.label}</button>)}</div></div>
            </section>
          )}
          <div className="replay-panel-section">
            <div className="replay-panel-label"><BookOpenText size={13} /> Journal Notes</div>
            <textarea className="replay-panel-textarea"
              placeholder="What was the setup? What did you do well or poorly? What would you do differently?"
              value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          <div className="replay-panel-section">
            <div className="replay-panel-label"><Brain size={13} /> Emotion</div>
            <div className="replay-emotion-grid">
              {EMOTIONS.map(em => (
                <button key={em.name} className={`replay-emotion-btn${emotion === em.name ? ' selected' : ''}`}
                  onClick={() => setEmotion(emotion === em.name ? '' : em.name)}>
                  <span className="emoji">{em.emoji}</span><span>{em.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="replay-panel-section">
            <div className="replay-panel-label"><Award size={13} /> Trade Grade</div>
            <div className="replay-grade-row">
              {GRADES.map(g => (
                <button key={g} className={`replay-grade-btn ${g}${grade === g ? ' selected' : ''}`}
                  onClick={() => setGrade(grade === g ? '' : g)}>{g}</button>
              ))}
            </div>
          </div>
          </>}
          <div className="replay-panel-section">
            <div className="replay-panel-label"><Tags size={13} /> Tags</div>
            <div className="replay-tags-row">
              {tags.map(t => (
                <span key={t} className="replay-tag">#{t}
                  <button className="replay-tag-remove" onClick={() => setTags(p => p.filter(x => x !== t))}>×</button>
                </span>
              ))}
              <form onSubmit={e => { e.preventDefault(); const v = tagInput.trim().replace(/^#/, ''); if (v && !tags.includes(v)) setTags(p => [...p, v]); setTagInput(''); }}>
                <input className="replay-tag-input" placeholder="+ tag" value={tagInput} onChange={e => setTagInput(e.target.value)} maxLength={30} />
              </form>
            </div>
          </div>
          <div className="replay-panel-section" style={{ borderTop: '1px solid #1a2035', paddingTop: 14 }}>
            <div className="replay-panel-label"><BarChart3 size={13} /> Trade Stats</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { label: 'Entry', val: tradeSummary.entryPrice.toFixed(5) },
                { label: 'Exit',  val: tradeSummary.exitPrice.toFixed(5) },
                { label: 'P&L',  val: `${isProfit ? '+' : ''}$${fmt(tradeSummary.pnlUSD)}` },
                { label: '%',    val: `${isProfit ? '+' : ''}${fmt(tradeSummary.pnlPct)}%` },
                { label: 'Lots', val: fmt(tradeSummary.lotSize) },
                { label: 'Time', val: fmtDur(tradeSummary.durationMinutes) },
              ].map(({ label, val }) => (
                <div key={label} style={{ background: '#131820', borderRadius: 8, padding: '8px 10px', border: '1px solid #1a2035' }}>
                  <div style={{ fontSize: 9, color: '#4b5675', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)',
                    color: (label === 'P&L' || label === '%') ? (isProfit ? '#10b981' : '#ef4444') : '#c9d2e8' }}>{val}</div>
                </div>
              ))}
            </div>
            {replayData && (
              <div style={{ fontSize: 10, color: '#4b5675', textAlign: 'center', marginTop: 4 }}>
                {replayData.sourceLabel || (replayData.source === 'twelve' ? 'Twelve Data' : 'MT5')} · {replayData.normalizedSymbol} · {replayData.interval} · {replayData.candles.length} bars
              </div>
            )}
          </div>
          <button className="replay-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> : <CheckCircle2 size={16} />}
            {saving ? 'Saving…' : 'Mark Complete & Save'}
          </button>
        </div>
      </div>

      <div className="replay-bottombar">
        <button className="replay-ctrl-btn" disabled={!replayData || replayIdx === 0}
          onClick={() => jumpToReplayIndex(0)} title="Reset to start"><SkipBack size={14} /></button>
        <button className="replay-ctrl-btn" disabled={!replayData || replayIdx === 0}
          onClick={() => jumpToReplayIndex(replayIdx - 1)} title="Step back (Left arrow)" aria-keyshortcuts="ArrowLeft">‹</button>
        <button className={`replay-ctrl-btn play${playing ? ' is-playing' : ''}`} disabled={!replayData}
          onClick={() => { setPausedMarker(''); setPlaying(p => !p); }} title={`${playing ? 'Pause' : 'Play'} (Space)`} aria-keyshortcuts="Space">
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
        </button>
        <button className="replay-ctrl-btn"
          disabled={!replayData || replayIdx >= totalCandles - 1}
          onClick={() => jumpToReplayIndex(replayIdx + 1)} title="Step forward (Right arrow)" aria-keyshortcuts="ArrowRight">›</button>
        <button className="replay-ctrl-btn"
          disabled={!replayData || replayIdx >= totalCandles - 1}
          onClick={() => jumpToReplayIndex(totalCandles - 1)} title="Jump to end"><SkipForward size={14} /></button>
        <div className="replay-marker-controls" role="group" aria-label="Trade and review moments">
          <button className="replay-ctrl-btn marker-entry" disabled={!replayData} onClick={() => replayData && jumpToReplayIndex(replayData.entryIndex)} title="Jump to trade entry (E)" aria-keyshortcuts="E"><LogIn size={14} /> Entry</button>
          <button className="replay-ctrl-btn marker-exit" disabled={!replayData} onClick={() => replayData && jumpToReplayIndex(replayData.exitIndex)} title="Jump to trade exit (X)" aria-keyshortcuts="X"><LogOut size={14} /> Exit</button>
          <button className="replay-ctrl-btn" disabled={!previousTimelineMarker} onClick={() => previousTimelineMarker && jumpToReplayIndex(previousTimelineMarker.index)} title={previousTimelineMarker ? `Previous review moment: ${previousTimelineMarker.event.title} ([)` : 'No earlier review moment'} aria-keyshortcuts="["><Flag size={14} /> Previous note</button>
          <button className="replay-ctrl-btn" disabled={!nextTimelineMarker} onClick={() => nextTimelineMarker && jumpToReplayIndex(nextTimelineMarker.index)} title={nextTimelineMarker ? `Next review moment: ${nextTimelineMarker.event.title} (])` : 'No later review moment'} aria-keyshortcuts="]"><Flag size={14} /> Next note</button>
        </div>
        <button type="button" className={`replay-ctrl-btn${autoPauseMarkers ? ' active' : ''}`} aria-pressed={autoPauseMarkers} onClick={() => setAutoPauseMarkers(current => !current)} title="Automatically pause when playback reaches entry or exit"><PauseCircle size={14} /> Auto-pause</button>
        <button type="button" className={`replay-ctrl-btn${showShortcutHelp ? ' active' : ''}`} aria-pressed={showShortcutHelp} onClick={() => setShowShortcutHelp(current => !current)} title="Keyboard shortcuts (?)" aria-keyshortcuts="?"><Keyboard size={14} /> Shortcuts</button>
        <select className="replay-speed-select" aria-label="Replay speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option><option value={1}>1×</option>
          <option value={2}>2×</option><option value={5}>5×</option><option value={10}>10×</option>
        </select>
        <div className="replay-progress-wrap">
          <div className="replay-progress-track" title="Click to scrub" role="slider" tabIndex={replayData ? 0 : -1} aria-label="Replay position" aria-valuemin={1} aria-valuemax={totalCandles} aria-valuenow={replayIdx + 1}
            onClick={e => { if (!replayData) return; const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); jumpToReplayIndex(Math.floor(((e.clientX - r.left) / r.width) * (totalCandles - 1))); }}>
            <div className="replay-progress-fill" style={{ width: `${progressPct}%` }} />
            {replayData && <><span className="replay-progress-marker entry" style={{ left: `${entryProgressPct}%` }}><i>Entry</i></span><span className="replay-progress-marker exit" style={{ left: `${exitProgressPct}%` }}><i>Exit</i></span></>}
            {timelineProgressMarkers.map(marker => <span key={marker.event.eventId} className={`replay-progress-marker event ${marker.event.severity}`} style={{ left: `${marker.progress}%` }} title={marker.event.title} />)}
          </div>
          <div className="replay-progress-label">
            {replayData ? `Candle ${replayIdx + 1} of ${totalCandles} · ${replayData.interval}` : '—'}
            {replayData && replayIdx < replayData.entryIndex && <span className="before-entry"> · {replayData.entryIndex - replayIdx} candles to entry</span>}
            {replayData && replayIdx >= replayData.entryIndex && replayIdx < replayData.exitIndex && <span className="in-trade"> · In trade</span>}
            {replayData && replayIdx >= replayData.exitIndex && <span className="trade-closed"> · Trade closed</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
