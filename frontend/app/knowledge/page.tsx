'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen, Plus, Search, X, Loader2, AlertCircle, Image as ImageIcon,
  Upload, Trash2, Tag,
} from 'lucide-react';

const API = '/api';

interface Screenshot {
  _id: string;
  url: string;
  caption: string;
  uploadedAt: string;
}

interface KnowledgeEntry {
  _id: string;
  title: string;
  content: string;
  tags: string[];
  screenshots: Screenshot[];
  createdAt: string;
  updatedAt: string;
}

function fmtDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function KnowledgePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);
  const [screenshotCaption, setScreenshotCaption] = useState('');
  const [previewScreenshot, setPreviewScreenshot] = useState<Screenshot | null>(null);
  const [drawerError, setDrawerError] = useState('');

  const token = () => localStorage.getItem('token');

  const loadEntries = useCallback(async (searchTerm = search) => {
    const t = token();
    if (!t) { router.push('/login'); return; }
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set('search', searchTerm);
      const response = await fetch(`${API}/knowledge-entries?${params.toString()}`, { headers: { Authorization: `Bearer ${t}` } });
      if (response.status === 401) { localStorage.removeItem('token'); router.push('/login'); return; }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load knowledge entries.');
      setEntries(body.entries || []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load knowledge entries.');
    } finally {
      setLoading(false);
    }
  }, [router, search]);

  useEffect(() => { void loadEntries(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setTimeout(() => { void loadEntries(search); }, 300);
    return () => clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  function openNewEntry() {
    setEditingId(null);
    setTitle(''); setContent(''); setTagsInput(''); setScreenshots([]);
    setDrawerError('');
    setDrawerOpen(true);
  }

  function openEntry(entry: KnowledgeEntry) {
    setEditingId(entry._id);
    setTitle(entry.title); setContent(entry.content); setTagsInput(entry.tags.join(', ')); setScreenshots(entry.screenshots || []);
    setDrawerError('');
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  async function saveEntry() {
    if (!title.trim()) { setDrawerError('Give this entry a title.'); return; }
    setSaving(true); setDrawerError('');
    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
    try {
      const url = editingId ? `${API}/knowledge-entries/${editingId}` : `${API}/knowledge-entries`;
      const method = editingId ? 'PUT' : 'POST';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ title, content, tags }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save this entry.');
      if (!editingId) {
        setEditingId(body.entry._id);
        setScreenshots(body.entry.screenshots || []);
      }
      await loadEntries();
    } catch (caught) {
      setDrawerError(caught instanceof Error ? caught.message : 'Could not save this entry.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(entry: KnowledgeEntry) {
    if (!confirm(`Delete "${entry.title}"? This also removes its ${entry.screenshots.length} screenshot${entry.screenshots.length === 1 ? '' : 's'}.`)) return;
    try {
      const response = await fetch(`${API}/knowledge-entries/${entry._id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not delete this entry.');
      if (editingId === entry._id) closeDrawer();
      await loadEntries();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this entry.');
    }
  }

  const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });

  async function uploadScreenshotDataUrl(imageData: string) {
    if (!editingId) { setDrawerError('Save the entry first, then attach screenshots.'); return; }
    setUploadingScreenshot(true); setDrawerError('');
    try {
      const response = await fetch(`${API}/knowledge-entries/${editingId}/screenshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ imageData, caption: screenshotCaption }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Screenshot upload failed.');
      setScreenshots(body.entry.screenshots || []);
      setScreenshotCaption('');
    } catch (caught) {
      setDrawerError(caught instanceof Error ? caught.message : 'Screenshot upload failed.');
    } finally {
      setUploadingScreenshot(false);
    }
  }

  async function uploadScreenshotFile(file: File) {
    if (!file.type.startsWith('image/')) { setDrawerError('Please choose an image file.'); return; }
    if (file.size > 8 * 1024 * 1024) { setDrawerError('Please keep screenshots under 8MB.'); return; }
    await uploadScreenshotDataUrl(await fileToDataUrl(file));
  }

  useEffect(() => {
    if (!drawerOpen || !editingId) return;
    const handlePaste = async (event: ClipboardEvent) => {
      if (uploadingScreenshot) return;
      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find(item => item.type.startsWith('image/'));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      await uploadScreenshotFile(file);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [drawerOpen, editingId, uploadingScreenshot]); // eslint-disable-line react-hooks/exhaustive-deps

  async function deleteScreenshot(screenshotId: string) {
    if (!editingId) return;
    try {
      const response = await fetch(`${API}/knowledge-entries/${editingId}/screenshots/${screenshotId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not delete screenshot.');
      setScreenshots(body.entry.screenshots || []);
      if (previewScreenshot?._id === screenshotId) setPreviewScreenshot(null);
    } catch (caught) {
      setDrawerError(caught instanceof Error ? caught.message : 'Could not delete screenshot.');
    }
  }

  return (
    <main className="page-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={20} color="var(--accent)" />
            <h1 style={{ fontSize: 20, margin: 0 }}>Knowledge Base</h1>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            General trading knowledge, findings, and notes — not tied to any specific trade.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openNewEntry}><Plus size={15} /> New Entry</button>
      </div>

      <div style={{ position: 'relative', maxWidth: 360, marginBottom: 20 }}>
        <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input
          type="text"
          placeholder="Search title or content..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '9px 12px 9px 32px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13 }}
        />
      </div>

      {error && <div className="account-alert error" role="alert" style={{ marginBottom: 16 }}><AlertCircle size={16} />{error}</div>}

      {loading && entries.length === 0 ? (
        <div className="loading-wrap" style={{ minHeight: 200 }}><Loader2 className="spin" size={22} /></div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><BookOpen size={22} /></div>
          <h3>No entries yet</h3>
          <p>Write down anything worth remembering — broker quirks, market structure ideas, session observations.</p>
          <button className="btn btn-primary" onClick={openNewEntry} style={{ marginTop: 12 }}><Plus size={15} /> New Entry</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {entries.map(entry => (
            <article
              key={entry._id}
              onClick={() => openEntry(entry)}
              style={{ cursor: 'pointer', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: 'var(--shadow-sm)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <h3 style={{ fontSize: 14, margin: 0, lineHeight: 1.35 }}>{entry.title}</h3>
                {entry.screenshots.length > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                    <ImageIcon size={12} /> {entry.screenshots.length}
                  </span>
                )}
              </div>
              {entry.content && (
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {entry.content}
                </p>
              )}
              {entry.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {entry.tags.map(tag => (
                    <span key={tag} style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--accent-light)', color: 'var(--accent)' }}>{tag}</span>
                  ))}
                </div>
              )}
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{fmtDate(entry.createdAt)}</span>
            </article>
          ))}
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={closeDrawer} />
          <div className="drawer" style={{ width: 560 }}>
            <div className="drawer-header">
              <h3>{editingId ? 'Edit Entry' : 'New Entry'}</h3>
              <button className="drawer-close" onClick={closeDrawer}><X size={16} /></button>
            </div>
            <div className="drawer-body">
              {drawerError && <div className="account-alert error" role="alert"><AlertCircle size={16} />{drawerError}</div>}

              <div className="drawer-section">
                <span className="drawer-section-title">Title</span>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Why Exness swap fees spike on Wednesdays"
                  maxLength={160}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontSize: 13.5, fontWeight: 600 }}
                />
              </div>

              <div className="drawer-section">
                <span className="drawer-section-title">Notes</span>
                <textarea
                  className="drawer-textarea"
                  style={{ height: 220 }}
                  placeholder="Write down what you learned, observed, or want to remember..."
                  value={content}
                  onChange={e => setContent(e.target.value)}
                />
              </div>

              <div className="drawer-section">
                <span className="drawer-section-title"><Tag size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Tags</span>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={e => setTagsInput(e.target.value)}
                  placeholder="comma, separated, tags"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontSize: 12.5 }}
                />
              </div>

              <div className="drawer-section">
                <span className="drawer-section-title">Screenshots</span>
                {!editingId && (
                  <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>Save the entry once to attach screenshots.</p>
                )}
                {editingId && (
                  <>
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
                          onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) await uploadScreenshotFile(file); }}
                          disabled={uploadingScreenshot}
                          hidden
                        />
                      </label>
                    </div>

                    {screenshots.length > 0 ? (
                      <div className="screenshot-grid">
                        {screenshots.map(shot => (
                          <div className="screenshot-tile" key={shot._id}>
                            <button className="screenshot-thumb-btn" onClick={() => setPreviewScreenshot(shot)}>
                              <img src={shot.url} alt={shot.caption || 'Knowledge base screenshot'} loading="lazy" />
                            </button>
                            <button className="screenshot-delete-btn" onClick={() => deleteScreenshot(shot._id)} aria-label="Delete screenshot">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="screenshot-empty">
                        <ImageIcon size={16} />
                        <span>No screenshots attached yet — paste or upload one</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="drawer-footer">
              {editingId && (
                <button className="btn btn-ghost" style={{ color: 'var(--red)' }} onClick={() => { const entry = entries.find(e => e._id === editingId); if (entry) void deleteEntry(entry); }}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={saving} onClick={saveEntry}>
                {saving ? <Loader2 size={14} className="spin" /> : null} {editingId ? 'Save Changes' : 'Create Entry'}
              </button>
            </div>
          </div>
        </>
      )}

      {previewScreenshot && (
        <div className="screenshot-preview-overlay" onClick={() => setPreviewScreenshot(null)}>
          <div className="screenshot-preview-modal" onClick={e => e.stopPropagation()}>
            <div className="screenshot-preview-header">
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{previewScreenshot.caption || 'Screenshot'}</span>
              <button className="drawer-close" onClick={() => setPreviewScreenshot(null)}><X size={16} /></button>
            </div>
            <img className="screenshot-preview-image" src={previewScreenshot.url} alt={previewScreenshot.caption || 'Knowledge base screenshot'} />
          </div>
        </div>
      )}
    </main>
  );
}
