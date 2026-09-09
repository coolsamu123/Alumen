'use client';

import { useState, useEffect } from 'react';
import UserMenu from '@/components/UserMenu';

const GEMINI_META = {
  label: 'Google Gemini',
  placeholder: 'AIza...',
  helpUrl: 'https://aistudio.google.com/apikey',
  helpLabel: 'aistudio.google.com/apikey',
};

type OutputLanguage = 'en' | 'fr';

export default function AdminPage() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-3-pro');
  const [outputLanguage, setOutputLanguage] = useState<OutputLanguage>('en');
  const [langStatus, setLangStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [geminiState, setGeminiState] = useState<{ masked: string; isConfigured: boolean }>({
    masked: 'Not configured',
    isConfigured: false,
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testResult, setTestResult] = useState('');
  const [upstreamStatus, setUpstreamStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [upstreamResult, setUpstreamResult] = useState('');
  const [stats, setStats] = useState<{ analyses: number; documents: number } | null>(null);

  // Service account state
  const [saSummary, setSaSummary] = useState<{
    isConfigured: boolean;
    clientEmail?: string;
    projectId?: string;
    privateKeyId?: string;
    updatedAt?: string;
  }>({ isConfigured: false });
  const [saStatus, setSaStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [saMessage, setSaMessage] = useState('');

  // Drive download state
  
    
  

  // Mappings state
  const [mappings, setMappings] = useState<{ domain: string; owner: string }[]>([]);
  const [newMappingDomain, setNewMappingDomain] = useState('');
  const [newMappingOwner, setNewMappingOwner] = useState('');
  const [mappingStatus, setMappingStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const refreshConfig = () => {
    fetch('/api/admin/config')
      .then(r => r.json())
      .then(data => {
        if (data.keys?.gemini) setGeminiState(data.keys.gemini);
        if (typeof data.model === 'string') setModel(data.model);
        if (data.outputLanguage === 'fr' || data.outputLanguage === 'en') setOutputLanguage(data.outputLanguage);
        setStats(data.stats || null);
      })
      .catch(() => {});
  };

  const handleLangChange = async (next: OutputLanguage) => {
    if (next === outputLanguage) return;
    const prev = outputLanguage;
    setOutputLanguage(next);
    setLangStatus('saving');
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputLanguage: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      // Leave the 'saved' banner up until the user makes another change — the
      // confirmation is the whole point of the panel; auto-dismissing it makes
      // people unsure whether their click actually persisted.
      setLangStatus('saved');
    } catch {
      setOutputLanguage(prev);
      setLangStatus('error');
    }
  };

  const refreshServiceAccount = () => {
    fetch('/api/admin/service-account')
      .then(r => r.json())
      .then(data => setSaSummary(data))
      .catch(() => {});
  };

  useEffect(() => {
    refreshConfig();
    refreshServiceAccount();

    // Fetch mappings
    fetch('/api/services/mapping')
      .then(r => r.json())
      .then(data => {
        if (data.mappings) setMappings(data.mappings);
      })
      .catch(() => {});
  }, []);

  

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setStatus('saving');
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setApiKey('');
      setStatus('saved');
      refreshConfig();
      setTimeout(() => setStatus('idle'), 3000);
    } catch (e: unknown) {
      setStatus('error');
      setTestResult(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const handleUpstreamTest = async () => {
    setUpstreamStatus('testing');
    setUpstreamResult('');
    try {
      const res = await fetch('/api/admin/upstream-test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      if (!data.ok) {
        // Surface Google's own message: a 403 here names the service account
        // address that has to be added to the CopyUtility folder.
        setUpstreamStatus('error');
        setUpstreamResult(data.error);
        return;
      }
      setUpstreamStatus('success');
      setUpstreamResult(
        `${data.total} row(s): ${data.byStage.copy} copy, ${data.byStage.cleanup} cleanup.\n` +
        data.sample
          .map((r: { projectId: string; stage: string; status: string; detail: Record<string, unknown> }) =>
            `  ${r.projectId} · ${r.stage} · ${r.status} · ${JSON.stringify(r.detail)}`)
          .join('\n')
      );
    } catch (e: unknown) {
      setUpstreamStatus('error');
      setUpstreamResult(e instanceof Error ? e.message : 'Test failed');
    }
  };

  const handleTest = async () => {
    setTestStatus('testing');
    setTestResult('');
    try {
      const res = await fetch('/api/admin/test-gemini', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTestStatus('success');
      setTestResult(data.message);
    } catch (e: unknown) {
      setTestStatus('error');
      setTestResult(e instanceof Error ? e.message : 'Test failed');
    }
  };

  const handleServiceAccountUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSaStatus('uploading');
    setSaMessage('');

    try {
      const text = await file.text();
      const res = await fetch('/api/admin/service-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setSaStatus('success');
      setSaMessage(`Saved. Service account: ${data.clientEmail}`);
      setSaSummary(data);
      setTimeout(() => setSaStatus('idle'), 3000);
    } catch (err: unknown) {
      setSaStatus('error');
      setSaMessage(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      e.target.value = '';
    }
  };

  const handleServiceAccountDelete = async () => {
    if (!confirm('Remove the saved service account key? Drive/Sheets features will stop working until you upload a new one.')) return;
    try {
      const res = await fetch('/api/admin/service-account', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setSaSummary({ isConfigured: false });
      setSaMessage('Service account key removed.');
      setSaStatus('success');
      setTimeout(() => setSaStatus('idle'), 3000);
    } catch (err: unknown) {
      setSaStatus('error');
      setSaMessage(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleSaveMappings = async (updatedMappings: { domain: string; owner: string }[]) => {
    setMappingStatus('saving');
    try {
      const res = await fetch('/api/services/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: updatedMappings }),
      });
      if (!res.ok) throw new Error('Save failed');
      setMappings(updatedMappings);
      setMappingStatus('saved');
      setTimeout(() => setMappingStatus('idle'), 3000);
    } catch {
      setMappingStatus('error');
    }
  };

  const handleAddMapping = () => {
    if (!newMappingDomain.trim() || !newMappingOwner.trim()) return;
    const updated = [...mappings, { domain: newMappingDomain.trim(), owner: newMappingOwner.trim() }];
    handleSaveMappings(updated);
    setNewMappingDomain('');
    setNewMappingOwner('');
  };

  const handleRemoveMapping = (index: number) => {
    const updated = mappings.filter((_, i) => i !== index);
    handleSaveMappings(updated);
  };

  const handleClearCache = async () => {
    if (!confirm('Clear all LLM analysis cache? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/admin/clear-cache', { method: 'POST' });
      const data = await res.json();
      setTestResult(`Cache cleared: ${data.deletedAnalyses} analyses, ${data.deletedDocuments} documents`);
      setStats({ analyses: 0, documents: 0 });
    } catch (e: unknown) {
      setTestResult(e instanceof Error ? e.message : 'Clear failed');
    }
  };

  const panelStyle: React.CSSProperties = {
    background: 'var(--surface-1)',
    border: '1px solid var(--surface-2)',
    borderRadius: 12,
    padding: 24,
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--border-strong)',
    color: 'var(--ink-2)',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 14,
    outline: 'none',
    flex: 1,
  };

  const btnPrimary: React.CSSProperties = {
    padding: '8px 20px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent-hover)',
    color: 'white',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  };

  const btnDanger: React.CSSProperties = {
    padding: '8px 20px',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    background: '#450a0a55',
    color: '#fca5a5',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  };

  const btnPurple: React.CSSProperties = {
    padding: '8px 20px',
    borderRadius: 6,
    border: 'none',
    background: '#6d28d9',
    color: 'white',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  };

  const chipStyle = (bg: string, color: string): React.CSSProperties => ({
    display: 'inline-block',
    padding: '4px 12px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    color: color,
    border: `1px solid ${color}33`,
  });

  return (
    <div style={{
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      background: 'var(--bg)',
      color: 'var(--ink-2)',
      minHeight: '100vh',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 24px',
        borderBottom: '1px solid var(--surface-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: 'var(--surface)',
      }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
          <img src="/icon-192.png" alt="Alumen" style={{ width: 40, height: 40, borderRadius: 8 }} />
          <div style={{ lineHeight: 1 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--ink-1)', letterSpacing: '-0.02em' }}>Alumen</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-4)', letterSpacing: '-0.02em' }}>— Portfolio Intelligence</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 4 }}>Air Liquide · Administration</div>
          </div>
        </a>
        <div style={{ flex: 1 }} />
        <a href="/" style={{
          padding: '6px 18px',
          borderRadius: 6,
          border: '1px solid var(--border-strong)',
          color: 'var(--ink-4)',
          fontSize: 13,
          fontWeight: 500,
          textDecoration: 'none',
        }}>
          Back to Dashboard
        </a>
        <UserMenu />
      </div>

      {/* Content */}
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* Target Catalog */}
        <a
          href="/admin/catalog"
          style={{
            ...panelStyle,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            textDecoration: 'none',
            color: 'inherit',
            transition: 'border-color 0.15s ease',
          }}
        >
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #7c3aed44, #0284c744)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}>
            ✦
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)' }}>Target Catalog</div>
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>
              Edit descriptions and role/impact-type bias hints for the 5 GIO Service Lines and 20 DDS Entities.
            </div>
          </div>
          <div style={{ fontSize: 18, color: 'var(--ink-faint)' }}>→</div>
        </a>

        {/* User Management */}
        <a
          href="/admin/users"
          style={{
            ...panelStyle,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            textDecoration: 'none',
            color: 'inherit',
            transition: 'border-color 0.15s ease',
          }}
        >
          <div style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'linear-gradient(135deg, #0284c744, #16a34a44)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}>
            👤
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)' }}>User Management</div>
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>
              Create accounts, grant admin, and scope basic users to specific DDS or projects.
            </div>
          </div>
          <div style={{ fontSize: 18, color: 'var(--ink-faint)' }}>→</div>
        </a>

        {/* Gemini Configuration */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Gemini Configuration</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 20 }}>
            The application uses Google Gemini ({model}) for AI-powered project impact analysis.
            The API key is stored in <code style={{ color: 'var(--ink-4)' }}>config.json</code>.
          </div>

          {/* Status */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 8 }}>CURRENT STATUS</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: geminiState.isConfigured ? '#22c55e' : '#ef4444',
              }} />
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                {geminiState.isConfigured
                  ? `Gemini key configured: ${geminiState.masked} · model ${model}`
                  : 'No Gemini key configured'}
              </span>
            </div>
          </div>

          {/* Input */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={GEMINI_META.placeholder}
              style={inputStyle}
            />
            <button
              onClick={handleSave}
              disabled={!apiKey.trim() || status === 'saving'}
              style={{ ...btnPrimary, opacity: !apiKey.trim() || status === 'saving' ? 0.4 : 1 }}
            >
              {status === 'saving' ? 'Saving...' : 'Save'}
            </button>
          </div>
          {status === 'saved' && (
            <div style={{ fontSize: 13, color: '#4ade80', marginBottom: 8 }}>API key saved successfully.</div>
          )}
          {status === 'error' && (
            <div style={{ fontSize: 13, color: '#f87171', marginBottom: 8 }}>{testResult}</div>
          )}
          <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
            Get your Gemini key at{' '}
            <a href={GEMINI_META.helpUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent-text-2)', textDecoration: 'underline' }}>
              {GEMINI_META.helpLabel}
            </a>
          </div>
        </div>

        {/* Output Language */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Output Language</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 20 }}>
            Language Gemini uses for free-form fields (summaries, narratives, deep dives).
            Canonical names (GIO services, DDS entities, tech tags, project IDs) and JSON keys
            always stay in English so downstream parsing keeps working. Goals and impact rows
            are stored per language — switching back to a language you previously analysed
            reuses that cached analysis instantly.
          </div>

          {/* Live status — mirrors the "CURRENT STATUS" pattern used by the Gemini panel. */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 8 }}>CURRENT STATUS</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: outputLanguage === 'fr' ? '#38bdf8' : '#22c55e',
              }} />
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                Active output language: <strong style={{ color: 'var(--ink-1)' }}>{outputLanguage === 'fr' ? 'Français (FR)' : 'English (EN)'}</strong>
                {' · '}
                <span style={{ color: 'var(--ink-muted)' }}>
                  written to <code style={{ color: 'var(--ink-4)' }}>config.json</code>; takes effect on the next analysis
                </span>
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            {([
              { value: 'en' as const, label: 'English', sub: 'EN' },
              { value: 'fr' as const, label: 'Français', sub: 'FR' },
            ]).map(opt => {
              const active = outputLanguage === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => handleLangChange(opt.value)}
                  disabled={langStatus === 'saving'}
                  style={{
                    flex: 1,
                    padding: '12px 16px',
                    borderRadius: 8,
                    border: `1px solid ${active ? 'var(--accent-hover)' : 'var(--border-strong)'}`,
                    background: active ? 'var(--accent-hover)' : 'var(--surface-2)',
                    color: active ? 'white' : 'var(--ink-3)',
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: langStatus === 'saving' ? 'default' : 'pointer',
                    opacity: langStatus === 'saving' ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 11, opacity: 0.7, fontFamily: "'DM Mono', monospace" }}>{opt.sub}</span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
          {langStatus === 'saving' && (
            <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 10 }}>Saving…</div>
          )}
          {langStatus === 'saved' && (
            <div style={{ fontSize: 13, color: '#4ade80', marginTop: 10 }}>
              ✓ Saved. New analyses will be generated in {outputLanguage === 'fr' ? 'French' : 'English'}.
              Previous analyses stay in their original language — re-run them to get the new translation.
            </div>
          )}
          {langStatus === 'error' && (
            <div style={{ fontSize: 13, color: '#f87171', marginTop: 10 }}>Could not save language preference.</div>
          )}
        </div>

        {/* Upstream (Apps Script control sheets) */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Upstream (Apps Script)</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16 }}>
            Reads the two control spreadsheets in the <code style={{ color: 'var(--ink-4)' }}>CopyUtility</code> folder
            to show stages 0–1 of the chain. Read-only — the Apps Script is the only writer.
          </div>
          <button onClick={handleUpstreamTest} disabled={upstreamStatus === 'testing'}
            style={{ ...btnPurple, opacity: upstreamStatus === 'testing' ? 0.5 : 1 }}>
            {upstreamStatus === 'testing' ? 'Testing...' : 'Test upstream'}
          </button>
          {upstreamStatus === 'success' && (
            <div style={{ marginTop: 14, background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: 12, fontSize: 13, color: '#86efac', whiteSpace: 'pre-wrap' }}>
              {upstreamResult}
            </div>
          )}
          {upstreamStatus === 'error' && (
            <div style={{ marginTop: 14, background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: 12, fontSize: 13, color: '#fca5a5', whiteSpace: 'pre-wrap' }}>
              {upstreamResult}
            </div>
          )}
        </div>

        {/* Test Connection */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Test Connection</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16 }}>
            Send a test prompt to verify your Gemini API key works.
          </div>
          <button onClick={handleTest} disabled={testStatus === 'testing'}
            style={{ ...btnPurple, opacity: testStatus === 'testing' ? 0.5 : 1 }}>
            {testStatus === 'testing' ? 'Testing...' : 'Test Gemini Connection'}
          </button>
          {testStatus === 'success' && (
            <div style={{ marginTop: 14, background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: 12, fontSize: 13, color: '#86efac' }}>
              {testResult}
            </div>
          )}
          {testStatus === 'error' && (
            <div style={{ marginTop: 14, background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: 12, fontSize: 13, color: '#fca5a5' }}>
              {testResult}
            </div>
          )}
        </div>

        {/* Service Account Key */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Google Service Account</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16 }}>
            Upload the JSON key for the service account that reads Google Drive folders and Google Sheets.
            Stored at <code style={{ color: 'var(--ink-4)' }}>data/service-account.json</code> with permissions <code style={{ color: 'var(--ink-4)' }}>0600</code>.
          </div>

          {/* Status */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 8 }}>CURRENT STATUS</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: saSummary.isConfigured ? 10 : 0 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: saSummary.isConfigured ? '#22c55e' : '#ef4444',
              }} />
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                {saSummary.isConfigured ? 'Service account configured' : 'No service account configured'}
              </span>
            </div>
            {saSummary.isConfigured && (
              <div style={{ fontSize: 12, color: 'var(--ink-4)', display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 20 }}>
                {saSummary.clientEmail && <div><span style={{ color: 'var(--ink-muted)' }}>Email: </span>{saSummary.clientEmail}</div>}
                {saSummary.projectId && <div><span style={{ color: 'var(--ink-muted)' }}>Project: </span>{saSummary.projectId}</div>}
                {saSummary.privateKeyId && <div><span style={{ color: 'var(--ink-muted)' }}>Key ID: </span>{saSummary.privateKeyId}</div>}
                {saSummary.updatedAt && <div><span style={{ color: 'var(--ink-muted)' }}>Updated: </span>{new Date(saSummary.updatedAt).toLocaleString()}</div>}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{
              ...btnPrimary,
              display: 'inline-block',
              opacity: saStatus === 'uploading' ? 0.5 : 1,
              cursor: saStatus === 'uploading' ? 'default' : 'pointer',
            }}>
              {saStatus === 'uploading' ? 'Uploading...' : (saSummary.isConfigured ? 'Replace Key' : 'Upload Key (JSON)')}
              <input
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={handleServiceAccountUpload}
                disabled={saStatus === 'uploading'}
              />
            </label>
            {saSummary.isConfigured && (
              <button onClick={handleServiceAccountDelete} style={btnDanger}>Remove Key</button>
            )}
          </div>

          {saMessage && (
            <div style={{
              marginTop: 14,
              background: saStatus === 'error' ? '#450a0a' : '#052e16',
              border: saStatus === 'error' ? '1px solid #7f1d1d' : '1px solid #166534',
              borderRadius: 8, padding: 12, fontSize: 13,
              color: saStatus === 'error' ? '#fca5a5' : '#86efac',
            }}>
              {saMessage}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 14, lineHeight: 1.6 }}>
            Generate a JSON key in{' '}
            <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent-text-2)', textDecoration: 'underline' }}>
              GCP IAM &rarr; Service Accounts
            </a>. Then share the target Drive folders/files with the service account email above.
          </div>
        </div>

        {/* Domain to Owner Mappings */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Service Domain Mappings</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16 }}>
            Map domains to owners so the application can join the local <strong style={{color: 'var(--ink-2)'}}>service_offering.csv</strong> file using the <strong style={{color: 'var(--ink-2)'}}>owned_by</strong> column.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {mappings.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, background: 'var(--surface-2)', padding: 10, borderRadius: 6, alignItems: 'center' }}>
                <div style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)' }}><strong>{m.domain}</strong> &rarr; {m.owner}</div>
                <button onClick={() => handleRemoveMapping(i)} style={{ ...btnDanger, padding: '4px 10px', fontSize: 11 }}>Remove</button>
              </div>
            ))}
            {mappings.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--ink-muted)', fontStyle: 'italic' }}>No mappings defined yet.</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <input
              type="text"
              placeholder="e.g. Security & Compliance"
              value={newMappingDomain}
              onChange={e => setNewMappingDomain(e.target.value)}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="e.g. Jean-Charles MARTIN"
              value={newMappingOwner}
              onChange={e => setNewMappingOwner(e.target.value)}
              style={inputStyle}
            />
            <button
              onClick={handleAddMapping}
              disabled={!newMappingDomain.trim() || !newMappingOwner.trim() || mappingStatus === 'saving'}
              style={{ ...btnPrimary, opacity: (!newMappingDomain.trim() || !newMappingOwner.trim() || mappingStatus === 'saving') ? 0.4 : 1 }}
            >
              Add
            </button>
          </div>
          {mappingStatus === 'saved' && (
            <div style={{ fontSize: 13, color: '#4ade80', marginTop: 10 }}>Mappings saved.</div>
          )}
        </div>

        {/* Cache */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 4 }}>Analysis Cache</div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16 }}>
            LLM results are cached to avoid repeated API calls.
          </div>
          {stats && (
            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>Cached Analyses</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink-1)', fontFamily: "'DM Mono', monospace" }}>{stats.analyses}</div>
              </div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>Cached Documents</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink-1)', fontFamily: "'DM Mono', monospace" }}>{stats.documents}</div>
              </div>
            </div>
          )}
          <button onClick={handleClearCache} style={btnDanger}>Clear Cache</button>
        </div>

        {/* How it works */}
        <div style={panelStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)', marginBottom: 16 }}>How Impact Analysis Works</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14 }}>
              <span style={chipStyle('#1e3a8a44', 'var(--accent-text-2)')}>1. BATCH ANALYSIS</span>
              <p style={{ fontSize: 13, color: 'var(--ink-4)', marginTop: 10, lineHeight: 1.6 }}>
                Go to the <strong style={{ color: 'var(--ink-2)' }}>Impact</strong> tab and click <strong style={{ color: 'var(--ink-2)' }}>Start Full Analysis</strong>.
                Gemini analyzes all projects in batches of ~22, grouped by DDS division, then cross-DDS.
              </p>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14 }}>
              <span style={chipStyle('#4a1d9644', '#c084fc')}>2. IMPACT DETECTION</span>
              <p style={{ fontSize: 13, color: 'var(--ink-4)', marginTop: 10, lineHeight: 1.6 }}>
                For each batch, Gemini identifies directed relationships: which project <strong style={{ color: 'var(--ink-2)' }}>blocks, enables, feeds data to, competes with, or requires coordination</strong> with another.
              </p>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14 }}>
              <span style={chipStyle('#052e1644', '#4ade80')}>3. SUB-APP INSIGHTS</span>
              <p style={{ fontSize: 13, color: 'var(--ink-4)', marginTop: 10, lineHeight: 1.6 }}>
                The engine now automatically pulls deep structured insights (8 dimensions like Digital Technologies, AI Embedded, Security) from the <strong style={{ color: 'var(--ink-2)' }}>Goals Extractor Sub-App</strong> to enhance the precision of the AI matching.
              </p>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14 }}>
              <span style={chipStyle('#431407', '#fb923c')}>4. CROSS-DDS</span>
              <p style={{ fontSize: 13, color: 'var(--ink-4)', marginTop: 10, lineHeight: 1.6 }}>
                After intra-DDS analysis, the engine takes the top projects from each division and analyzes
                <strong style={{ color: 'var(--ink-2)' }}> cross-organizational impacts</strong> — finding dependencies across Americas, APAC, EU, CF, etc.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
