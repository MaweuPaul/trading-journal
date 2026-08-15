'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  Brain, TrendingDown, TrendingUp, AlertTriangle, CheckCircle,
  BarChart2, RefreshCw, ArrowRight, Zap, Target, Shield,
  Activity, ChevronDown, ChevronUp, Circle, FileClock,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie, Legend,
} from 'recharts';
import InfoHint from '@/components/InfoHint';

const API = '/api';
const GRADE_COLOR: Record<string, string> = {
  A: '#10b981', B: '#3b82f6', C: '#f59e0b', D: '#f97316', F: '#ef4444', '': '#6b7280',
};
const EXIT_COLORS: Record<string, string> = {
  TP: '#10b981', SL: '#3b82f6', Fear: '#ef4444', Revenge: '#dc2626',
  News: '#8b5cf6', ManualClose: '#f59e0b', FOMO: '#f97316',
  PartialClose: '#06b6d4', Other: '#6b7280', 'Not Set': '#374151',
};

const RANGES = [
  { label: 'All Time', value: 'all' },
  { label: '7 Days',   value: '7d' },
  { label: '30 Days',  value: '30d' },
  { label: '3 Months', value: '3m' },
];

interface CoachData {
  totalTrades: number;
  earlyExits: {
    count: number;
    withRiskData?: number;
    totalMissedRR: number;
    estimatedMissedUSD: number;
    trades: { _id: string; symbol: string; direction: string; pnlUSD: number; plannedRR: number; exitReason: string; missedRR: number | null; estimatedMissedUSD: number | null; hasRiskData?: boolean; closeTime: string }[];
  };
  gradeGap: {
    avgAnalysisGrade: string | null;
    avgExecutionGrade: string | null;
    avgAnalysisScore: number | null;
    avgExecutionScore: number | null;
    gapScore: number | null;
    analysisCount: number;
    executionCount: number;
  };
  exitReasonBreakdown: { reason: string; count: number; wins: number; winRate: number }[];
  confidenceVsWinRate: { confidence: number; count: number; wins: number; winRate: number }[];
  planAdherence: { score: number | null; tradesAssessed: number; totalRules: number; compliedRules: number };
  manualIntervention: { interventionCount: number; cleanCount: number; untaggedCount: number; interventionWinRate: number; cleanWinRate: number; interventionAvgPnL: number; cleanAvgPnL: number; interventionAvgRR: number | null; cleanAvgRR: number | null };
  demoVsLive: {
    live: { tradeCount: number; winRate: number; avgPnL: number; profitFactor: number; planAdherence: number | null } | null;
    demo: { tradeCount: number; winRate: number; avgPnL: number; profitFactor: number; planAdherence: number | null } | null;
  };
  setupAnalytics: { setup: string; tradeCount: number; winRate: number; totalPnL: number; avgPnL: number; avgPlannedRR: number | null }[];
  playbookAnalytics: { playbookId: string; playbookName: string; versionId: string; versionNumber: number; tradeCount: number; wins: number; totalPnL: number; winRate: number; avgPnL: number }[];
  ruleEffectiveness: { ruleId: string; ruleLabel: string; blockName: string; inputType: string; answer: string; tradeCount: number; wins: number; totalPnL: number; winRate: number; avgPnL: number; sampleStatus: 'strong' | 'developing' | 'insufficient' }[];
  stageCompliance: { playbookName: string; versionNumber: number; category: string; stageName: string; requiredFieldCount: number; tradeCount: number; completeCount: number; incompleteCount: number; complianceRate: number; completeWinRate: number | null; incompleteWinRate: number | null; completeAvgPnL: number | null; incompleteAvgPnL: number | null }[];
  numericFieldAnalytics: { playbookName: string; versionNumber: number; ruleId: string; ruleLabel: string; blockName: string; inputType: string; unit: string; tradeCount: number; averageValue: number; averageWinningValue: number | null; averageLosingValue: number | null; avgPnL: number; sampleStatus: 'strong' | 'developing' | 'insufficient' }[];
}

