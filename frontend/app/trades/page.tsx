'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { 
  SlidersHorizontal, ChevronLeft, ChevronRight, List, 
  X, Smile, Award, Tag, CheckSquare, Save, Info,
  Upload, Image as ImageIcon, Trash2
} from 'lucide-react';

const API = '/api';
const PAGE_SIZE = 50;

interface ChecklistItem {
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
  checklist?: ChecklistItem[];
  screenshots?: TradeScreenshot[];
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

export default function TradesPage() {
  const router = useRouter();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [hasToken, setHasToken] = useState(false);

  // Auth checking
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    setHasToken(true);
  }, [router]);

  // Filters
  const [symbol, setSymbol]       = useState('');
  const [direction, setDirection] = useState('');
  const [from, setFrom]           = useState('');
  const [to, setTo]               = useState('');
  const [symbols, setSymbols]     = useState<string[]>([]);

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

  const load = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      ...(symbol    && { symbol }),
      ...(direction && { direction }),
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
  }, [page, symbol, direction, from, to, router]);

  useEffect(() => { load(); }, [load]);

  const resetFilters = () => {
    setSymbol(''); setDirection(''); setFrom(''); setTo(''); setPage(1);
  };

  const handleRowClick = (trade: Trade) => {
    setSelectedTrade(trade);
    setDraftNotes(trade.notes || '');
    setDraftEmotion(trade.emotion || '');
    setDraftGrade(trade.grade || '');
    setDraftTags(trade.tags || []);
    setDraftChecklist(
      trade.checklist && trade.checklist.length > 0
        ? trade.checklist
        : DEFAULT_CHECKLIST.map(c => ({ ...c }))
    );
    setTagInput('');
    setScreenshotCaption('');
    setPreviewScreenshot(null);
  };

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
          checklist: draftChecklist
        })
      });
      if (res.status === 401) {
        localStorage.removeItem('token');
        router.push('/login');
        return;
      }
      if (!res.ok) throw new Error('Failed to update journal');
      const updatedTrade = await res.json();
      
      // Update locally in trades list
      setTrades(prev => prev.map(t => t._id === updatedTrade._id ? updatedTrade : t));
      setSelectedTrade(updatedTrade);
      
      // Success alert style or auto close
      setSelectedTrade(null);
    } catch (e) {
      console.error(e);
      alert('Error saving journal notes');
    } finally {
      setSaving(false);
    }
  };

  const updateTradeInState = (updatedTrade: Trade) => {
    setTrades(prev => prev.map(t => t._id === updatedTrade._id ? updatedTrade : t));
    setSelectedTrade(updatedTrade);
  };

  const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read screenshot file'));
    reader.readAsDataURL(file);
  });

  const uploadScreenshotDataUrl = useCallback(async (imageData: string) => {
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
          caption: screenshotCaption,
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
  }, [router, screenshotCaption, selectedTrade]);

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file.');
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      alert('Please keep screenshots under 8MB.');
      return;
    }

    try {
      await uploadScreenshotDataUrl(await fileToDataUrl(file));
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Screenshot upload failed');
    }
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
      try {
        await uploadScreenshotDataUrl(await fileToDataUrl(file));
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : 'Screenshot upload failed');
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [selectedTrade, uploadScreenshotDataUrl, uploadingScreenshot]);

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
          <select value={symbol} onChange={e => { setSymbol(e.target.value); setPage(1); }}>
            <option value="">All pairs</option>
            {symbols.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="filter-group">
          <label>Direction</label>
          <select value={direction} onChange={e => { setDirection(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </div>
        <div className="filter-group">
          <label>From date</label>
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} />
        </div>
        <div className="filter-group">
          <label>To date</label>
          <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} />
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
                    return (
                      <tr 
                        key={t._id} 
                        className="clickable" 
                        onClick={() => handleRowClick(t)}
                        title="Click to open journal drawer"
                      >
                        <td style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                          {(page - 1) * PAGE_SIZE + i + 1}
                        </td>
                        <td className="text" style={{ fontWeight: 600 }}>
                          {t.symbol}
                        </td>
                        <td>
                          <span className={`badge ${t.direction.toLowerCase()}`}>{t.direction}</span>
                        </td>
                        <td>
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
                <button className="page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft size={14} />
                </button>
                <span className="page-current">{page} / {totalPages}</span>
                <button className="page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
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
          <div className="drawer-overlay" onClick={() => setSelectedTrade(null)} />
          <div className="drawer">
            <div className="drawer-header">
              <div>
                <h3>Trade Journal Details</h3>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  Ticket: {selectedTrade.dealId}
                </span>
              </div>
              <button className="drawer-close" onClick={() => setSelectedTrade(null)}>
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

              {/* Trading Checklist Grade */}
              <div className="drawer-section">
                <span className="drawer-section-title"><Award size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Setup Quality Grade</span>
                <div className="grade-grid">
                  {GRADES.map(g => (
                    <button
                      key={g}
                      className={`grade-pill ${draftGrade === g ? `active ${g}` : ''}`}
                      onClick={() => setDraftGrade(g)}
                    >
                      {g}
                    </button>
                  ))}
                </div>
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

              {/* Strategy Rules Compliance Checklist */}
              <div className="drawer-section">
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
              </div>

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
                <div className="screenshot-upload-panel">
                  <input
                    type="text"
                    className="screenshot-caption-input"
                    placeholder="Optional caption, e.g. entry trigger or HTF context"
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
                onClick={() => setSelectedTrade(null)}
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
    </div>
  );
}
