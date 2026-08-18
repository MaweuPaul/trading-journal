'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  HardDrive, Download, FileJson, FileText, RefreshCw,
  Database, CheckCircle, AlertCircle, Clock, ImageOff,
  Shield, Layers, ChevronRight, AlertTriangle, Wifi, WifiOff,
} from 'lucide-react';

const API = '/api';

interface ExportStatus {
  dbMode: 'mongodb' | 'offline';
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

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function StatusBadge({ mode }: { mode: 'mongodb' | 'offline' }) {
  const isOnline = mode === 'mongodb';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
      background: isOnline ? 'var(--green-bg)' : 'var(--amber-bg)',
      color: isOnline ? 'var(--green)' : 'var(--amber)',
      border: `1px solid ${isOnline ? 'var(--green-border)' : '#f59e0b33'}`,
    }}>
      {isOnline ? <Wifi size={11} /> : <WifiOff size={11} />}
      {isOnline ? 'MongoDB Connected' : 'Offline (Local Cache)'}
    </span>
  );
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

        {/* Status Card */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: '24px 28px',
          marginBottom: 24,
          boxShadow: 'var(--shadow-card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Database size={17} color="var(--accent)" />
              <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
                Database Status
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {status && <StatusBadge mode={status.dbMode} />}
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
          </div>

          {loading ? (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[1, 2, 3, 4].map(i => (
                <div key={i} style={{
                  flex: '1 1 160px', height: 72, borderRadius: 10,
                  background: 'var(--bg-elevated)', animation: 'pulse 1.5s ease infinite',
                }} />
              ))}
            </div>
          ) : status ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
              <StatTile label="Trades" value={status.tradeCount.toLocaleString()} icon={<Layers size={14} />} />
              <StatTile label="Account Events" value={status.eventCount.toLocaleString()} icon={<Database size={14} />} />
              <StatTile
                label="Oldest Trade"
                value={status.oldestTrade ? new Date(status.oldestTrade).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'}
                icon={<Clock size={14} />}
              />
              <StatTile
                label="Latest Trade"
                value={status.newestTrade ? new Date(status.newestTrade).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'}
                icon={<Clock size={14} />}
                accent
              />
            </div>
          ) : null}

          {/* Pending offline screenshots warning */}
          {status && status.pendingOfflineScreenshots > 0 && (
            <div style={{
              marginTop: 16, padding: '10px 14px',
              background: 'var(--amber-bg)', borderRadius: 8,
              border: '1px solid #f59e0b33',
              display: 'flex', alignItems: 'center', gap: 9, fontSize: 13,
              color: '#92400e',
            }}>
              <AlertTriangle size={14} />
              <strong>{status.pendingOfflineScreenshots}</strong>&nbsp;screenshot{status.pendingOfflineScreenshots !== 1 ? 's' : ''}&nbsp;saved
              locally (offline mode), waiting to sync to Cloudinary when MongoDB reconnects.
            </div>
          )}
        </div>

        {/* Local JSON Backup Info */}
        {status?.localBackupInfo && (
          <div style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 16, padding: '20px 24px',
            marginBottom: 24, boxShadow: 'var(--shadow-card)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
              <Shield size={16} color="var(--green)" />
              <span style={{ fontWeight: 600, fontSize: 15 }}>Local JSON Mirror</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 20,
                background: 'var(--green-bg)', color: 'var(--green)',
                border: '1px solid var(--green-border)', fontWeight: 600,
              }}>Active</span>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
              Your trades are automatically mirrored to a local JSON file on the server disk. This backup
              is updated on startup and every 24 hours. If MongoDB becomes unavailable, the server uses
              this file as a fallback — your data is never lost.
            </p>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <CheckCircle size={12} color="var(--green)" />
                Size: <strong>&nbsp;{fmtBytes(status.localBackupInfo.sizeBytes)}</strong>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Clock size={12} />
                Last updated: <strong>&nbsp;{fmt(status.localBackupInfo.lastModified)}</strong>
              </span>
            </div>
          </div>
        )}

        {/* Screenshot Redundancy Info */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16, padding: '20px 24px',
          marginBottom: 24, boxShadow: 'var(--shadow-card)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
            <ImageOff size={16} color="var(--accent)" />
            <span style={{ fontWeight: 600, fontSize: 15 }}>Screenshot Metadata Redundancy</span>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 12 }}>
            Every screenshot you upload now carries full trade metadata in two places:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Cloudinary Context Tags', desc: 'Symbol, direction, P&L, prices, dates and more are embedded as tags directly on the Cloudinary image. You can read them from the Cloudinary dashboard without needing MongoDB.' },
              { label: 'Sidecar metadata.json', desc: 'A companion JSON file is uploaded alongside each screenshot. It contains the full trade record so you can reconstruct any trade from the image folder alone.' },
              { label: 'Offline Screenshots → Auto-Upload', desc: 'If MongoDB is offline when you upload a screenshot, the image is saved to the server disk with a meta.json sidecar. When MongoDB reconnects, it auto-uploads to Cloudinary and cleans up the disk file.' },
            ].map(item => (
              <div key={item.label} style={{
                display: 'flex', gap: 10,
                padding: '10px 12px', borderRadius: 8,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              }}>
                <ChevronRight size={13} color="var(--accent)" style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)', marginBottom: 2 }}>
                    {item.label}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                    {item.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

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
              Status as of {fmt(status.exportedAt)} · Source: <strong>{status.dbMode === 'mongodb' ? 'MongoDB (live)' : 'Local cache (offline)'}</strong>
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

function StatTile({ label, value, icon, accent }: {
  label: string; value: string; icon: React.ReactNode; accent?: boolean;
}) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 10,
      background: accent ? 'var(--accent-light)' : 'var(--bg-elevated)',
      border: `1px solid ${accent ? 'var(--accent-mid)' : 'var(--border)'}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        color: 'var(--text-muted)', fontSize: 11, marginBottom: 6,
      }}>
        {icon}
        {label}
      </div>
      <div style={{
        fontSize: 20, fontWeight: 700,
        color: accent ? 'var(--accent)' : 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
      }}>
        {value}
      </div>
    </div>
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
