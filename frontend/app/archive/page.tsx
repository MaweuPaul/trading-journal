'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  HardDrive, Download, FileJson, FileText, RefreshCw,
  CheckCircle, AlertCircle, AlertTriangle,
} from 'lucide-react';

const API = '/api';

interface ExportStatus {
  dbMode: 'cloud' | 'offline';
  tradeCount: number;
  eventCount: number;
  oldestTrade: string | null;
  newestTrade: string | null;
  pendingOfflineScreenshots: number;
  localBackupInfo: {
    path: string;
    sizeBytes: number;
    lastModified: string;
  } | null;
  exportedAt: string;
}

function fmt(date: string | null) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ArchivePage() {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState<'json' | 'csv' | null>(null);

  const getToken = () =>
    typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/export/status`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load status');
      setStatus(await res.json());
    } catch (e: any) {
      setError(e.message || 'Failed to load backup status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function downloadFile(type: 'json' | 'csv') {
    setDownloading(type);
    try {
      const res = await fetch(`${API}/export/${type}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers.get('content-disposition') || '';
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match ? match[1] : `trade-journal-${new Date().toISOString().split('T')[0]}.${type}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Export failed: ${e.message}`);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <main className="page-content">
      <div style={{ width: '100%', padding: '0 0 32px' }}>

        {/* Header */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: 'linear-gradient(135deg, #d4af37 0%, #b8860b 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 14px rgba(212,175,55,0.35)',
            }}>
              <HardDrive size={22} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                Backup &amp; Export
              </h1>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                Download your data or verify redundancy status
              </p>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'var(--red-bg)', border: '1px solid var(--red-border)',
            borderRadius: 10, padding: '12px 16px', marginBottom: 20,
            color: 'var(--red)', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center',
          }}>
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {/* Backup reassurance strip */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: '18px 24px',
          marginBottom: 24,
          boxShadow: 'var(--shadow-card)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: 'var(--green-bg)', border: '1px solid var(--green-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <CheckCircle size={17} color="var(--green)" />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>Your data is backed up</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {loading ? 'Checking…' : status ? `${status.tradeCount.toLocaleString()} trade${status.tradeCount === 1 ? '' : 's'} saved` : '—'}
                {status?.localBackupInfo && ` · Last updated ${fmt(status.localBackupInfo.lastModified)}`}
              </div>
            </div>
          </div>
          <button
            onClick={fetchStatus}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', border: '1px solid var(--border)',
              borderRadius: 8, background: 'var(--bg-elevated)',
              fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>

        {/* Pending offline screenshots warning */}
        {status && status.pendingOfflineScreenshots > 0 && (
          <div style={{
            marginBottom: 24, padding: '10px 14px',
            background: 'var(--amber-bg)', borderRadius: 10,
            border: '1px solid #f59e0b33',
            display: 'flex', alignItems: 'center', gap: 9, fontSize: 13,
            color: '#92400e',
          }}>
            <AlertTriangle size={14} />
            <strong>{status.pendingOfflineScreenshots}</strong>&nbsp;screenshot{status.pendingOfflineScreenshots !== 1 ? 's' : ''}&nbsp;waiting
            to finish uploading — they&apos;ll sync automatically once you&apos;re back online.
          </div>
        )}

        {/* Export Buttons */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16, padding: '24px 28px',
          boxShadow: 'var(--shadow-card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <Download size={16} color="var(--accent)" />
            <span style={{ fontWeight: 600, fontSize: 15 }}>Export Data</span>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
            Download a full snapshot of your journal. The JSON export includes all trade data, account events,
            and screenshot URLs — enough to restore everything into a fresh database. The CSV is great for
            importing into Excel, Google Sheets, or another tool.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            <ExportCard
              icon={<FileJson size={28} />}
              color="#b8860b"
              title="Full JSON Backup"
              subtitle="All trades + account events"
              description={`${status?.tradeCount ?? '…'} trades · ${status?.eventCount ?? '…'} account events · Complete schema`}
              buttonLabel={downloading === 'json' ? 'Downloading…' : 'Download JSON'}
              disabled={!!downloading}
              exportId="export-json"
              onClick={() => downloadFile('json')}
            />

            <ExportCard
              icon={<FileText size={28} />}
              color="#10b981"
              title="CSV Spreadsheet"
              subtitle="For Excel / Google Sheets"
              description="dealId, symbol, direction, P&L, prices, times, tags, emotion, grade, notes, screenshot URLs"
              buttonLabel={downloading === 'csv' ? 'Downloading…' : 'Download CSV'}
              disabled={!!downloading}
              exportId="export-csv"
              onClick={() => downloadFile('csv')}
            />
          </div>

          {status && (
            <p style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center' }}>
              Status as of {fmt(status.exportedAt)} · Source: <strong>{status.dbMode === 'cloud' ? 'Database (live)' : 'Local cache (offline)'}</strong>
            </p>
          )}
        </div>

      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </main>
  );
}

function ExportCard({
  icon, color, title, subtitle, description, buttonLabel, disabled, onClick, exportId,
}: {
  icon: React.ReactNode; color: string; title: string; subtitle: string;
  description: string; buttonLabel: string; disabled: boolean; onClick: () => void; exportId: string;
}) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 12,
      padding: '20px', background: 'var(--bg-elevated)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: `${color}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color,
        }}>
          {icon}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{subtitle}</div>
        </div>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>
        {description}
      </p>
      <button
        id={exportId}
        onClick={onClick}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          padding: '10px 0', borderRadius: 8, border: 'none',
          background: disabled ? 'var(--border)' : color,
          color: disabled ? 'var(--text-muted)' : '#fff',
          fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.15s ease',
          fontFamily: 'var(--font-sans)',
        }}
        onMouseEnter={e => { if (!disabled) (e.currentTarget.style.filter = 'brightness(1.1)'); }}
        onMouseLeave={e => { (e.currentTarget.style.filter = ''); }}
      >
        <Download size={14} />
        {buttonLabel}
      </button>
    </div>
  );
}
