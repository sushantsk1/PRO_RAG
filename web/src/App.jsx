import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowRight, BarChart3, BookOpen,
  Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Database, File,
  FileCheck2, FileText, FlaskConical, FolderOpen, HelpCircle, Layers3,
  LoaderCircle, Menu, MessageCircle, MoreHorizontal, Plus, RefreshCw, Search,
  Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, UploadCloud,
  X
} from 'lucide-react';
import { api, queryString } from './api.js';

const NAV = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'library', label: 'Knowledge library', icon: FolderOpen },
  { id: 'ask', label: 'Ask documents', icon: MessageCircle },
  { id: 'evaluate', label: 'Evaluate', icon: FlaskConical },
  { id: 'settings', label: 'Settings', icon: Settings2 }
];
const PAGE = {
  overview: ['Overview', 'Your document intelligence workspace at a glance.'],
  library: ['Knowledge library', 'Organize, process, and inspect your sources.'],
  ask: ['Ask documents', 'Ground every answer in inspectable evidence.'],
  evaluate: ['Evaluate', 'Measure retrieval quality against a repeatable baseline.'],
  settings: ['Settings', 'Local runtime, model status, and data boundaries.']
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function compactDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatNumber(value) { return Number(value || 0).toLocaleString(); }
function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
function percent(value) { return value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function ms(value) { return value == null ? '—' : `${Math.round(Number(value))} ms`; }
function locationLabel(location) {
  if (!location) return 'Location unavailable';
  if (location.page != null) return `Page ${location.page}`;
  if (location.slide != null) return `Slide ${location.slide}`;
  if (location.sheet) return `${location.sheet}${location.row != null ? `, row ${location.row}` : ''}`;
  if (location.heading) return location.heading;
  if (location.row != null) return `Row ${location.row}`;
  return location.type === 'line' ? 'Text section' : 'Location unavailable';
}
function saveJSON(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function IconButton({ icon: Icon, label, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon size={17} /></button>;
}
function Empty({ icon: Icon = FolderOpen, title, text, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={24} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function StatusPill({ status }) {
  const label = status === 'ready' ? 'Ready' : status === 'processing' ? 'Processing' : status === 'queued' ? 'Queued' : status === 'failed' ? 'Failed' : status === 'untested' ? 'Untested' : status === 'unavailable' ? 'Unavailable' : status || 'Unknown';
  return <span className={`status-pill status-${status || 'unknown'}`}><span className="status-dot" />{label}</span>;
}
function Notice({ value, onClose }) {
  if (!value) return null;
  return <div role={value.kind === 'error' ? 'alert' : 'status'} className={`notice notice-${value.kind || 'info'}`}>
    {value.kind === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
    <span>{value.message}</span><IconButton icon={X} label="Dismiss message" onClick={onClose} />
  </div>;
}
function Metric({ icon: Icon, title, value, foot, accent = 'blue' }) {
  return <div className="metric"><div className="metric-top"><span>{title}</span><span className={`metric-icon accent-${accent}`}><Icon size={18} /></span></div><strong>{value}</strong><small>{foot}</small></div>;
}
function SectionHeading({ eyebrow, title, subtitle, action }) {
  return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}

export default function App() {
  const [page, setPage] = useState('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collections, setCollections] = useState([]);
  const [collectionId, setCollectionId] = useState(localStorage.getItem('pro-rag-collection') || '');
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [queries, setQueries] = useState([]);
  const [cases, setCases] = useState([]);
  const [runs, setRuns] = useState([]);
  const [notice, setNotice] = useState(null);
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const activeCollection = collections.find(x => x.id === collectionId);

  const showError = useCallback((error) => {
    setNotice({ kind: 'error', message: error?.message || 'Something went wrong.' });
  }, []);
  const showSuccess = useCallback((message) => setNotice({ kind: 'success', message }), []);

  const loadBase = useCallback(async () => {
    const [h, c, s, cfg] = await Promise.all([
      api('/health'), api('/collections?limit=100'), api('/stats'), api('/config/status')
    ]);
    setHealth(h); setCollections(c.items || []); setStats(s); setConfig(cfg);
    setCollectionId(previous => {
      const next = c.items?.some(item => item.id === previous) ? previous : c.items?.[0]?.id || '';
      if (next) localStorage.setItem('pro-rag-collection', next);
      else localStorage.removeItem('pro-rag-collection');
      return next;
    });
  }, []);
  const loadCollection = useCallback(async (id) => {
    if (!id) { setDocuments([]); setQueries([]); setCases([]); setRuns([]); return; }
    const qs = queryString({ collectionId: id, limit: 100 });
    const [d, q, c, r] = await Promise.all([
      api(`/documents${qs}`), api(`/queries${qs}`),
      api(`/evaluations/cases${qs}`), api(`/evaluations/runs${qs}`)
    ]);
    setDocuments(d.items || []); setQueries(q.items || []);
    setCases(c.items || []); setRuns(r.items || []);
  }, []);
  const refresh = useCallback(async (collectionOverride) => {
    setRefreshing(true);
    try {
      const targetId = typeof collectionOverride === 'string' ? collectionOverride : collectionId;
      await loadBase();
      await loadCollection(targetId);
    }
    catch (error) { showError(error); }
    finally { setRefreshing(false); }
  }, [collectionId, loadBase, loadCollection, showError]);

  useEffect(() => {
    let live = true;
    (async () => {
      try { await loadBase(); }
      catch (error) { if (live) showError(error); }
      finally { if (live) setBooting(false); }
    })();
    return () => { live = false; };
  }, [loadBase, showError]);
  useEffect(() => {
    loadCollection(collectionId).catch(showError);
  }, [collectionId, loadCollection, showError]);
  useEffect(() => {
    if (!documents.some(d => d.status === 'queued' || d.status === 'processing')) return;
    const timer = setInterval(() => {
      loadCollection(collectionId).then(() => api('/stats').then(setStats)).catch(showError);
    }, 2500);
    return () => clearInterval(timer);
  }, [collectionId, documents, loadCollection, showError]);

  function navigate(next) { setPage(next); setMobileOpen(false); setNotice(null); }
  function chooseCollection(id) {
    setCollectionId(id);
    if (id) localStorage.setItem('pro-rag-collection', id);
    else localStorage.removeItem('pro-rag-collection');
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Layers3 size={21} strokeWidth={2.5} /></div><div><strong>PRO RAG</strong><span>INTELLIGENCE STUDIO</span></div></div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={19} /><span>{label}</span>{page === id && <ChevronRight size={16} className="nav-chevron" />}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-card"><div className="sidebar-card-icon"><Sparkles size={18} /></div><strong>Built for clarity</strong><p>Every answer can be traced back to your documents.</p><button onClick={() => navigate('ask')} type="button">Start exploring <ArrowRight size={14} /></button></div>
      <div className="sidebar-bottom"><div className="local-indicator"><span className={`status-dot ${health ? 'green' : 'red'}`} />{health ? 'Local API online' : 'Local API offline'}</div><span>Local-first · Private by design</span></div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><IconButton icon={Menu} label="Open menu" className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} /><span className="breadcrumb">Workspace</span><ChevronRight size={14} /><strong>{PAGE[page][0]}</strong></div><div className="topbar-right"><span className="privacy-chip"><ShieldCheck size={14} /> Local workspace</span><IconButton icon={RefreshCw} label="Refresh data" onClick={refresh} disabled={refreshing} /></div></header>
      <main className="content">
        <div className="page-header"><div><span className="eyebrow">DOCUMENT INTELLIGENCE</span><h1>{PAGE[page][0]}</h1><p>{PAGE[page][1]}</p></div><div className="page-header-right">{activeCollection && <span className="current-collection"><Database size={15} />{activeCollection.name}</span>}</div></div>
        <Notice value={notice} onClose={() => setNotice(null)} />
        {booting ? <div className="loading-page"><LoaderCircle className="spin" size={28} /> Connecting to local workspace…</div> :
          page === 'overview' ? <Overview stats={stats} documents={documents} queries={queries} runs={runs} config={config} navigate={navigate} collection={activeCollection} /> :
          page === 'library' ? <Library collections={collections} collectionId={collectionId} chooseCollection={chooseCollection} documents={documents} refresh={refresh} loadCollection={loadCollection} showError={showError} showSuccess={showSuccess} /> :
          page === 'ask' ? <Ask collectionId={collectionId} collections={collections} chooseCollection={chooseCollection} documents={documents} queries={queries} config={config} refresh={refresh} showError={showError} showSuccess={showSuccess} /> :
          page === 'evaluate' ? <Evaluate collectionId={collectionId} documents={documents} cases={cases} runs={runs} refresh={refresh} showError={showError} showSuccess={showSuccess} /> :
          <Settings config={config} health={health} />}
      </main>
    </div>
  </div>;
}

function Overview({ stats, documents, queries, runs, config, navigate, collection }) {
  const recent = queries.slice(0, 4);
  const formats = stats?.formatCounts || [];
  const maxFormat = Math.max(1, ...formats.map(x => x.count || 0));
  return <>
    <div className="hero"><div className="hero-content"><div className="hero-badge"><Sparkles size={14} /> YOUR KNOWLEDGE, CONNECTED</div><h2>Answers you can<br /><em>actually inspect.</em></h2><p>Explore documents with hybrid retrieval, inspect every source, and measure what works.</p><div className="hero-actions"><button className="button white" onClick={() => navigate('ask')}>Ask a question <ArrowRight size={16} /></button><button className="button ghost-white" onClick={() => navigate('library')}>Manage sources</button></div></div><div className="hero-visual" aria-hidden="true"><div className="visual-ring ring-one" /><div className="visual-ring ring-two" /><div className="visual-center"><Layers3 size={37} /></div><div className="visual-tag tag-a"><FileText size={16} /> Sources</div><div className="visual-tag tag-b"><Search size={16} /> Retrieval</div><div className="visual-tag tag-c"><CheckCircle2 size={16} /> Evidence</div></div></div>
    <div className="metrics-grid">
      <Metric icon={FolderOpen} title="Collections" value={formatNumber(stats?.collectionCount)} foot="Knowledge spaces" accent="blue" />
      <Metric icon={FileCheck2} title="Ready documents" value={formatNumber(stats?.readyDocumentCount)} foot={`${formatNumber(stats?.processingDocumentCount)} in progress`} accent="violet" />
      <Metric icon={Layers3} title="Indexed chunks" value={formatNumber(stats?.chunkCount)} foot="Searchable passages" accent="cyan" />
      <Metric icon={Activity} title="Avg. query time" value={ms(stats?.averageQueryLatencyMs)} foot="Recent response latency" accent="orange" />
    </div>
    <div className="overview-grid">
      <section className="surface"><SectionHeading eyebrow="ACTIVITY" title="Recent questions" action={<button className="text-button" onClick={() => navigate('ask')}>Open workspace <ArrowRight size={15} /></button>} />
        {recent.length ? <div className="recent-list">{recent.map(q => <button key={q.id} className="recent-row" onClick={() => navigate('ask')}><span className="recent-icon"><MessageCircle size={16} /></span><span className="recent-main"><strong>{q.question}</strong><small>{formatDate(q.createdAt)}</small></span><span className={`answer-tag ${q.answerStatus}`}>{q.answerStatus?.replace('_', ' ')}</span><ChevronRight size={15} /></button>)}</div> : <Empty icon={MessageCircle} title="No questions yet" text="Ask your first question after adding a document." action={<button className="button primary small" onClick={() => navigate('ask')}>Go to Ask</button>} />}
      </section>
      <section className="surface"><SectionHeading eyebrow="CORPUS" title="Document formats" subtitle="What your knowledge base contains." />
        {formats.length ? <div className="format-list">{formats.slice(0, 6).map(f => <div className="format-row" key={f.format}><span className="format-badge">{String(f.format).toUpperCase().slice(0, 4)}</span><div><div className="format-meta"><strong>{String(f.format).toUpperCase()}</strong><span>{f.count} files</span></div><div className="bar"><span style={{ width: `${Math.round((f.count / maxFormat) * 100)}%` }} /></div></div></div>)}</div> : <Empty icon={File} title="No formats to show" text="Upload a document to build your knowledge base." action={<button className="button secondary small" onClick={() => navigate('library')}>Upload files</button>} />}
      </section>
    </div>
    <div className="overview-grid lower">
      <section className="surface compact-surface"><div className="mini-feature"><span className="mini-icon purple"><FlaskConical size={20} /></span><div><strong>Quality lab</strong><p>{runs.length ? `${runs.length} evaluation run${runs.length === 1 ? '' : 's'} recorded. Compare hybrid with baseline.` : 'Create a golden set and compare retrieval modes.'}</p></div><button className="text-button" onClick={() => navigate('evaluate')}>Explore <ArrowRight size={15} /></button></div></section>
      <section className="surface compact-surface"><div className="mini-feature"><span className="mini-icon green"><ShieldCheck size={20} /></span><div><strong>Private workspace</strong><p>Documents and indexes stay local. {config?.nvidiaConfigured ? 'NVIDIA generation is configured.' : 'Add a NVIDIA key for answer generation.'}</p></div><button className="text-button" onClick={() => navigate('settings')}>Status <ArrowRight size={15} /></button></div></section>
    </div>
    {!collection && <div className="inline-tip"><HelpCircle size={18} /><span>Start by creating a collection in the Knowledge library.</span><button onClick={() => navigate('library')}>Create collection <ArrowRight size={14} /></button></div>}
  </>;
}

function Library({ collections, collectionId, chooseCollection, documents, refresh, loadCollection, showError, showSuccess }) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState([]);
  const [ocr, setOcr] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [chunks, setChunks] = useState([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const fileInput = useRef(null);
  const collection = collections.find(c => c.id === collectionId);

  async function createCollection(event) {
    event.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await api('/collections', { method: 'POST', body: { name: newName.trim() } });
      setNewName(''); await refresh(); chooseCollection(created.id); showSuccess('Collection created.');
    } catch (error) { showError(error); } finally { setCreating(false); }
  }
  async function deleteCollection() {
    if (!collection || !window.confirm(`Delete “${collection.name}” and all its indexed documents?`)) return;
    try {
      await api(`/collections/${collection.id}`, { method: 'DELETE' });
      const replacementId = collections.find(item => item.id !== collection.id)?.id || '';
      chooseCollection(replacementId);
      await refresh(replacementId);
      showSuccess('Collection deleted.');
    }
    catch (error) { showError(error); }
  }
  async function upload(event) {
    event.preventDefault();
    if (!collectionId || !files.length) return;
    const body = new FormData();
    body.append('collectionId', collectionId);
    body.append('ocr', String(ocr));
    files.forEach(file => body.append('files', file));
    setUploading(true);
    try {
      const result = await api('/documents', { method: 'POST', body });
      setFiles([]); if (fileInput.current) fileInput.current.value = '';
      await loadCollection(collectionId);
      showSuccess(`${result.items?.length || files.length} document${files.length === 1 ? '' : 's'} queued for processing.`);
    } catch (error) { showError(error); } finally { setUploading(false); }
  }
  async function openDocument(doc) {
    setSelectedDoc(doc); setChunks([]); setPreviewLoading(true);
    if (doc.status !== 'ready') { setPreviewLoading(false); return; }
    try { const result = await api(`/documents/${doc.id}/chunks?limit=100`); setChunks(result.items || []); }
    catch (error) { showError(error); }
    finally { setPreviewLoading(false); }
  }
  async function actionDocument(doc, action) {
    if (action === 'delete' && !window.confirm(`Remove “${doc.name}” and its indexed passages?`)) return;
    setBusyId(doc.id);
    try {
      await api(`/documents/${doc.id}${action === 'retry' ? '/retry' : ''}`, { method: action === 'retry' ? 'POST' : 'DELETE' });
      if (action === 'delete') setSelectedDoc(null);
      await loadCollection(collectionId);
      showSuccess(action === 'retry' ? 'Document queued again.' : 'Document removed from the index.');
    } catch (error) { showError(error); }
    finally { setBusyId(''); }
  }
  return <>
    <div className="library-top"><div className="collection-control"><label htmlFor="library-collection">Active collection</label><div className="select-wrap"><Database size={17} /><select id="library-collection" value={collectionId} onChange={e => chooseCollection(e.target.value)}><option value="">Select a collection</option>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={16} /></div></div><form className="create-form" onSubmit={createCollection}><label htmlFor="new-collection">New collection</label><div><input id="new-collection" placeholder="e.g. Product manuals" maxLength={80} value={newName} onChange={e => setNewName(e.target.value)} /><button className="button primary" disabled={creating || !newName.trim()}><Plus size={16} /> {creating ? 'Creating…' : 'Create'}</button></div></form></div>
    {!collectionId ? <Empty icon={FolderOpen} title="Create your first collection" text="Collections keep related documents and their answers together." /> : <>
      <div className="library-grid"><section className="surface upload-surface"><SectionHeading eyebrow="INGEST" title="Add documents" subtitle="Index files locally and make their content searchable." />
        <form onSubmit={upload}><div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); setFiles(Array.from(e.dataTransfer.files || [])); }}>
          <span className="drop-icon"><UploadCloud size={25} /></span><strong>Drop files here, or choose from your computer</strong><p>PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, HTML · up to 25 MB each</p><input ref={fileInput} id="file-upload" type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.markdown,.html,.htm" onChange={e => setFiles(Array.from(e.target.files || []))} /><label htmlFor="file-upload" className="button secondary small">Browse files</label>
        </div>{files.length > 0 && <div className="selected-files"><strong>{files.length} selected</strong><span>{files.map(f => f.name).join(', ')}</span><IconButton icon={X} label="Clear files" onClick={() => { setFiles([]); if (fileInput.current) fileInput.current.value = ''; }} /></div>}
        <div className="upload-footer"><label className="check-label"><input type="checkbox" checked={ocr} onChange={e => setOcr(e.target.checked)} /> Try local OCR for scanned PDFs</label><button className="button primary" type="submit" disabled={!files.length || uploading}>{uploading ? <LoaderCircle size={16} className="spin" /> : <UploadCloud size={16} />}{uploading ? 'Uploading…' : 'Upload & index'}</button></div></form>
      </section><section className="surface collection-summary"><SectionHeading eyebrow="COLLECTION" title={collection?.name || 'Collection'} subtitle={collection?.description || 'Your active knowledge space.'} /><div className="collection-counts"><div><strong>{formatNumber(collection?.documentCount)}</strong><span>Documents</span></div><div><strong>{formatNumber(collection?.readyDocumentCount)}</strong><span>Ready</span></div><div><strong>{formatNumber(collection?.chunkCount)}</strong><span>Chunks</span></div></div><div className="collection-note"><ShieldCheck size={17} /><p>Files, extracted text, and indexes are stored on this device. Only answer context is sent to NVIDIA when you choose generation.</p></div><button className="danger-link" onClick={deleteCollection} type="button"><Trash2 size={15} /> Delete collection</button></section></div>
      <section className="surface document-surface"><SectionHeading eyebrow="SOURCES" title="Documents" subtitle={`${documents.length} file${documents.length === 1 ? '' : 's'} in this collection`} action={<button className="text-button" onClick={() => loadCollection(collectionId).catch(showError)}><RefreshCw size={15} /> Refresh</button>} />
        {documents.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Document</th><th>Format</th><th>Status</th><th>Chunks</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{documents.map(doc => <tr key={doc.id}><td><button className="document-link" onClick={() => openDocument(doc)}><span className="file-tile"><FileText size={18} /></span><span><strong>{doc.name}</strong><small>{formatBytes(doc.sizeBytes)}{doc.locationSummary ? ` · ${doc.locationSummary}` : ''}</small></span></button></td><td className="uppercase muted">{doc.format || '—'}</td><td><StatusPill status={doc.status} />{doc.status === 'processing' && <div className="tiny-progress"><span style={{ width: `${doc.progress || 0}%` }} /></div>}</td><td>{formatNumber(doc.chunkCount)}</td><td className="muted">{compactDate(doc.createdAt)}</td><td><div className="row-actions">{doc.status === 'failed' && <IconButton icon={RefreshCw} label={`Retry ${doc.name}`} onClick={() => actionDocument(doc, 'retry')} disabled={busyId === doc.id} />}<IconButton icon={Trash2} label={`Delete ${doc.name}`} onClick={() => actionDocument(doc, 'delete')} disabled={busyId === doc.id} /></div></td></tr>)}</tbody></table></div> : <Empty icon={FileText} title="No documents yet" text="Upload a file above to start building this collection." />}
      </section>
      {selectedDoc && <DocumentPreview document={selectedDoc} chunks={chunks} loading={previewLoading} onClose={() => setSelectedDoc(null)} />}
    </>}
  </>;
}

function DocumentPreview({ document: selectedDoc, chunks, loading, onClose }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.querySelector('[aria-label="Close preview"]')?.focus();

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(element => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <div className="drawer-backdrop" onClick={() => onCloseRef.current()}>
    <aside ref={dialogRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="document-preview-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <div className="drawer-head"><div><span className="eyebrow">DOCUMENT PREVIEW</span><h2 id="document-preview-title">{selectedDoc.name}</h2></div><IconButton icon={X} label="Close preview" onClick={() => onCloseRef.current()} /></div>
      <div className="drawer-body">
        <div className="doc-details"><span><strong>Format</strong>{selectedDoc.format?.toUpperCase() || '—'}</span><span><strong>Status</strong><StatusPill status={selectedDoc.status} /></span><span><strong>Chunks</strong>{formatNumber(selectedDoc.chunkCount)}</span><span><strong>Added</strong>{formatDate(selectedDoc.createdAt)}</span></div>
        {selectedDoc.warning && <div className="inline-warning"><AlertCircle size={17} />{selectedDoc.warning}</div>}
        {selectedDoc.error && <div className="inline-warning error"><AlertCircle size={17} />{selectedDoc.error}</div>}
        <h3>Indexed passages</h3>
        {loading ? <p className="muted">Loading preview…</p> : chunks.length ? <div className="chunk-list">{chunks.map((chunk, i) => <article className="chunk-card" key={chunk.chunkId}><span>PASSAGE {String(i + 1).padStart(2, '0')} · {locationLabel(chunk.location)}</span><p>{chunk.text}</p></article>)}</div> : <Empty icon={FileText} title="No preview available" text={selectedDoc.status === 'ready' ? 'No passages were returned.' : 'Passages appear once processing is complete.'} />}
      </div>
    </aside>
  </div>;
}

function AnswerText({ answer, sources, citations, onSource }) {
  const known = new Map((citations || []).map(c => [c.marker, c.chunkId]));
  return <p className="answer-text">{String(answer || '').split(/(\[S\d+\])/g).map((part, i) => {
    const marker = part.match(/^\[(S\d+)\]$/)?.[1];
    const chunkId = marker && known.get(marker);
    const source = chunkId && sources.find(s => s.chunkId === chunkId);
    return source ? <button key={i} className="citation-button" onClick={() => onSource(source.chunkId)} title={`${source.documentName}, ${locationLabel(source.location)}`}>{part}</button> : <span key={i}>{part}</span>;
  })}</p>;
}

function Ask({ collectionId, collections, chooseCollection, documents, queries, config, refresh, showError }) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState('hybrid');
  const [generate, setGenerate] = useState(true);
  const [topK, setTopK] = useState(6);
  const [filters, setFilters] = useState([]);
  const [result, setResult] = useState(null);
  const [asking, setAsking] = useState(false);
  const [focusedSource, setFocusedSource] = useState('');
  const sourceRefs = useRef({});
  const readyDocs = documents.filter(d => d.status === 'ready');
  useEffect(() => { setFilters([]); setResult(null); }, [collectionId]);
  function toggleFilter(id) { setFilters(previous => previous.includes(id) ? previous.filter(x => x !== id) : [...previous, id]); }
  function focusSource(id) {
    setFocusedSource(id);
    sourceRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function submit(event) {
    event.preventDefault();
    if (!collectionId || !question.trim() || asking) return;
    setAsking(true); setResult(null); setFocusedSource('');
    try {
      const r = await api('/queries', { method: 'POST', body: { collectionId, question: question.trim(), documentIds: filters, mode, topK: Number(topK), generate } });
      setResult(r); await refresh();
    } catch (error) { showError(error); }
    finally { setAsking(false); }
  }
  async function openHistory(id) {
    try { setResult(await api(`/queries/${id}`)); }
    catch (error) { showError(error); }
  }
  return <div className="ask-grid"><section className="ask-main"><div className="surface ask-panel"><div className="ask-panel-head"><div><span className="eyebrow">GROUNDED ANSWERS</span><h2>Ask your knowledge base</h2><p>Get cited answers when your NVIDIA key is configured, or uncheck generation to search evidence only.</p></div><span className="brain-icon"><Sparkles size={24} /></span></div>
      <form onSubmit={submit}><label className="field-label" htmlFor="ask-collection">Collection</label><div className="select-wrap full"><Database size={17} /><select id="ask-collection" value={collectionId} onChange={e => chooseCollection(e.target.value)}><option value="">Select a collection</option>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={16} /></div>
        <label className="field-label ask-question-label" htmlFor="question">Your question</label><textarea id="question" placeholder="What do the documents say about…" maxLength={2000} rows={4} value={question} onChange={e => setQuestion(e.target.value)} />
        <div className="ask-options"><div className="segmented" role="group" aria-label="Retrieval mode"><button type="button" className={mode === 'hybrid' ? 'selected' : ''} onClick={() => setMode('hybrid')}><Sparkles size={14} /> Hybrid</button><button type="button" className={mode === 'baseline' ? 'selected' : ''} onClick={() => setMode('baseline')}><Search size={14} /> Baseline</button></div><label className="check-label"><input type="checkbox" checked={generate} onChange={e => setGenerate(e.target.checked)} /> Generate answer (send selected excerpts to NVIDIA)</label><label className="topk-label" htmlFor="top-k">Top K <select id="top-k" value={topK} onChange={e => setTopK(e.target.value)}>{[3, 5, 6, 10, 20].map(n => <option key={n}>{n}</option>)}</select></label></div>
        {readyDocs.length > 0 && <details className="filter-details"><summary><SlidersHorizontal size={15} /> Filter sources {filters.length > 0 && <span className="filter-count">{filters.length}</span>}</summary><div className="filter-options">{readyDocs.map(doc => <label key={doc.id}><input type="checkbox" checked={filters.includes(doc.id)} onChange={() => toggleFilter(doc.id)} />{doc.name}</label>)}</div></details>}
        {!config?.nvidiaConfigured && <div className="inline-tip slim"><HelpCircle size={16} /><span>Generation needs your NVIDIA key. Retrieval-only queries still work without it.</span></div>}
        <div className="ask-submit"><span><ShieldCheck size={15} /> Sources stay local during retrieval</span><button type="submit" className="button primary" disabled={!collectionId || !question.trim() || asking || readyDocs.length === 0}>{asking ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}{asking ? 'Searching…' : generate ? 'Ask & answer' : 'Search evidence'}</button></div>
      </form></div>
      {result ? <div className="surface answer-panel"><div className="answer-top"><div><span className="eyebrow">RESULT</span><h2>{result.question}</h2></div><span className={`answer-tag ${result.answerStatus}`}>{result.answerStatus?.replace('_', ' ')}</span></div><div className="answer-content"><div className="answer-icon"><Sparkles size={20} /></div><div>{result.answer ? <AnswerText answer={result.answer} sources={result.sources || []} citations={result.citations || []} onSource={focusSource} /> : <p className="answer-text muted">Retrieval-only result. Inspect the matching sources below or enable generation for a grounded answer.</p>}<div className="answer-meta"><span><Clock3 size={14} />{ms(result.latencyMs)}</span><span><BookOpen size={14} />{result.sources?.length || 0} sources</span><span><Layers3 size={14} />{result.mode}</span></div></div></div><div className="source-heading"><h3>Evidence & citations</h3><span>{result.sources?.length || 0} passages</span></div>{result.sources?.length ? <div className="source-list">{result.sources.map((source, i) => <article key={source.chunkId} ref={node => { sourceRefs.current[source.chunkId] = node; }} className={`source-card ${focusedSource === source.chunkId ? 'focused' : ''}`}><div className="source-top"><span className="source-index">S{i + 1}</span><div><strong>{source.documentName}</strong><span>{locationLabel(source.location)}</span></div><span className="source-score">{source.scores?.fusion != null ? `Fusion ${Number(source.scores.fusion).toFixed(3)}` : 'Matched'}</span></div><p>{source.snippet}</p><div className="score-row">{['lexical', 'semantic', 'fusion', 'rerank'].map(k => <span key={k}>{k}: {source.scores?.[k] == null ? '—' : Number(source.scores[k]).toFixed(3)}</span>)}</div></article>)}</div> : <Empty icon={Search} title="No evidence found" text="Try a different question or add more documents." />}</div> : <div className="ask-placeholder"><span><MessageCircle size={22} /></span><h3>Your answer will appear here</h3><p>Choose a collection and ask a question to see grounded results and retrieval steps.</p></div>}
    </section><aside className="ask-aside"><div className="surface trace-panel"><SectionHeading eyebrow="INSPECT" title="Retrieval trace" subtitle="See how evidence was selected." />{result?.trace?.stages?.length ? <><div className="trace-list">{result.trace.stages.map((stage, i) => <div className="trace-row" key={i}><span className="trace-step">{i + 1}</span><div><strong>{stage.name}</strong><small>{stage.candidateCount} candidates</small></div><span>{ms(stage.durationMs)}</span></div>)}</div><div className="trace-footer"><span>Reranker</span><strong>{result.trace.reranker?.replaceAll('-', ' ') || 'None'}</strong></div></> : <div className="aside-empty"><Activity size={25} /><p>Run a query to inspect each retrieval stage.</p></div>}</div><div className="surface history-panel"><SectionHeading eyebrow="SESSIONS" title="Recent questions" />{queries.length ? <div className="history-list">{queries.slice(0, 8).map(q => <button key={q.id} onClick={() => openHistory(q.id)}><MessageCircle size={15} /><span><strong>{q.question}</strong><small>{formatDate(q.createdAt)}</small></span></button>)}</div> : <p className="muted small-copy">Your recent questions will show here.</p>}</div></aside></div>;
}

function Evaluate({ collectionId, documents, cases, runs, refresh, showError, showSuccess }) {
  const [question, setQuestion] = useState('');
  const [expectedIds, setExpectedIds] = useState([]);
  const [answerable, setAnswerable] = useState(true);
  const [busy, setBusy] = useState('');
  const [selectedRun, setSelectedRun] = useState(null);
  const readyDocs = documents.filter(d => d.status === 'ready');
  const latestHybrid = runs.find(r => r.mode === 'hybrid');
  const latestBaseline = runs.find(r => r.mode === 'baseline');
  const comparable = Boolean(
    latestHybrid && latestBaseline &&
    latestHybrid.topK === latestBaseline.topK &&
    latestHybrid.caseSetFingerprint &&
    latestHybrid.caseSetFingerprint === latestBaseline.caseSetFingerprint &&
    latestHybrid.corpusFingerprint &&
    latestHybrid.corpusFingerprint === latestBaseline.corpusFingerprint
  );
  function toggleExpected(id) { setExpectedIds(previous => previous.includes(id) ? previous.filter(x => x !== id) : [...previous, id]); }
  async function addCase(event) {
    event.preventDefault();
    if (!collectionId || !question.trim() || (answerable && !expectedIds.length)) return;
    setBusy('case');
    try {
      await api('/evaluations/cases', { method: 'POST', body: { collectionId, question: question.trim(), expectedDocumentIds: answerable ? expectedIds : [], answerable } });
      setQuestion(''); setExpectedIds([]); await refresh(); showSuccess('Evaluation case added.');
    } catch (error) { showError(error); } finally { setBusy(''); }
  }
  async function deleteCase(id) {
    setBusy(id);
    try { await api(`/evaluations/cases/${id}`, { method: 'DELETE' }); await refresh(); showSuccess('Case removed.'); }
    catch (error) { showError(error); } finally { setBusy(''); }
  }
  async function run(mode) {
    setBusy(mode);
    try {
      const result = await api('/evaluations/runs', { method: 'POST', body: { collectionId, mode, topK: 6 } });
      setSelectedRun(result); await refresh(); showSuccess(`${mode === 'hybrid' ? 'Hybrid' : 'Baseline'} evaluation complete.`);
    } catch (error) { showError(error); } finally { setBusy(''); }
  }
  async function openRun(id) {
    try { setSelectedRun(await api(`/evaluations/runs/${id}`)); }
    catch (error) { showError(error); }
  }
  return <>
    <div className="eval-intro"><span className="eval-intro-icon"><FlaskConical size={24} /></span><div><h2>A quality loop you can explain.</h2><p>Run the same labeled questions through baseline and hybrid retrieval. Results are computed locally without NVIDIA calls.</p></div></div>
    {!collectionId ? <Empty icon={FlaskConical} title="Select a collection first" text="Create a collection and upload documents before adding evaluation cases." /> : <>
      <div className="eval-metrics"><Metric icon={BookOpen} title="Golden questions" value={cases.length} foot="Labeled test cases" accent="blue" /><Metric icon={Sparkles} title="Hybrid recall @ 6" value={percent(latestHybrid?.recallAtK)} foot={latestHybrid ? `Last run ${compactDate(latestHybrid.createdAt)}` : 'Run hybrid to measure'} accent="violet" /><Metric icon={Search} title="Baseline recall @ 6" value={percent(latestBaseline?.recallAtK)} foot={latestBaseline ? `Last run ${compactDate(latestBaseline.createdAt)}` : 'Run baseline to compare'} accent="cyan" /><Metric icon={Activity} title="Evaluation runs" value={runs.length} foot="Saved on this device" accent="orange" /></div>
      <div className="eval-grid"><section className="surface"><SectionHeading eyebrow="GOLDEN SET" title="Add a test question" subtitle="Mark the documents that should answer this question." /><form className="eval-form" onSubmit={addCase}><label className="field-label" htmlFor="eval-question">Question</label><textarea id="eval-question" rows={3} maxLength={2000} placeholder="What is the warranty period?" value={question} onChange={e => setQuestion(e.target.value)} /><label className="check-label"><input type="checkbox" checked={answerable} onChange={e => { setAnswerable(e.target.checked); if (e.target.checked === false) setExpectedIds([]); }} /> Answerable from this collection</label>{answerable && <div className="expected-docs"><strong>Expected source documents</strong>{readyDocs.length ? readyDocs.map(doc => <label key={doc.id}><input type="checkbox" checked={expectedIds.includes(doc.id)} onChange={() => toggleExpected(doc.id)} />{doc.name}</label>) : <p className="muted">Upload a ready document first.</p>}</div>}<button className="button primary" disabled={busy === 'case' || !question.trim() || (answerable && !expectedIds.length)}>{busy === 'case' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Add case</button></form></section><section className="surface"><SectionHeading eyebrow="BENCHMARK" title="Run a comparison" subtitle="Run both modes on the current cases and corpus." /><div className="strategy-card"><span className="strategy-icon hybrid"><Sparkles size={19} /></span><div><strong>Hybrid retrieval</strong><p>Lexical + semantic candidates, fusion, and reranking.</p></div><button className="button secondary small" onClick={() => run('hybrid')} disabled={!cases.length || !!busy}>{busy === 'hybrid' ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />} Run</button></div><div className="strategy-card"><span className="strategy-icon baseline"><Search size={19} /></span><div><strong>Keyword baseline</strong><p>Lexical retrieval only, for a simple comparison.</p></div><button className="button secondary small" onClick={() => run('baseline')} disabled={!cases.length || !!busy}>{busy === 'baseline' ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />} Run</button></div>{latestHybrid && latestBaseline && <div className="comparison-box">{comparable ? <><span>Recall @ {latestHybrid.topK} difference</span><strong>{((Number(latestHybrid.recallAtK || 0) - Number(latestBaseline.recallAtK || 0)) * 100).toFixed(1)} pts</strong><small>Matching question and corpus snapshots</small></> : <><span>Comparison unavailable</span><strong>Runs differ</strong><small>Run both modes again without changing cases or documents to compare fairly.</small></>}</div>}</section></div>
      <div className="eval-grid lower"><section className="surface"><SectionHeading eyebrow="TEST DATA" title="Question set" subtitle={`${cases.length} case${cases.length === 1 ? '' : 's'}`} />{cases.length ? <div className="case-list">{cases.map((item, i) => <div className="case-row" key={item.id}><span className="case-num">{String(i + 1).padStart(2, '0')}</span><div><strong>{item.question}</strong><small>{item.answerable ? `${item.expectedDocumentIds?.length || 0} expected document(s)` : 'Unanswerable · should abstain'}</small></div><IconButton icon={Trash2} label="Delete evaluation case" onClick={() => deleteCase(item.id)} disabled={busy === item.id} /></div>)}</div> : <Empty icon={BookOpen} title="No questions labeled" text="Add a case above to create a repeatable benchmark." />}</section><section className="surface"><SectionHeading eyebrow="HISTORY" title="Past runs" />{runs.length ? <div className="run-list">{runs.map(item => <button key={item.id} onClick={() => openRun(item.id)}><span className={`run-mode ${item.mode}`}>{item.mode === 'hybrid' ? <Sparkles size={15} /> : <Search size={15} />}</span><span><strong>{item.mode === 'hybrid' ? 'Hybrid retrieval' : 'Keyword baseline'}</strong><small>{formatDate(item.createdAt)} · {item.caseCount} cases</small></span><span className="run-recall">{percent(item.recallAtK)}</span><ChevronRight size={15} /></button>)}</div> : <Empty icon={FlaskConical} title="No runs yet" text="Run both strategies to compare their results." />}</section></div>
      {selectedRun && <section className="surface results-surface"><SectionHeading eyebrow="RUN DETAILS" title={`${selectedRun.mode === 'hybrid' ? 'Hybrid' : 'Baseline'} · ${formatDate(selectedRun.createdAt)}`} action={<div className="inline-actions"><button className="text-button" onClick={() => saveJSON(`pro-rag-eval-${selectedRun.mode}.json`, selectedRun)}><ArrowDownToLine size={15} /> Export JSON</button><IconButton icon={X} label="Close run details" onClick={() => setSelectedRun(null)} /></div>} /><div className="result-metrics"><span>Recall @ K <strong>{percent(selectedRun.recallAtK)}</strong></span><span>MRR <strong>{percent(selectedRun.mrr)}</strong></span><span>Citation validity <strong>{percent(selectedRun.citationValidity)}</strong></span><span>Abstention accuracy <strong>{percent(selectedRun.abstentionAccuracy)}</strong></span><span>Avg. latency <strong>{ms(selectedRun.averageLatencyMs)}</strong></span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Question</th><th>Hit</th><th>Rank</th><th>Citation</th><th>Abstention</th><th>Latency</th></tr></thead><tbody>{(selectedRun.results || []).map((item, i) => <tr key={item.caseId || i}><td><strong>{item.question}</strong>{item.error && <small className="error-text">{item.error}</small>}</td><td>{item.hit ? <span className="good-mark"><Check size={15} /> Yes</span> : <span className="bad-mark">No</span>}</td><td>{item.reciprocalRank ? Math.round(1 / item.reciprocalRank) : '—'}</td><td>{item.citationValid == null ? '—' : item.citationValid ? 'Valid' : 'Invalid'}</td><td>{item.abstentionCorrect == null ? '—' : item.abstentionCorrect ? 'Correct' : 'Incorrect'}</td><td>{ms(item.latencyMs)}</td></tr>)}</tbody></table></div></section>}
    </>}
  </>;
}

function Settings({ config, health }) {
  const ocrStatus = config?.ocrStatus || 'untested';
  const ocrDescription = ocrStatus === 'ready'
    ? 'Scanned PDF extraction tested successfully'
    : ocrStatus === 'unavailable'
      ? 'The last OCR attempt failed; inspect its document error'
      : 'Not checked yet; try OCR on a scanned PDF';
  return <div className="settings-grid"><section className="surface"><SectionHeading eyebrow="RUNTIME" title="Connection status" subtitle="A quick check of the services used by this workspace." /><div className="setting-row"><span className="setting-icon green"><Activity size={18} /></span><div><strong>Local API</strong><p>Runs on your computer</p></div><StatusPill status={health?.status === 'ok' ? 'ready' : 'failed'} /></div><div className="setting-row"><span className="setting-icon purple"><Sparkles size={18} /></span><div><strong>NVIDIA generation</strong><p>{config?.model || 'Model not configured'}</p></div><StatusPill status={config?.nvidiaConfigured ? 'ready' : 'failed'} /></div><div className="setting-row"><span className="setting-icon blue"><Layers3 size={18} /></span><div><strong>Local embeddings</strong><p>{config?.embeddingModel || 'Local model'}</p></div><StatusPill status={config?.embeddingStatus === 'ready' ? 'ready' : config?.embeddingStatus === 'loading' ? 'processing' : 'failed'} /></div><div className="setting-row"><span className="setting-icon amber"><FileText size={18} /></span><div><strong>Local OCR</strong><p>{ocrDescription}</p></div><StatusPill status={ocrStatus} /></div></section><section className="surface"><SectionHeading eyebrow="CAPABILITIES" title="Document support" subtitle="Parsers can vary in quality for complex layouts." /><div className="format-chips">{(config?.supportedFormats || ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'html']).map(f => <span key={f}>{String(f).toUpperCase()}</span>)}</div><div className="settings-callout"><HelpCircle size={18} /><div><strong>Extraction has limits</strong><p>Charts, handwriting, complex layouts, encrypted files, and low-quality scans can need manual review. Inspect indexed passages before relying on an answer.</p></div></div><div className="setting-facts"><span>Max file size <strong>{formatBytes(config?.uploadLimitBytes || 25 * 1048576)}</strong></span><span>Workspace <strong>Single user · Loopback</strong></span><span>Index <strong>Local</strong></span></div></section><section className="surface full-span"><SectionHeading eyebrow="PRIVACY" title="Where your data goes" subtitle="An explicit boundary for an interview-ready demo." /><div className="privacy-grid"><div><span className="privacy-illustration"><Database size={23} /></span><h3>Stays on this device</h3><p>Original files, extracted passages, embeddings, retrieval history, and evaluation results remain in the local workspace.</p></div><div className="privacy-arrow"><ArrowRight size={22} /></div><div><span className="privacy-illustration purple"><Sparkles size={23} /></span><h3>Sent only for generation</h3><p>When you enable answer generation, selected evidence and your question are sent to the configured NVIDIA endpoint using the server-side key.</p></div></div><div className="inline-tip slim"><ShieldCheck size={17} /><span>The API key is loaded from the backend environment and is never sent to this dashboard.</span></div></section></div>;
}
