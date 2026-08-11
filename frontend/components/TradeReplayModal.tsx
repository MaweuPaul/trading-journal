'use client';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  X, Play, Pause, SkipBack, SkipForward,
  Square, Minus, Type as TypeIcon, Loader2, AlertTriangle, ExternalLink,
  BookOpenText, Brain, Award, Tags, BarChart3, CheckCircle2, Undo2, Trash2, MapPin,
} from 'lucide-react';
import { createChart, createSeriesMarkers, CandlestickSeries, LineStyle, ColorType, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';

const API = '/api';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number; }
interface ReplayPlaybookRule { ruleId: string; label: string; inputType: string; options?: string[]; required?: boolean; helpText?: string; }
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
type ReplayAnnotation = (DrawnRect & { type: 'rect' }) | (DrawnLine & { type: 'line' }) | (DrawnText & { type: 'text' });
interface ReplayTimelineEvent {
  eventId: string; timeframe: string; candleTime: number; price: number;
  eventType: string; customType: string; title: string; note: string; emotion: string;
  severity: 'minor' | 'important' | 'critical'; playbookRuleId: string; playbookVersionId: string;
  screenshotIds: string[]; createdAt: string; updatedAt?: string;
}
interface ReplayEventDraft { eventType: string; customType: string; title: string; note: string; emotion: string; severity: 'minor' | 'important' | 'critical'; playbookRuleId: string; }
interface ReplayQuickReview { followedPlan: boolean | null; primaryEmotion: string; primaryMistake: string; primaryStrength: string; lesson: string; processGrade: string; completedAt: string | null; updatedAt?: string; }
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
const REPLAY_EVENT_TYPES = [
  ['observation', 'Observation'], ['confirmation', 'Confirmation'], ['entry', 'Entry decision'],
  ['management', 'Management'], ['exit', 'Exit decision'], ['emotion', 'Emotion'],
  ['mistake', 'Mistake'], ['violation', 'Rule violation'], ['lesson', 'Lesson'], ['custom', 'Custom'],
] as const;
const EMPTY_EVENT_DRAFT: ReplayEventDraft = { eventType: 'observation', customType: '', title: '', note: '', emotion: '', severity: 'important', playbookRuleId: '' };
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
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [replayIdx, setReplayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [drawingTool, setDrawingTool] = useState<'none' | 'rect' | 'line' | 'text' | 'event'>('none');
  const [rectColor, setRectColor] = useState(RECT_COLORS[0]);
  const [drawnRects, setDrawnRects] = useState<DrawnRect[]>([]);
  const [drawnLines, setDrawnLines] = useState<DrawnLine[]>([]);
  const [drawnTexts, setDrawnTexts] = useState<DrawnText[]>([]);
  const [annotationText, setAnnotationText] = useState('');
  const [annotationSaveState, setAnnotationSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [annotationSaveError, setAnnotationSaveError] = useState('');
  const [loadedAnnotationKey, setLoadedAnnotationKey] = useState('');
  const [showAnnotationList, setShowAnnotationList] = useState(false);
  const annotationBaselineRef = useRef('');
  const activeAnnotationKeyRef = useRef('');
  const annotationHistoryRef = useRef<Array<{ rects: DrawnRect[]; lines: DrawnLine[]; texts: DrawnText[] }>>([]);
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
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const currentPreview = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const redrawCanvasRef = useRef<() => void>(() => undefined);
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
    ...drawnTexts.map(annotation => ({ ...annotation, type: 'text' as const })),
  ], [drawnLines, drawnRects, drawnTexts]);
  const annotationKey = `${tradeId}:${selectedInterval}`;
  activeAnnotationKeyRef.current = annotationKey;
  const pushAnnotationHistory = () => {
    annotationHistoryRef.current = [...annotationHistoryRef.current.slice(-19), {
      rects: drawnRects.map(item => ({ ...item })), lines: drawnLines.map(item => ({ ...item })), texts: drawnTexts.map(item => ({ ...item })),
    }];
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
        setDrawnRects(annotations.filter(item => item.type === 'rect').map(({ type: _type, ...item }) => item as DrawnRect));
        setDrawnLines(annotations.filter(item => item.type === 'line').map(({ type: _type, ...item }) => item as DrawnLine));
        setDrawnTexts(annotations.filter(item => item.type === 'text').map(({ type: _type, ...item }) => item as DrawnText));
        annotationHistoryRef.current = [];
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

  const applyReplay = useCallback((data: ReplayData) => {
    if (!Array.isArray(data?.candles) || data.candles.length === 0) {
      throw new Error('The replay service returned no candle data. Restart the backend and MT5 sync agent, then try again.');
    }
    const replay = { ...data };
    replay.candles = data.candles.map(candle => ({ ...candle, time: Number(candle.time) as UTCTimestamp }));
    setReplayData(replay);
    setNotes(data.existingNotes || ''); setEmotion(data.existingEmotion || '');
    setGrade(data.existingGrade || ''); setTags(data.existingTags || []);
    setPlaybookResponses(data.playbookResponses || {});
    setAnalysisGrade(data.analysisGrade || ''); setExecutionGrade(data.executionGrade || '');
    setPlannedRR(data.plannedRR == null ? '' : String(data.plannedRR));
    setConfidenceRating(data.confidenceRating ?? null); setExitReason(data.exitReason || '');
    setManuallyIntervened(data.manuallyIntervened ?? null);
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
    timelineEvents.filter(event => event.timeframe === selectedInterval).forEach(event => {
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
    const event = timelineEvents.find(item => item.eventId === pendingTimelineNavigationRef.current && item.timeframe === selectedInterval);
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
        setReplayIdx(prev => { if (prev >= replayData.candles.length - 1) { setPlaying(false); return prev; } return prev + 1; });
      }, ms);
    } else { if (intervalRef.current) clearInterval(intervalRef.current); }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, speed, replayData]);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const r of drawnRects) {
      const x1 = chart.timeScale().timeToCoordinate(r.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(r.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(r.price1); const y2 = series.priceToCoordinate(r.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = r.color; ctx.fillStyle = r.color + '22'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
      ctx.fill(); ctx.stroke(); ctx.restore();
    }
    for (const line of drawnLines) {
      const x1 = chart.timeScale().timeToCoordinate(line.time1 as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(line.time2 as UTCTimestamp);
      const y1 = series.priceToCoordinate(line.price1); const y2 = series.priceToCoordinate(line.price2);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      ctx.save(); ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
    }
    for (const note of drawnTexts) {
      const x = chart.timeScale().timeToCoordinate(note.time as UTCTimestamp);
      const y = series.priceToCoordinate(note.price);
      if (x == null || y == null) continue;
      ctx.save(); ctx.font = '600 12px sans-serif';
      const width = ctx.measureText(note.text).width;
      ctx.fillStyle = '#0a0d14dd'; ctx.fillRect(x - 5, y - 17, width + 10, 23);
      ctx.strokeStyle = note.color; ctx.strokeRect(x - 5, y - 17, width + 10, 23);
      ctx.fillStyle = note.color; ctx.fillText(note.text, x, y); ctx.restore();
    }
    if (currentPreview.current) {
      const { x1, y1, x2, y2 } = currentPreview.current;
      ctx.save(); ctx.strokeStyle = rectColor; ctx.fillStyle = rectColor + '18'; ctx.lineWidth = 1.5; ctx.setLineDash([4,4]);
      ctx.beginPath();
      if (drawingTool === 'line') { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
      else { ctx.rect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1)); ctx.fill(); ctx.stroke(); }
      ctx.restore();
    }
  }, [drawingTool, drawnLines, drawnRects, drawnTexts, rectColor]);

  useEffect(() => { redrawCanvasRef.current = redrawCanvas; redrawCanvas(); }, [redrawCanvas, replayIdx]);

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawingTool === 'none') return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    if (drawingTool === 'event') {
      const chart = chartRef.current, series = seriesRef.current;
      if (!chart || !series) return;
      const time = chart.timeScale().coordinateToTime(e.clientX - r.left);
      const price = series.coordinateToPrice(e.clientY - r.top);
      if (time != null && price != null) {
        setEditingEventId(''); setEventDraft(EMPTY_EVENT_DRAFT); setEventLocation({ time: Number(time), price });
      }
      return;
    }
    if (drawingTool === 'text') {
      const chart = chartRef.current, series = seriesRef.current;
      const text = annotationText.trim();
      if (!chart || !series || !text) return;
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const time = chart.timeScale().coordinateToTime(x); const price = series.coordinateToPrice(y);
      if (time != null && price != null) {
        pushAnnotationHistory();
        setDrawnTexts(current => [...current, { id: `text-${Date.now()}`, time: time as number, price, text: text.slice(0, 80), color: rectColor }]);
        setAnnotationText('');
        queueMicrotask(() => annotationInputRef.current?.focus());
      }
      return;
    }
    drawStart.current = { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!['rect', 'line'].includes(drawingTool) || !drawStart.current) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    currentPreview.current = { x1: drawStart.current.x, y1: drawStart.current.y, x2: e.clientX - r.left, y2: e.clientY - r.top };
    redrawCanvas();
  };
  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!['rect', 'line'].includes(drawingTool) || !drawStart.current) return;
    const canvas = canvasRef.current, chart = chartRef.current, series = seriesRef.current;
    if (!canvas || !chart || !series) return;
    const r = canvas.getBoundingClientRect(); const x2 = e.clientX - r.left; const y2 = e.clientY - r.top;
    if (Math.abs(x2 - drawStart.current.x) > 4 && Math.abs(y2 - drawStart.current.y) > 4) {
      const t1 = chart.timeScale().coordinateToTime(drawStart.current.x);
      const t2 = chart.timeScale().coordinateToTime(x2);
      const p1 = series.coordinateToPrice(drawStart.current.y);
      const p2 = series.coordinateToPrice(y2);
      if (t1 != null && t2 != null && p1 != null && p2 != null) {
        pushAnnotationHistory();
        const shape = { id: `${drawingTool}-${Date.now()}`, time1: t1 as number, time2: t2 as number, price1: p1, price2: p2, color: rectColor };
        if (drawingTool === 'line') setDrawnLines(prev => [...prev, shape]);
        else setDrawnRects(prev => [...prev, shape]);
      }
    }
    drawStart.current = null; currentPreview.current = null; redrawCanvas();
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
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
  }, [onClose]);

  const totalCandles = replayData?.candles.length ?? 1;
  const progressPct = ((replayIdx + 1) / totalCandles) * 100;
  const isProfit = tradeSummary.pnlUSD >= 0;
  const playbook = replayData?.playbookSnapshot;
  const activePhase = JOURNAL_PHASES.find(phase => phase.id === journalPhase) || JOURNAL_PHASES[0];
  const phaseBlocks = playbook?.blocks.filter(block => activePhase.categories.includes(block.category as never)) || [];
  const allPlaybookRules = playbook?.blocks.flatMap(block => block.rules) || [];
  const visibleTimelineEvents = timelineEvents.filter(event => event.timeframe === selectedInterval).sort((a, b) => a.candleTime - b.candleTime);
  const answeredRules = allPlaybookRules.filter(rule => {
    const value = playbookResponses[rule.ruleId];
    return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
  }).length;
  const setRuleAnswer = (ruleId: string, value: unknown) => setPlaybookResponses(current => ({ ...current, [ruleId]: value }));
  const switchTimeframe = (interval: string) => {
    if (interval === selectedInterval) return;
    setPlaying(false); setReplayData(null); setLoading(true); setError(''); setReplayDebug(null); setWaitingForMt5(false);
    setDrawnRects([]); setDrawnLines([]); setDrawnTexts([]); currentPreview.current = null;
    setSelectedInterval(interval);
    onIntervalChange?.(interval);
  };
  const undoAnnotation = () => {
    const previous = annotationHistoryRef.current.pop();
    if (!previous) return;
    setDrawnRects(previous.rects); setDrawnLines(previous.lines); setDrawnTexts(previous.texts);
  };
  const deleteAnnotation = (annotation: ReplayAnnotation) => {
    pushAnnotationHistory();
    if (annotation.type === 'rect') setDrawnRects(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'line') setDrawnLines(current => current.filter(item => item.id !== annotation.id));
    if (annotation.type === 'text') setDrawnTexts(current => current.filter(item => item.id !== annotation.id));
  };
  const clearAnnotations = () => {
    if (allAnnotations.length === 0 || !window.confirm(`Clear all ${allAnnotations.length} annotations from ${selectedInterval}?`)) return;
    pushAnnotationHistory(); setDrawnRects([]); setDrawnLines([]); setDrawnTexts([]); currentPreview.current = null; redrawCanvas();
  };
  const saveTimelineEvent = () => {
    if (!eventLocation || !eventDraft.title.trim()) return;
    const existing = timelineEvents.find(event => event.eventId === editingEventId);
    const event: ReplayTimelineEvent = {
      eventId: existing?.eventId || `event-${Date.now()}`,
      timeframe: existing?.timeframe || selectedInterval,
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
    setEventDraft({ eventType: event.eventType, customType: event.customType || '', title: event.title, note: event.note || '', emotion: event.emotion || '', severity: event.severity, playbookRuleId: event.playbookRuleId || '' });
  };
  const deleteTimelineEvent = (eventId: string) => setTimelineEvents(current => current.filter(event => event.eventId !== eventId));
  const navigateToTimelineEvent = (event: ReplayTimelineEvent) => {
    if (!replayData || event.timeframe !== selectedInterval) {
      if (event.timeframe !== selectedInterval) { pendingTimelineNavigationRef.current = event.eventId; switchTimeframe(event.timeframe); }
      return;
    }
    const index = replayData.candles.findIndex(candle => Number(candle.time) >= event.candleTime);
    if (index < 0) return;
    setPlaying(false); setReplayIdx(Math.max(replayIdx, index));
    queueMicrotask(() => chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, index - 30), to: Math.min(replayData.candles.length - 1, index + 10) }));
  };
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
        <span className="replay-topbar-symbol">
          {tradeSummary.symbol}
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
            background: tradeSummary.direction === 'BUY' ? '#10b98120' : '#ef444420',
            color: tradeSummary.direction === 'BUY' ? '#10b981' : '#ef4444',
            border: `1px solid ${tradeSummary.direction === 'BUY' ? '#10b98140' : '#ef444440'}`,
          }}>{tradeSummary.direction}</span>
        </span>
        <span className={`replay-topbar-pnl ${isProfit ? 'positive' : 'negative'}`}>
          {isProfit ? '+' : ''}{tradeSummary.pnlUSD.toFixed(2)} USD ({isProfit ? '+' : ''}{tradeSummary.pnlPct.toFixed(2)}%)
        </span>
        <span className="replay-topbar-meta">
          {tradeSummary.entryPrice.toFixed(5)} → {tradeSummary.exitPrice.toFixed(5)} · {fmtDur(tradeSummary.durationMinutes)} · {tradeSummary.lotSize.toFixed(2)} lots
        </span>
        <span className="replay-topbar-spacer" />
        <div className="replay-timeframes" role="group" aria-label="Chart timeframe">
          {REPLAY_TIMEFRAMES.map(timeframe => (
            <button type="button" key={timeframe.value} aria-pressed={selectedInterval === timeframe.value} className={selectedInterval === timeframe.value ? 'active' : ''} onClick={() => switchTimeframe(timeframe.value)}>{timeframe.label}</button>
          ))}
        </div>
        <button className={`replay-tool-btn${drawingTool === 'rect' ? ' active' : ''}`}
          onClick={() => setDrawingTool(t => t === 'rect' ? 'none' : 'rect')} title="Draw rectangle zones">
          <Square size={13} /> Zone
        </button>
        <button className={`replay-tool-btn${drawingTool === 'line' ? ' active' : ''}`}
          onClick={() => setDrawingTool(t => t === 'line' ? 'none' : 'line')} title="Draw a trend line">
          <Minus size={13} /> Line
        </button>
        <button className={`replay-tool-btn${drawingTool === 'text' ? ' active' : ''}`}
          onClick={() => setDrawingTool(t => t === 'text' ? 'none' : 'text')} title="Place text on the chart">
          <TypeIcon size={13} /> Text
        </button>
        <button className={`replay-tool-btn${drawingTool === 'event' ? ' active' : ''}`}
          onClick={() => { setDrawingTool(tool => tool === 'event' ? 'none' : 'event'); setEventLocation(null); setEditingEventId(''); }} title="Attach a journal event to a candle">
          <MapPin size={13} /> Event
        </button>
        {['rect', 'line', 'text'].includes(drawingTool) && (
          <div style={{ display: 'flex', gap: 4 }}>
            {RECT_COLORS.map(c => (
              <button key={c} onClick={() => setRectColor(c)}
                style={{ width: 18, height: 18, borderRadius: 4, background: c, cursor: 'pointer', flexShrink: 0,
                  border: `2px solid ${c === rectColor ? '#fff' : 'transparent'}` }} />
            ))}
          </div>
        )}
        <span className={`replay-annotation-status ${annotationSaveState}`} title={annotationSaveError || 'Chart annotations save automatically'}>
          {annotationSaveState === 'loading' ? 'Loading notes…' : annotationSaveState === 'saving' ? 'Saving notes…' : annotationSaveState === 'error' ? 'Notes not saved' : 'Notes saved'}
        </span>
        <button className="replay-tool-btn" disabled={annotationHistoryRef.current.length === 0} onClick={undoAnnotation} title="Undo the last annotation change"><Undo2 size={13} /> Undo</button>
        {(drawnRects.length + drawnLines.length + drawnTexts.length) > 0 && (
          <button className={`replay-tool-btn${showAnnotationList ? ' active' : ''}`} title="Manage saved annotations" onClick={() => setShowAnnotationList(current => !current)}>
            Notes ({allAnnotations.length})
          </button>
        )}
        <button ref={closeButtonRef} className="replay-close-btn" onClick={onClose} title="Close (ESC)"><X size={14} /> Close</button>
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
          {eventLocation && (
            <div className="replay-event-editor" role="dialog" aria-label={editingEventId ? 'Edit timeline event' : 'Add timeline event'}>
              <div className="replay-event-editor-head"><strong>{editingEventId ? 'Edit chart event' : 'What happened here?'}</strong><button type="button" onClick={() => { setEventLocation(null); setEditingEventId(''); }}>×</button></div>
              <div className="replay-event-editor-grid">
                <label>Event type<select value={eventDraft.eventType} onChange={event => setEventDraft(current => ({ ...current, eventType: event.target.value }))}>{REPLAY_EVENT_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label>Importance<select value={eventDraft.severity} onChange={event => setEventDraft(current => ({ ...current, severity: event.target.value as ReplayEventDraft['severity'] }))}><option value="minor">Minor</option><option value="important">Important</option><option value="critical">Critical</option></select></label>
              </div>
              {eventDraft.eventType === 'custom' && <label>Custom type<input maxLength={60} value={eventDraft.customType} onChange={event => setEventDraft(current => ({ ...current, customType: event.target.value }))} placeholder="e.g. News reaction" /></label>}
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
                <div className="replay-annotation-row" key={annotation.id}>
                  <i style={{ background: annotation.color }} />
                  <span><b>{annotation.type === 'rect' ? 'Zone' : annotation.type === 'line' ? 'Line' : 'Text'}</b>{annotation.type === 'text' ? ` — ${annotation.text}` : ` ${index + 1}`}</span>
                  <button type="button" onClick={() => deleteAnnotation(annotation)} aria-label={`Delete ${annotation.type} annotation`}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
          <canvas ref={canvasRef}
            className={`replay-canvas-overlay${drawingTool !== 'none' ? ' drawing-active' : ''}`}
            onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp}
            onMouseLeave={() => { if (drawStart.current) { drawStart.current = null; currentPreview.current = null; redrawCanvas(); } }} />
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
          <section className="replay-timeline">
            <div className="replay-timeline-head">
              <div><span>Trade timeline</span><strong>{visibleTimelineEvents.length} on {selectedInterval} · {timelineEvents.length} total</strong></div>
              <small className={eventSaveState} title={eventSaveError}>{eventSaveState === 'saving' ? 'Saving…' : eventSaveState === 'error' ? 'Not saved' : 'Saved'}</small>
            </div>
            {visibleTimelineEvents.length === 0 ? (
              <button type="button" className="replay-timeline-empty" onClick={() => setDrawingTool('event')}><MapPin size={14} /> Select Event, then click a candle to tell the trade story.</button>
            ) : visibleTimelineEvents.map(event => (
              <article className="replay-timeline-event" key={event.eventId} onClick={() => navigateToTimelineEvent(event)}>
                <i className={event.severity} />
                <div><span>{new Date(event.candleTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {REPLAY_EVENT_TYPES.find(([value]) => value === event.eventType)?.[1] || event.customType}</span><strong>{event.title}</strong>{event.note && <p>{event.note}</p>}</div>
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
              <div className="replay-quick-question"><label>1. Did you follow the plan?</label><div className="replay-quick-options"><button type="button" className={quickReview.followedPlan === true ? 'selected good' : ''} onClick={() => setQuickReview(current => ({ ...current, followedPlan: true, primaryMistake: '', completedAt: null }))}>Yes</button><button type="button" className={quickReview.followedPlan === false ? 'selected bad' : ''} onClick={() => setQuickReview(current => ({ ...current, followedPlan: false, primaryStrength: '', completedAt: null }))}>No</button></div></div>
              <div className="replay-quick-question"><label>2. What was the main emotion?</label><div className="replay-quick-emotions">{EMOTIONS.map(item => <button type="button" key={item.name} title={item.name} className={quickReview.primaryEmotion === item.name ? 'selected' : ''} onClick={() => { const value = quickReview.primaryEmotion === item.name ? '' : item.name; setQuickReview(current => ({ ...current, primaryEmotion: value, completedAt: null })); setEmotion(value); }}>{item.emoji}<span>{item.name}</span></button>)}</div></div>
              {quickReview.followedPlan === false && <div className="replay-quick-question"><label>3. What was the main mistake?</label><input value={quickReview.primaryMistake} maxLength={100} onChange={event => setQuickReview(current => ({ ...current, primaryMistake: event.target.value, completedAt: null }))} placeholder="e.g. Entered before confirmation" /></div>}
              {quickReview.followedPlan === true && <div className="replay-quick-question"><label>3. What should you repeat?</label><input value={quickReview.primaryStrength} maxLength={100} onChange={event => setQuickReview(current => ({ ...current, primaryStrength: event.target.value, completedAt: null }))} placeholder="e.g. Waited for the sweep and confirmation" /></div>}
              {quickReview.followedPlan === null && <div className="replay-quick-hint">Choose Yes or No to reveal the next question.</div>}
              <div className="replay-quick-question"><label>4. What is the main lesson?</label><textarea value={quickReview.lesson} maxLength={500} onChange={event => setQuickReview(current => ({ ...current, lesson: event.target.value, completedAt: null }))} placeholder="One clear action for the next trade" /></div>
              <div className="replay-quick-question"><label>5. Process grade</label><div className="replay-quick-grades">{GRADES.map(item => <button type="button" key={item} className={quickReview.processGrade === item ? 'selected' : ''} onClick={() => { const value = quickReview.processGrade === item ? '' : item; setQuickReview(current => ({ ...current, processGrade: value, completedAt: null })); setGrade(value); }}>{item}</button>)}</div></div>
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
                        {rule.helpText && <p>{rule.helpText}</p>}
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
          onClick={() => { setPlaying(false); setReplayIdx(0); }} title="Reset to start"><SkipBack size={14} /></button>
        <button className="replay-ctrl-btn" disabled={!replayData || replayIdx === 0}
          onClick={() => setReplayIdx(p => Math.max(0, p - 1))} title="Step back">‹</button>
        <button className={`replay-ctrl-btn play${playing ? ' is-playing' : ''}`} disabled={!replayData}
          onClick={() => setPlaying(p => !p)} title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
        </button>
        <button className="replay-ctrl-btn"
          disabled={!replayData || replayIdx >= totalCandles - 1}
          onClick={() => setReplayIdx(p => Math.min(totalCandles - 1, p + 1))} title="Step forward">›</button>
        <button className="replay-ctrl-btn"
          disabled={!replayData || replayIdx >= totalCandles - 1}
          onClick={() => { setPlaying(false); setReplayIdx(totalCandles - 1); }} title="Jump to end"><SkipForward size={14} /></button>
        <select className="replay-speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option><option value={1}>1×</option>
          <option value={2}>2×</option><option value={5}>5×</option><option value={10}>10×</option>
        </select>
        <div className="replay-progress-wrap">
          <div className="replay-progress-track" title="Click to scrub"
            onClick={e => { if (!replayData) return; const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); setReplayIdx(Math.floor(((e.clientX - r.left) / r.width) * (totalCandles - 1))); }}>
            <div className="replay-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="replay-progress-label">
            {replayData ? `Candle ${replayIdx + 1} of ${totalCandles} · ${replayData.interval}` : '—'}
            {replayData && replayIdx >= replayData.entryIndex && replayIdx < replayData.exitIndex && <span style={{ color: '#10b981', marginLeft: 8 }}>● In trade</span>}
            {replayData && replayIdx >= replayData.exitIndex && <span style={{ color: replayData.pnlUSD >= 0 ? '#10b981' : '#ef4444', marginLeft: 8 }}>● Trade closed</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
