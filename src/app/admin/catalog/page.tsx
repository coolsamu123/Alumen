'use client';

import { useEffect, useMemo, useState } from 'react';

type TargetKind = 'gio' | 'dds';

interface CatalogEntry {
  name: string;
  description: string;
  typicalRoles?: string[];
  typicalImpactTypes?: string[];
}

interface CatalogPayload {
  gio: CatalogEntry[];
  dds: CatalogEntry[];
  vocab: { roles: string[]; impactTypes: string[] };
}

interface Draft {
  description: string;
  typicalRoles: string[];
  typicalImpactTypes: string[];
}

const DDS_GROUPS: { title: string; subtitle: string; members: string[] }[] = [
  {
    title: 'Geographic Zones',
    subtitle: 'Regional "centers of gravity" for digital governance.',
    members: ['Americas', 'Europe', 'APAC', 'AMEI'],
  },
  {
    title: 'Business Divisions & SBUs',
    subtitle: 'Specialised Digital Delivery Services (DDS) or World Business Lines (WBLs).',
    members: ['CF', 'GM&T', 'E&C', 'HC D&IT', 'Alizent', 'GDO', 'SEPPIC', 'Airgas', 'HHC'],
  },
  {
    title: 'App & Functional Groups',
    subtitle: 'Delivery units and governance structures within Global Digital Services (GDS).',
    members: ['Industrial Apps', 'Enterprise Apps', 'Data & AI Apps', 'Digital Factory', 'InnoTech', 'CDIO Office', 'IDD'],
  },
];

const ROLE_HELP: Record<string, string> = {
  primary_provider: 'Project provides this target as its main output.',
  downstream_consumer: 'Project consumes capabilities of the target.',
  regional_executor: 'Project executes a rollout in the target region/division.',
  risk_owner: 'Target owns risks introduced or affected by the project.',
  blocked_by: 'Project is blocked by something the target controls.',
};

const KIND_LABEL: Record<TargetKind, string> = {
  gio: 'GIO Service Lines',
  dds: 'DDS Entities',
};

function draftKey(kind: TargetKind, name: string) {
  return `${kind}::${name}`;
}