function GradeBadge({ grade }: { grade: string | null }) {
  if (!grade) return <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>—</span>;
  return (
    <span style={{
      fontSize: 20, fontWeight: 800, color: GRADE_COLOR[grade] || 'var(--text-primary)',
      fontFamily: 'var(--font-mono)',
    }}>{grade}</span>
  );
}

function ScoreRing({ score, size = 72 }: { score: number | null; size?: number }) {
  if (score == null) return <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>N/A</div>;
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={6} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: size === 72 ? 16 : 13, fontWeight: 700, color,
        fontFamily: 'var(--font-mono)',
      }}>{score}%</div>
    </div>
  );
}

function SectionCard({ title, icon, children, accent, help }: { title: string; icon: React.ReactNode; children: React.ReactNode; accent?: string; help?: string }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: `1px solid ${accent ? accent + '33' : 'var(--border)'}`,
      borderRadius: 16, padding: '22px 24px', boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 18 }}>
        <span style={{ color: accent || 'var(--accent)' }}>{icon}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center' }}>{title}{help && <InfoHint text={help} label={`About ${title}`} />}</span>
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, a, b, aColor, bColor, unit = '' }: { label: string; a: any; b: any; aColor?: string; bColor?: string; unit?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', gap: 24 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: aColor || 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{a}{unit}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: bColor || 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{b}{unit}</span>
      </div>
    </div>
  );
}