function isSameStringList(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toDraft(entry: CatalogEntry): Draft {
  return {
    description: entry.description ?? '',
    typicalRoles: [...(entry.typicalRoles ?? [])],
    typicalImpactTypes: [...(entry.typicalImpactTypes ?? [])],
  };
}

export default function CatalogAdminPage() {
  const [data, setData] = useState<CatalogPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [activeKind, setActiveKind] = useState<TargetKind>('gio');
  const [customImpact, setCustomImpact] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/catalog')
      .then(r => r.json())
      .then(payload => {
        if (cancelled) return;
        if (payload.error) {
          setLoadError(payload.error);
          return;
        }
        setData(payload);
        const next: Record<string, Draft> = {};
        for (const e of payload.gio as CatalogEntry[]) next[draftKey('gio', e.name)] = toDraft(e);
        for (const e of payload.dds as CatalogEntry[]) next[draftKey('dds', e.name)] = toDraft(e);
        setDrafts(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load catalog');
      });
    return () => { cancelled = true; };
  }, []);

  const entries = useMemo(() => data ? data[activeKind] : [], [data, activeKind]);

  const updateDraft = (kind: TargetKind, name: string, patch: Partial<Draft>) => {
    const key = draftKey(kind, name);
    setDrafts(prev => ({
      ...prev,
      [key]: { ...prev[key], ...patch },
    }));
    setSaved(prev => ({ ...prev, [key]: false }));
    setErrors(prev => ({ ...prev, [key]: '' }));
  };

  const isDirty = (kind: TargetKind, name: string): boolean => {
    if (!data) return false;
    const server = data[kind].find(e => e.name === name);
    const draft = drafts[draftKey(kind, name)];
    if (!server || !draft) return false;
    if (server.description !== draft.description) return true;
    if (!isSameStringList(server.typicalRoles ?? [], draft.typicalRoles)) return true;
    if (!isSameStringList(server.typicalImpactTypes ?? [], draft.typicalImpactTypes)) return true;
    return false;
  };

  const handleReset = (kind: TargetKind, name: string) => {
    if (!data) return;
    const server = data[kind].find(e => e.name === name);
    if (!server) return;
    setDrafts(prev => ({ ...prev, [draftKey(kind, name)]: toDraft(server) }));
    setSaved(prev => ({ ...prev, [draftKey(kind, name)]: false }));
    setErrors(prev => ({ ...prev, [draftKey(kind, name)]: '' }));
  };

  const handleSave = async (kind: TargetKind, name: string) => {
    const key = draftKey(kind, name);
    const draft = drafts[key];
    if (!draft) return;
    setSaving(prev => ({ ...prev, [key]: true }));
    setSaved(prev => ({ ...prev, [key]: false }));
    setErrors(prev => ({ ...prev, [key]: '' }));
    try {
      const res = await fetch('/api/admin/catalog', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          name,
          description: draft.description,
          typicalRoles: draft.typicalRoles,
          typicalImpactTypes: draft.typicalImpactTypes,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      // Replace the server entry with the returned one so isDirty resets cleanly.
      setData(prev => {
        if (!prev) return prev;
        const list = prev[kind].map(e => e.name === name ? (json.entry as CatalogEntry) : e);
        return { ...prev, [kind]: list };
      });
      setDrafts(prev => ({ ...prev, [key]: toDraft(json.entry as CatalogEntry) }));
      setSaved(prev => ({ ...prev, [key]: true }));
      setTimeout(() => {
        setSaved(prev => ({ ...prev, [key]: false }));
      }, 2500);
    } catch (e: unknown) {
      setErrors(prev => ({ ...prev, [key]: e instanceof Error ? e.message : 'Save failed' }));
    } finally {
      setSaving(prev => ({ ...prev, [key]: false }));
    }
  };

  const toggleRole = (kind: TargetKind, name: string, role: string) => {
    const key = draftKey(kind, name);
    const draft = drafts[key];
    if (!draft) return;
    const next = draft.typicalRoles.includes(role)
      ? draft.typicalRoles.filter(r => r !== role)
      : [...draft.typicalRoles, role];
    updateDraft(kind, name, { typicalRoles: next });
  };

  const toggleImpact = (kind: TargetKind, name: string, value: string) => {
    const key = draftKey(kind, name);
    const draft = drafts[key];
    if (!draft) return;
    const next = draft.typicalImpactTypes.includes(value)
      ? draft.typicalImpactTypes.filter(r => r !== value)
      : [...draft.typicalImpactTypes, value];
    updateDraft(kind, name, { typicalImpactTypes: next });
  };

  const addCustomImpact = (kind: TargetKind, name: string) => {
    const key = draftKey(kind, name);
    const raw = (customImpact[key] || '').trim();
    if (!raw) return;
    const draft = drafts[key];
    if (!draft) return;
    if (draft.typicalImpactTypes.includes(raw)) {
      setCustomImpact(prev => ({ ...prev, [key]: '' }));
      return;
    }
    updateDraft(kind, name, { typicalImpactTypes: [...draft.typicalImpactTypes, raw] });
    setCustomImpact(prev => ({ ...prev, [key]: '' }));
  };

  if (loadError) {
    return (
      <div style={{ padding: 40, fontFamily: "'DM Sans', sans-serif", color: 'var(--ink-2)' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Failed to load catalog</div>
        <div style={{ marginTop: 8, color: '#f87171' }}>{loadError}</div>
        <a href="/admin" style={{ marginTop: 24, display: 'inline-block', color: 'var(--accent-text-2)' }}>← Back to admin</a>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 40, fontFamily: "'DM Sans', sans-serif", color: 'var(--ink-muted)' }}>
        Loading catalog…
      </div>
    );
  }

  const dirtyCount = (kind: TargetKind) =>
    (data[kind] as CatalogEntry[]).filter(e => isDirty(kind, e.name)).length;

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
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
          <img src="/icon-192.png" alt="Alumen" style={{ width: 40, height: 40, borderRadius: 8 }} />
          <div style={{ lineHeight: 1 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--ink-1)', letterSpacing: '-0.02em' }}>Alumen</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-4)', letterSpacing: '-0.02em' }}>— Target Catalog</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 4 }}>Air Liquide · GIO Service Lines & DDS Entities</div>
          </div>
        </a>
        <div style={{ flex: 1 }} />
        <a href="/admin" style={{
          padding: '6px 18px',
          borderRadius: 6,
          border: '1px solid var(--border-strong)',
          color: 'var(--ink-4)',
          fontSize: 13,
          fontWeight: 500,
          textDecoration: 'none',
        }}>
          ← Back to Admin
        </a>
      </div>

      <div style={{ maxWidth: 880, margin: '0 auto', padding: '28px 24px 80px' }}>

        {/* Intro */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink-1)', letterSpacing: '-0.02em', marginBottom: 6 }}>
            Target Catalog
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
            Canonical definitions of the GIO Service Lines and DDS Entities used by the Impact engine
            and Deep Dive prompts. Edit the description and the role/impact-type bias hints; the
            <strong style={{ color: 'var(--ink-2)' }}> name</strong> field is read-only — it must match
            the canonical strings used by <code style={{ color: 'var(--ink-4)' }}>prompts.ts</code> and
            the goals extractor, and renaming would corrupt existing impact rows.
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--surface-2)' }}>
          {(['gio', 'dds'] as const).map(kind => {
            const active = activeKind === kind;
            const dirty = dirtyCount(kind);
            return (
              <button
                key={kind}
                onClick={() => setActiveKind(kind)}
                style={{
                  padding: '12px 18px',
                  fontSize: 14,
                  fontWeight: 600,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: active ? '2px solid var(--accent-hover)' : '2px solid transparent',
                  color: active ? 'var(--ink-1)' : 'var(--ink-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: -1,
                }}
              >
                <span>{KIND_LABEL[kind]}</span>
                <span style={{
                  background: 'var(--surface-2)',
                  color: 'var(--ink-4)',
                  borderRadius: 10,
                  padding: '1px 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "'DM Mono', monospace",
                }}>
                  {data[kind].length}
                </span>
                {dirty > 0 && (
                  <span style={{
                    background: '#f59e0b22',
                    color: '#f59e0b',
                    borderRadius: 10,
                    padding: '1px 8px',
                    fontSize: 11,
                    fontWeight: 700,
                  }}>
                    {dirty} unsaved
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Cards */}
        {activeKind === 'gio' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {entries.map(entry => renderCard('gio', entry))}
          </div>
        )}

        {activeKind === 'dds' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            {DDS_GROUPS.map(group => {
              const members = entries.filter(e => group.members.includes(e.name));
              if (members.length === 0) return null;
              return (
                <div key={group.title}>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--ink-faint)',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}>
                      {group.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4 }}>{group.subtitle}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {members.map(entry => renderCard('dds', entry))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  function renderCard(kind: TargetKind, entry: CatalogEntry) {
    const key = draftKey(kind, entry.name);
    const draft = drafts[key];
    if (!draft) return null;
    const dirty = isDirty(kind, entry.name);
    const isSaving = !!saving[key];
    const isSaved = !!saved[key];
    const err = errors[key];

    return (
      <div
        key={entry.name}
        style={{
          background: 'var(--surface-1)',
          border: `1px solid ${dirty ? '#f59e0b66' : 'var(--surface-2)'}`,
          borderRadius: 12,
          padding: 20,
          transition: 'border-color 0.15s ease',
        }}
      >
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)' }}>{entry.name}</div>
          <span style={{
            padding: '2px 8px',
            borderRadius: 4,
            background: 'var(--surface-2)',
            color: 'var(--ink-faint)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}>
            canonical · read-only
          </span>
          {dirty && (
            <span style={{
              padding: '2px 8px',
              borderRadius: 4,
              background: '#f59e0b22',
              color: '#f59e0b',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}>
              modified
            </span>
          )}
        </div>

        {/* Description */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
            DESCRIPTION
          </div>
          <textarea
            value={draft.description}
            onChange={e => updateDraft(kind, entry.name, { description: e.target.value })}
            rows={Math.max(3, Math.min(8, draft.description.split('\n').length + 1))}
            placeholder="1–3 sentences. Used by Deep Dive prompts to ground the LLM on what this target actually covers."
            style={{
              width: '100%',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-strong)',
              color: 'var(--ink-2)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
              lineHeight: 1.55,
              outline: 'none',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 4 }}>
            {draft.description.length} chars
          </div>
        </div>

        {/* Roles */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 8 }}>
            TYPICAL ROLES
            <span style={{ marginLeft: 8, color: 'var(--ink-muted)', fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>
              — bias the Goals LLM toward these roles when this target shows up. Empty = no bias.
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data!.vocab.roles.map(role => {
              const active = draft.typicalRoles.includes(role);
              return (
                <button
                  key={role}
                  onClick={() => toggleRole(kind, entry.name, role)}
                  title={ROLE_HELP[role] || role}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: `1px solid ${active ? '#7c3aed' : 'var(--border-strong)'}`,
                    background: active ? '#7c3aed22' : 'var(--surface-2)',
                    color: active ? '#c084fc' : 'var(--ink-4)',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "'DM Mono', monospace",
                    cursor: 'pointer',
                    transition: 'all 0.1s ease',
                  }}
                >
                  {active ? '✓ ' : ''}{role}
                </button>
              );
            })}
          </div>
        </div>

        {/* Impact types */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 10, color: 'var(--ink-faint)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 8 }}>
            TYPICAL IMPACT TYPES
            <span style={{ marginLeft: 8, color: 'var(--ink-muted)', fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>
              — bias hints for the Impact engine. Empty = no bias.
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {data!.vocab.impactTypes.map(type => {
              const active = draft.typicalImpactTypes.includes(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleImpact(kind, entry.name, type)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: `1px solid ${active ? '#0284c7' : 'var(--border-strong)'}`,
                    background: active ? '#0284c722' : 'var(--surface-2)',
                    color: active ? '#38bdf8' : 'var(--ink-4)',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "'DM Mono', monospace",
                    cursor: 'pointer',
                    transition: 'all 0.1s ease',
                  }}
                >
                  {active ? '✓ ' : ''}{type}
                </button>
              );
            })}
            {/* Custom impact types (anything saved that isn't in the canonical vocab) */}
            {draft.typicalImpactTypes.filter(t => !data!.vocab.impactTypes.includes(t)).map(type => (
              <button
                key={type}
                onClick={() => toggleImpact(kind, entry.name, type)}
                style={{
                  padding: '5px 10px',
                  borderRadius: 6,
                  border: '1px solid #f59e0b',
                  background: '#f59e0b22',
                  color: '#fbbf24',
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "'DM Mono', monospace",
                  cursor: 'pointer',
                }}
                title="Custom value (not in the canonical impact_type vocabulary). Click to remove."
              >
                ✓ {type} ✕
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              placeholder="Add custom impact_type…"
              value={customImpact[key] || ''}
              onChange={e => setCustomImpact(prev => ({ ...prev, [key]: e.target.value }))}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustomImpact(kind, entry.name);
                }
              }}
              style={{
                flex: 1,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                color: 'var(--ink-2)',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                fontFamily: "'DM Mono', monospace",
                outline: 'none',
              }}
            />
            <button
              onClick={() => addCustomImpact(kind, entry.name)}
              disabled={!(customImpact[key] || '').trim()}
              style={{
                padding: '5px 12px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--surface-2)',
                color: 'var(--ink-3)',
                fontSize: 12,
                fontWeight: 600,
                cursor: (customImpact[key] || '').trim() ? 'pointer' : 'default',
                opacity: (customImpact[key] || '').trim() ? 1 : 0.4,
              }}
            >
              + Add
            </button>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 20,
          paddingTop: 14,
          borderTop: '1px solid var(--surface-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <div style={{ flex: 1, fontSize: 12 }}>
            {err && <span style={{ color: '#f87171' }}>⚠ {err}</span>}
            {!err && isSaved && <span style={{ color: '#4ade80' }}>✓ Saved.</span>}
            {!err && !isSaved && dirty && <span style={{ color: '#f59e0b' }}>Unsaved changes.</span>}
            {!err && !isSaved && !dirty && <span style={{ color: 'var(--ink-faint)' }}>In sync with disk.</span>}
          </div>
          <button
            onClick={() => handleReset(kind, entry.name)}
            disabled={!dirty || isSaving}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'transparent',
              color: 'var(--ink-muted)',
              fontSize: 12,
              fontWeight: 600,
              cursor: dirty && !isSaving ? 'pointer' : 'default',
              opacity: dirty && !isSaving ? 1 : 0.4,
            }}
          >
            Reset
          </button>
          <button
            onClick={() => handleSave(kind, entry.name)}
            disabled={!dirty || isSaving}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: dirty && !isSaving ? 'var(--accent-hover)' : 'var(--surface-2)',
              color: dirty && !isSaving ? 'white' : 'var(--ink-faint)',
              fontSize: 13,
              fontWeight: 700,
              cursor: dirty && !isSaving ? 'pointer' : 'default',
            }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }
}