export default function CoachPage() {
  const [data, setData] = useState<CoachData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [range, setRange] = useState('all');
  const [showEarlyExits, setShowEarlyExits] = useState(false);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const fetchData = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API}/coach?range=${range}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load coach data');
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [range, token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const noData = !data || data.totalTrades === 0;

  return (
    <main className="page-content">
      <div style={{ width: '100%', padding: '0 0 32px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 13,
              background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(139,92,246,0.35)',
            }}>
              <Brain size={24} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Edge Coach</h1>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                What is preventing you from trading your edge consistently?
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              {RANGES.map(r => (
                <button key={r.value} onClick={() => setRange(r.value)} style={{
                  padding: '7px 13px', border: 'none', fontSize: 12, fontWeight: 600,
                  background: range === r.value ? 'var(--accent)' : 'transparent',
                  color: range === r.value ? '#fff' : 'var(--text-muted)',
                  cursor: 'pointer', fontFamily: 'var(--font-sans)',
                }}>{r.label}</button>
              ))}
            </div>
            <button onClick={fetchData} disabled={loading} style={{
              padding: '7px 12px', border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg-elevated)', color: 'var(--text-muted)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
              fontFamily: 'var(--font-sans)',
            }}>
              <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, color: 'var(--red)', fontSize: 13 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} style={{ height: 180, borderRadius: 16, background: 'var(--bg-surface)', animation: 'pulse 1.5s ease infinite' }} />
            ))}
          </div>
        ) : noData ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
            <Brain size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
            <p style={{ fontSize: 14 }}>No trades yet. Start tagging your trades with execution data to unlock insights.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* ROW 1: Key Stats Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
              {[
                {
                  label: 'Early Exits', value: data!.earlyExits.count,
                  sub: `~$${data!.earlyExits.estimatedMissedUSD.toFixed(2)} missed`,
                  color: data!.earlyExits.count > 0 ? '#ef4444' : '#10b981',
                  icon: <TrendingDown size={16} />,
                },
                {
                  label: 'Plan Adherence', value: data!.planAdherence.score != null ? `${data!.planAdherence.score}%` : 'No data',
                  sub: `${data!.planAdherence.tradesAssessed} trades assessed`,
                  color: data!.planAdherence.score != null ? (data!.planAdherence.score >= 75 ? '#10b981' : data!.planAdherence.score >= 50 ? '#f59e0b' : '#ef4444') : 'var(--text-muted)',
                  icon: <CheckCircle size={16} />,
                },
                {
                  label: 'Grade Gap', value: data!.gradeGap.gapScore != null ? `${data!.gradeGap.gapScore > 0 ? '+' : ''}${data!.gradeGap.gapScore}` : 'No data',
                  sub: data!.gradeGap.avgAnalysisGrade && data!.gradeGap.avgExecutionGrade
                    ? `Analysis ${data!.gradeGap.avgAnalysisGrade} → Execution ${data!.gradeGap.avgExecutionGrade}`
                    : 'Grade your trades to see gap',
                  color: data!.gradeGap.gapScore != null ? (data!.gradeGap.gapScore > 1 ? '#ef4444' : '#10b981') : 'var(--text-muted)',
                  icon: <BarChart2 size={16} />,
                },
                {
                  label: 'Untouched Avg P&L', value: data!.manualIntervention.cleanCount > 0 ? `$${data!.manualIntervention.cleanAvgPnL.toFixed(2)}` : 'No data',
                  sub: `vs $${data!.manualIntervention.interventionAvgPnL.toFixed(2)} when intervened`,
                  color: data!.manualIntervention.cleanAvgPnL > data!.manualIntervention.interventionAvgPnL ? '#10b981' : '#f59e0b',
                  icon: <Shield size={16} />,
                },
              ].map(card => (
                <div key={card.label} style={{
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  borderRadius: 14, padding: '18px 20px', boxShadow: 'var(--shadow-card)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
                    <span style={{ color: card.color }}>{card.icon}</span>
                    {card.label}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: card.color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                    {card.value}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* ROW 2: Missed Profit + Exit Reasons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

              {/* Early Exit / Missed Profit */}
              <SectionCard title="💸 Missed Profit from Early Exits" icon={<TrendingDown size={15} />} accent="#ef4444">
                {data!.earlyExits.count === 0 ? (
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
                    No early exits recorded yet. Set <strong>Planned R:R</strong> and <strong>Exit Reason</strong> on trades to track this.
                  </p>
                ) : (data!.earlyExits.withRiskData ?? 0) === 0 ? (
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
                    {data!.earlyExits.count} early {data!.earlyExits.count === 1 ? 'exit' : 'exits'} found, but none have a stop-loss
                    on record yet. Missed-profit needs the actual risk MT5 had on the order — re-run the sync agent to backfill it.
                  </p>
                ) : (
                  <>
                    {(data!.earlyExits.withRiskData ?? 0) < data!.earlyExits.count && (
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                        Based on {data!.earlyExits.withRiskData} of {data!.earlyExits.count} early exits with a recorded stop-loss.
                      </p>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                      <div style={{ background: 'var(--bg-elevated)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Missed R total</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#ef4444', fontFamily: 'var(--font-mono)' }}>
                          {data!.earlyExits.totalMissedRR.toFixed(1)}R
                        </div>
                      </div>
                      <div style={{ background: 'var(--bg-elevated)', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Est. missed $</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#ef4444', fontFamily: 'var(--font-mono)' }}>
                          ${data!.earlyExits.estimatedMissedUSD.toFixed(2)}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => setShowEarlyExits(v => !v)} style={{
                      width: '100%', padding: '8px', background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
                      fontSize: 12, color: 'var(--text-secondary)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', gap: 5,
                      fontFamily: 'var(--font-sans)',
                    }}>
                      {showEarlyExits ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      {showEarlyExits ? 'Hide' : 'Show'} {data!.earlyExits.count} early exits
                    </button>
                    {showEarlyExits && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                        {data!.earlyExits.trades.map(t => (
                          <div key={t._id} style={{
                            background: 'var(--bg-elevated)', borderRadius: 8, padding: '8px 12px',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            border: '1px solid var(--border)',
                          }}>
                            <div>
                              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{t.symbol}</span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>{t.exitReason}</span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: 11.5, color: t.hasRiskData ? '#ef4444' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                                {t.hasRiskData && t.missedRR != null && t.estimatedMissedUSD != null
                                  ? `−${t.missedRR.toFixed(1)}R / ~$${t.estimatedMissedUSD.toFixed(2)}`
                                  : 'No stop-loss on record'}
                              </div>
                              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                                Planned {t.plannedRR}R · Got ${t.pnlUSD.toFixed(2)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </SectionCard>

              {/* Exit Reason Breakdown */}
              <SectionCard title="Exit Reason Breakdown" icon={<Activity size={15} />}>
                {data!.exitReasonBreakdown.filter(r => r.reason !== 'Not Set').length === 0 ? (
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
                    Tag your trades with exit reasons to see breakdown.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {data!.exitReasonBreakdown.filter(r => r.reason !== 'Not Set').map(r => (
                      <div key={r.reason} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div style={{ width: 70, fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>{r.reason}</div>
                        <div style={{ flex: 1, height: 8, background: 'var(--bg-elevated)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', borderRadius: 4,
                            width: `${(r.count / Math.max(...data!.exitReasonBreakdown.map(x => x.count))) * 100}%`,
                            background: EXIT_COLORS[r.reason] || '#6b7280',
                          }} />
                        </div>
                        <div style={{ display: 'flex', gap: 8, width: 80, justifyContent: 'flex-end' }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.count}×</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: r.winRate >= 50 ? '#10b981' : '#ef4444' }}>
                            {r.winRate}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>

            {/* ROW 3: Grade Gap + Plan Adherence */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

              {/* Grade Gap */}
              <SectionCard title="Analysis vs Execution Grade Gap" icon={<Zap size={15} />} accent="#8b5cf6">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', padding: '10px 0' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Analysis</div>
                    <GradeBadge grade={data!.gradeGap.avgAnalysisGrade} />
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{data!.gradeGap.analysisCount} graded</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <ArrowRight size={20} color="var(--text-muted)" />
                    {data!.gradeGap.gapScore != null && (
                      <div style={{
                        fontSize: 11, fontWeight: 700, marginTop: 4,
                        color: data!.gradeGap.gapScore > 0.5 ? '#ef4444' : '#10b981',
                      }}>
                        {data!.gradeGap.gapScore > 0 ? `−${data!.gradeGap.gapScore}` : 'Even'}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Execution</div>
                    <GradeBadge grade={data!.gradeGap.avgExecutionGrade} />
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{data!.gradeGap.executionCount} graded</div>
                  </div>
                </div>
                {data!.gradeGap.gapScore != null && data!.gradeGap.gapScore > 0.5 && (
                  <div style={{
                    marginTop: 12, padding: '10px 12px', background: '#ef444415',
                    borderRadius: 8, border: '1px solid #ef444430', fontSize: 12,
                    color: '#ef4444', lineHeight: 1.5,
                  }}>
                    ⚠️ Your analysis is better than your execution. This is a psychology gap, not a strategy problem.
                  </div>
                )}
                {(!data!.gradeGap.analysisCount && !data!.gradeGap.executionCount) && (
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>
                    Grade your trades separately (Analysis + Execution) to see the gap.
                  </p>
                )}
              </SectionCard>

              {/* Plan Adherence */}
              <SectionCard title="Plan Adherence Score" icon={<CheckCircle size={15} />} accent="#10b981" help="The percentage of saved execution checklist items marked as followed. It measures discipline, not whether the strategy itself is profitable.">
                <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                  <ScoreRing score={data!.planAdherence.score} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                      Based on execution checklist across <strong>{data!.planAdherence.tradesAssessed}</strong> trades
                    </div>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Rules Followed</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#10b981', fontFamily: 'var(--font-mono)' }}>
                          {data!.planAdherence.compliedRules}/{data!.planAdherence.totalRules}
                        </div>
                      </div>
                    </div>
                    {data!.planAdherence.score == null && (
                      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                        Fill out the execution checklist on trades to track plan adherence.
                      </p>
                    )}
                  </div>
                </div>
              </SectionCard>
            </div>

            {/* ROW 4: Manual Intervention */}
            <SectionCard title="Manual Intervention — Do You Help or Hurt Your Trades?" icon={<Target size={15} />} accent="#f59e0b">
              {data!.manualIntervention.interventionCount === 0 && data!.manualIntervention.cleanCount === 0 ? (
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>
                  Tag trades as "Manually Intervened" (Yes/No) to see whether your interventions help or hurt.
                </p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  {[
                    {
                      label: '🤚 Intervened', count: data!.manualIntervention.interventionCount,
                      winRate: data!.manualIntervention.interventionWinRate,
                      avgPnL: data!.manualIntervention.interventionAvgPnL,
                      avgRR: data!.manualIntervention.interventionAvgRR,
                      color: '#ef4444',
                      desc: 'Modified SL/TP or closed manually'
                    },
                    {
                      label: '✋ Untouched', count: data!.manualIntervention.cleanCount,
                      winRate: data!.manualIntervention.cleanWinRate,
                      avgPnL: data!.manualIntervention.cleanAvgPnL,
                      avgRR: data!.manualIntervention.cleanAvgRR,
                      color: '#10b981',
                      desc: 'Trade ran to SL or TP without interference'
                    },
                  ].map(col => (
                    <div key={col.label} style={{
                      background: 'var(--bg-elevated)', borderRadius: 12, padding: '16px',
                      border: `1px solid ${col.color}33`,
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: col.color, marginBottom: 4 }}>{col.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>{col.desc}</div>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Win Rate</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: col.color, fontFamily: 'var(--font-mono)' }}>
                            {col.count > 0 ? `${col.winRate}%` : '—'}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Avg P&L</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: col.avgPnL >= 0 ? '#10b981' : '#ef4444', fontFamily: 'var(--font-mono)' }}>
                            {col.count > 0 ? `$${col.avgPnL.toFixed(2)}` : '—'}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Avg R</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                            {col.avgRR != null ? `${col.avgRR}R` : '—'}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Trades</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{col.count}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* ROW 5: Demo vs Live */}
            <SectionCard title="Demo vs Live Comparison" icon={<BarChart2 size={15} />} accent="#3b82f6">
              {!data!.demoVsLive.demo && !data!.demoVsLive.live ? (
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>
                  Tag trades as "Live" or "Demo" to compare performance and measure the psychology gap between accounts.
                </p>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr 1fr', gap: 0, marginBottom: 6 }}>
                    <div />
                    <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#3b82f6', padding: '6px 0' }}>📊 Live</div>
                    <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#8b5cf6', padding: '6px 0' }}>🎮 Demo</div>
                  </div>
                  {[
                    { label: 'Trades', a: data!.demoVsLive.live?.tradeCount ?? '—', b: data!.demoVsLive.demo?.tradeCount ?? '—' },
                    { label: 'Win Rate', a: data!.demoVsLive.live ? `${data!.demoVsLive.live.winRate}%` : '—', b: data!.demoVsLive.demo ? `${data!.demoVsLive.demo.winRate}%` : '—', aColor: (data!.demoVsLive.live?.winRate ?? 0) >= (data!.demoVsLive.demo?.winRate ?? 0) ? '#10b981' : '#ef4444' },
                    { label: 'Avg P&L', a: data!.demoVsLive.live ? `$${data!.demoVsLive.live.avgPnL.toFixed(2)}` : '—', b: data!.demoVsLive.demo ? `$${data!.demoVsLive.demo.avgPnL.toFixed(2)}` : '—', aColor: (data!.demoVsLive.live?.avgPnL ?? 0) >= 0 ? '#10b981' : '#ef4444', bColor: (data!.demoVsLive.demo?.avgPnL ?? 0) >= 0 ? '#10b981' : '#ef4444' },
                    { label: 'Profit Factor', a: data!.demoVsLive.live ? data!.demoVsLive.live.profitFactor : '—', b: data!.demoVsLive.demo ? data!.demoVsLive.demo.profitFactor : '—' },
                    { label: 'Plan Adherence', a: data!.demoVsLive.live?.planAdherence != null ? `${data!.demoVsLive.live.planAdherence}%` : '—', b: data!.demoVsLive.demo?.planAdherence != null ? `${data!.demoVsLive.demo.planAdherence}%` : '—' },
                  ].map(row => <StatRow key={row.label} {...row} aColor={row.aColor} bColor={row.bColor} />)}
                </>
              )}
            </SectionCard>

            {/* Versioned strategy audit */}
            {data!.playbookAnalytics.length > 0 && (
              <SectionCard title="Strategy Versions" icon={<FileClock size={15} />} accent="#8b5cf6" help="Each published playbook version is measured separately so you can see whether a strategy change improved or weakened results.">
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Each version is measured separately, so later edits never rewrite the performance of earlier rules.</p>
                <div style={{ display: 'grid', gap: 8 }}>
                  {data!.playbookAnalytics.map(item => (
                    <div key={item.versionId} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) repeat(3, minmax(70px, auto))', gap: 12, alignItems: 'center', padding: '11px 13px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }}>
                      <div><div style={{ fontWeight: 750, fontSize: 13 }}>{item.playbookName} <span style={{ color: '#8b5cf6' }}>v{item.versionNumber}</span></div><div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{item.tradeCount < 5 ? 'Early evidence' : `${item.tradeCount} completed trades`}</div></div>
                      <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Trades</div><strong>{item.tradeCount}</strong></div>
                      <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Win rate</div><strong>{item.winRate}%</strong></div>
                      <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Avg P&L</div><strong style={{ color: item.avgPnL >= 0 ? '#10b981' : '#ef4444' }}>${item.avgPnL.toFixed(2)}</strong></div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {(data!.stageCompliance || []).length > 0 && (
              <SectionCard title="Lifecycle Stage Compliance" icon={<Shield size={15} />} accent="#3b82f6" help="Compares outcomes when every required field in a playbook stage was completed versus when that stage was incomplete.">
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Use the complete and incomplete columns to find the stages where discipline changes results. Stages without required fields will naturally show 100% completion.</p>
                <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}><th style={{ padding: '8px 10px' }}>Stage</th><th>Compliance</th><th>Complete</th><th>Incomplete</th><th>Outcome difference</th></tr></thead>
                  <tbody>{data!.stageCompliance.map(item => (
                    <tr key={`${item.playbookName}-${item.versionNumber}-${item.stageName}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px' }}><div style={{ fontWeight: 700 }}>{item.stageName}</div><div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>{item.playbookName} v{item.versionNumber} · {item.requiredFieldCount} required</div></td>
                      <td><strong>{item.complianceRate}%</strong><div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{item.tradeCount} trades</div></td>
                      <td>{item.completeAvgPnL == null ? '—' : <><strong style={{ color: item.completeAvgPnL >= 0 ? '#10b981' : '#ef4444' }}>${item.completeAvgPnL.toFixed(2)}</strong><div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{item.completeWinRate}% win</div></>}</td>
                      <td>{item.incompleteAvgPnL == null ? '—' : <><strong style={{ color: item.incompleteAvgPnL >= 0 ? '#10b981' : '#ef4444' }}>${item.incompleteAvgPnL.toFixed(2)}</strong><div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{item.incompleteWinRate}% win</div></>}</td>
                      <td><strong>{item.completeAvgPnL != null && item.incompleteAvgPnL != null ? `${item.completeAvgPnL - item.incompleteAvgPnL >= 0 ? '+' : ''}$${(item.completeAvgPnL - item.incompleteAvgPnL).toFixed(2)}` : 'Need both samples'}</strong></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </SectionCard>
            )}

            {(data!.numericFieldAnalytics || []).length > 0 && (
              <SectionCard title="Numeric Field Evidence" icon={<BarChart2 size={15} />} accent="#06b6d4" help="Shows the average recorded value overall, on winning trades, and on losing trades for numeric playbook fields such as risk, R:R, duration, and ratings.">
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Differences between winning and losing averages can suggest a useful threshold, but only strong samples should influence a strategy revision.</p>
                <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}><th style={{ padding: '8px 10px' }}>Field</th><th>Sample</th><th>Overall</th><th>Winning avg</th><th>Losing avg</th></tr></thead>
                  <tbody>{data!.numericFieldAnalytics.slice(0, 30).map(item => (
                    <tr key={`${item.playbookName}-${item.versionNumber}-${item.ruleId}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px' }}><div style={{ fontWeight: 700 }}>{item.ruleLabel}</div><div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>{item.blockName} · {item.playbookName} v{item.versionNumber}</div></td>
                      <td><span style={{ color: item.sampleStatus === 'strong' ? '#10b981' : item.sampleStatus === 'developing' ? '#f59e0b' : 'var(--text-muted)' }}>{item.sampleStatus}</span><div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{item.tradeCount} trades</div></td>
                      <td><strong>{item.averageValue}{item.unit}</strong></td>
                      <td><strong style={{ color: '#10b981' }}>{item.averageWinningValue == null ? '—' : `${item.averageWinningValue}${item.unit}`}</strong></td>
                      <td><strong style={{ color: '#ef4444' }}>{item.averageLosingValue == null ? '—' : `${item.averageLosingValue}${item.unit}`}</strong></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </SectionCard>
            )}

            {data!.ruleEffectiveness.length > 0 && (
              <SectionCard title="What Works — Rule Evidence" icon={<Target size={15} />} accent="#10b981" help="Compares trade outcomes for each structured playbook answer. Larger samples are more dependable than a few isolated trades.">
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Outcomes are grouped by the exact answer saved on each immutable trade snapshot. Treat small samples as observations, not conclusions.</p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}><th style={{ padding: '8px 10px' }}>Rule / answer</th><th>Sample</th><th>Trades</th><th>Win rate</th><th>Avg P&L</th></tr></thead>
                    <tbody>
                      {data!.ruleEffectiveness.slice(0, 30).map(item => (
                        <tr key={`${item.ruleId}-${item.answer}`} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '10px' }}><div style={{ fontWeight: 700 }}>{item.ruleLabel}</div><div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>{item.blockName} · Answer: <strong style={{ color: 'var(--text-primary)' }}>{item.answer}</strong></div></td>
                          <td><span style={{ padding: '3px 7px', borderRadius: 10, background: item.sampleStatus === 'strong' ? '#10b98120' : item.sampleStatus === 'developing' ? '#f59e0b20' : 'var(--bg-surface)', color: item.sampleStatus === 'strong' ? '#10b981' : item.sampleStatus === 'developing' ? '#f59e0b' : 'var(--text-muted)', fontSize: 10 }}>{item.sampleStatus}</span></td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>{item.tradeCount}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{item.winRate}%</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: item.avgPnL >= 0 ? '#10b981' : '#ef4444' }}>${item.avgPnL.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}

            {/* Legacy setup analytics */}
            {data!.setupAnalytics.length > 0 && (
              <SectionCard title="Best Setups by Win Rate" icon={<TrendingUp size={15} />} accent="#10b981">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data!.setupAnalytics.map((s, i) => (
                    <div key={s.setup} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 14px', background: 'var(--bg-elevated)',
                      borderRadius: 10, border: '1px solid var(--border)',
                    }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 8,
                        background: i === 0 ? '#10b98120' : 'var(--bg-surface)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 800,
                        color: i === 0 ? '#10b981' : 'var(--text-muted)',
                      }}>
                        {i + 1}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{s.setup}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {s.tradeCount} trades · avg ${s.avgPnL.toFixed(2)}
                          {s.avgPlannedRR ? ` · planned ${s.avgPlannedRR}R avg` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{
                          fontSize: 16, fontWeight: 800, fontFamily: 'var(--font-mono)',
                          color: s.winRate >= 60 ? '#10b981' : s.winRate >= 45 ? '#f59e0b' : '#ef4444',
                        }}>{s.winRate}%</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>win rate</div>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* ROW 7: Confidence vs Win Rate */}
            {data!.confidenceVsWinRate.length > 0 && (
              <SectionCard title="Confidence Rating vs Actual Win Rate" icon={<Brain size={15} />} accent="#6366f1">
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Does your pre-trade confidence actually predict success? Higher confidence should mean higher win rate — if not, you may be overconfident when you shouldn't be.
                </p>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={data!.confidenceVsWinRate} barCategoryGap="30%">
                    <XAxis dataKey="confidence" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} label={{ value: 'Confidence', position: 'insideBottom', offset: -2, fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} unit="%" domain={[0, 100]} />
                    <Tooltip formatter={(v: any) => [`${v}%`, 'Win Rate']} contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="winRate" radius={[6, 6, 0, 0]}>
                      {data!.confidenceVsWinRate.map((entry, i) => (
                        <Cell key={i} fill={entry.winRate >= 60 ? '#10b981' : entry.winRate >= 45 ? '#f59e0b' : '#ef4444'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </SectionCard>
            )}

          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
      `}</style>
    </main>
  );
}
