'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import UserMenu from '@/components/UserMenu';

type Role = 'admin' | 'basic';

interface ScopeRow {
  scope_type: 'dds' | 'project';
  scope_value: string;
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  auth_provider: 'local' | 'okta';
  role: Role;
  is_active: number;
  token_version: number;
  created_at: string;
  last_login_at: string | null;
  scopes: ScopeRow[];
  visibleCount: number | 'ALL';
}

interface ProjectLite {
  projectId: string;
  name: string;
  dds: string;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Create-user form
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('basic');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadUsers = async () => {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (res.ok) setUsers(data.users);
  };

  const loadProjects = async () => {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (res.ok && Array.isArray(data.projects)) {
      setProjects(data.projects.map((p: ProjectLite) => ({ projectId: p.projectId, name: p.name, dds: p.dds })));
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([loadUsers(), loadProjects()])
      .catch(() => setError('Could not load data.'))
      .finally(() => setLoading(false));
  }, []);

  const ddsOptions = useMemo(() => {
    const vals = new Set(projects.map(p => p.dds).filter(Boolean));
    return Array.from(vals).sort();
  }, [projects]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, name: newName, password: newPassword, role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create user.');
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      setNewRole('basic');
      setShowCreate(false);
      await loadUsers();
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Could not create user.');
    } finally {
      setCreating(false);
    }
  };

  const patchUser = async (id: number, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not update user.');
      return false;
    }
    await loadUsers();
    return true;
  };

  const handleToggleActive = (u: UserRow) => patchUser(u.id, { isActive: !u.is_active });

  const handleToggleRole = (u: UserRow) => {
    const nextRole: Role = u.role === 'admin' ? 'basic' : 'admin';
    if (!confirm(`Make ${u.email} ${nextRole === 'admin' ? 'an administrator' : 'basic'}?`)) return;
    patchUser(u.id, { role: nextRole });
  };

  const handleResetPassword = (u: UserRow) => {
    if (u.auth_provider !== 'local') {
      alert('Okta accounts do not use a local password.');
      return;
    }
    const pw = prompt(`New password for ${u.email} (minimum 8 characters):`);
    if (!pw) return;
    if (pw.length < 8) {
      alert('Password must be at least 8 characters.');
      return;
    }
    patchUser(u.id, { password: pw });
  };

  const handleDelete = async (u: UserRow) => {
    if (!confirm(`Remove ${u.email} permanently?`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not remove user.');
      return;
    }
    await loadUsers();
  };

  return (
    <div className="min-h-screen bg-bg">
      <div className="px-6 py-3.5 border-b border-line flex items-center gap-4 bg-surface">
        <a href="/admin" className="flex items-center gap-2.5 text-ink-1 no-underline">
          <img src="/icon-192.png" alt="Alumen" className="w-8 h-8 rounded-lg" />
          <span className="font-bold">Alumen</span>
          <span className="text-ink-muted text-sm font-normal">— User Management</span>
        </a>
        <div className="flex-1" />
        <a href="/admin" className="text-sm text-ink-4 hover:text-ink-1">← Admin</a>
        <UserMenu />
      </div>

      <div className="max-w-5xl mx-auto p-8 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-ink-1">Users</h1>
          <button
            onClick={() => setShowCreate(v => !v)}
            className="px-4 py-2 rounded-lg bg-accent-hover text-white text-sm font-semibold hover:bg-accent transition-colors"
          >
            {showCreate ? 'Cancel' : '+ New user'}
          </button>
        </div>

        {showCreate && (
          <form
            onSubmit={handleCreate}
            className="bg-surface-1 border border-line rounded-xl p-5 flex flex-col gap-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-4 mb-1">Work email</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  placeholder="first.last@airliquide.com"
                  className="w-full px-3 py-2 rounded-lg bg-surface-2 border border-line text-ink-1 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-4 mb-1">Nome</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-surface-2 border border-line text-ink-1 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-4 mb-1">Initial password</label>
                <input
                  type="text"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="minimum 8 characters"
                  className="w-full px-3 py-2 rounded-lg bg-surface-2 border border-line text-ink-1 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-4 mb-1">Perfil</label>
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value as Role)}
                  className="w-full px-3 py-2 rounded-lg bg-surface-2 border border-line text-ink-1 text-sm"
                >
                  <option value="basic">Basic</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            {createError && <p className="text-red-400 text-sm">{createError}</p>}
            <button
              type="submit"
              disabled={creating}
              className="self-start px-4 py-2 rounded-lg bg-accent-hover text-white text-sm font-semibold hover:bg-accent transition-colors disabled:opacity-50"
            >
              {creating ? 'Criando…' : 'Create user'}
            </button>
          </form>
        )}

        {loading ? (
          <p className="text-ink-muted text-sm">Loading…</p>
        ) : error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : (
          <div className="bg-surface-1 border border-line rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-4 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Perfil</th>
                  <th className="px-4 py-3 font-medium">Sees</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last login</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <UserRowView
                    key={u.id}
                    user={u}
                    projects={projects}
                    ddsOptions={ddsOptions}
                    expanded={expandedId === u.id}
                    onToggleExpand={() => setExpandedId(expandedId === u.id ? null : u.id)}
                    onToggleActive={() => handleToggleActive(u)}
                    onToggleRole={() => handleToggleRole(u)}
                    onResetPassword={() => handleResetPassword(u)}
                    onDelete={() => handleDelete(u)}
                    onScopeSaved={loadUsers}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function UserRowView({
  user,
  projects,
  ddsOptions,
  expanded,
  onToggleExpand,
  onToggleActive,
  onToggleRole,
  onResetPassword,
  onDelete,
  onScopeSaved,
}: {
  user: UserRow;
  projects: ProjectLite[];
  ddsOptions: string[];
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleActive: () => void;
  onToggleRole: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
  onScopeSaved: () => void;
}) {
  return (
    <>
      <tr className="border-b border-line last:border-0">
        <td className="px-4 py-3">
          <div className="text-ink-1 font-medium">{user.name || '—'}</div>
          <div className="text-ink-muted text-xs">{user.email}</div>
        </td>
        <td className="px-4 py-3">
          <span
            className={`px-2 py-0.5 rounded text-xs font-semibold ${
              user.role === 'admin'
                ? 'bg-accent-soft text-accent-text border border-accent-border'
                : 'bg-surface-2 text-ink-4 border border-line'
            }`}
          >
            {user.role === 'admin' ? 'Admin' : 'Basic'}
          </span>
        </td>
        <td className="px-4 py-3 text-ink-2">
          {user.role === 'admin' ? 'Tudo' : user.visibleCount === 'ALL' ? 'Tudo' : `${user.visibleCount} projetos`}
        </td>
        <td className="px-4 py-3">
          <span className={user.is_active ? 'text-green-400' : 'text-ink-faint'}>
            {user.is_active ? 'Ativo' : 'Desativado'}
          </span>
        </td>
        <td className="px-4 py-3 text-ink-muted text-xs">
          {user.last_login_at ? new Date(user.last_login_at + 'Z').toLocaleString() : 'Nunca'}
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {user.role === 'basic' && (
              <button
                onClick={onToggleExpand}
                className="text-xs px-2 py-1 rounded border border-line text-ink-3 hover:bg-surface-2"
              >
                {expanded ? 'Close scope' : 'Scope'}
              </button>
            )}
            <button
              onClick={onToggleRole}
              className="text-xs px-2 py-1 rounded border border-line text-ink-3 hover:bg-surface-2"
            >
              {user.role === 'admin' ? 'Make basic' : 'Make admin'}
            </button>
            <button
              onClick={onToggleActive}
              className="text-xs px-2 py-1 rounded border border-line text-ink-3 hover:bg-surface-2"
            >
              {user.is_active ? 'Desativar' : 'Reativar'}
            </button>
            <button
              onClick={onResetPassword}
              className="text-xs px-2 py-1 rounded border border-line text-ink-3 hover:bg-surface-2"
            >
              Reset password
            </button>
            <button
              onClick={onDelete}
              className="text-xs px-2 py-1 rounded border border-red-800/60 text-red-300 hover:bg-red-900/30"
            >
              Remove
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-line last:border-0 bg-surface-2/40">
          <td colSpan={6} className="px-4 py-4">
            <ScopeEditor
              user={user}
              projects={projects}
              ddsOptions={ddsOptions}
              onSaved={onScopeSaved}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ScopeEditor({
  user,
  projects,
  ddsOptions,
  onSaved,
}: {
  user: UserRow;
  projects: ProjectLite[];
  ddsOptions: string[];
  onSaved: () => void;
}) {
  const initialDds = user.scopes.filter(s => s.scope_type === 'dds').map(s => s.scope_value);
  const initialProjects = user.scopes.filter(s => s.scope_type === 'project').map(s => s.scope_value);

  const [selectedDds, setSelectedDds] = useState<Set<string>>(new Set(initialDds));
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set(initialProjects));
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  // Computed client-side from the already-fetched full project list (admin
  // sees everything), so the preview updates instantly with no extra
  // request — same resolution rule as src/lib/access.ts:
  // resolveScopedProjectIds, just run against a draft instead of what's
  // persisted.
  const previewCount = useMemo(() => {
    if (selectedDds.size === 0 && selectedProjects.size === 0) return 'ALL' as const;
    const ids = new Set<string>(selectedProjects);
    for (const p of projects) {
      if (selectedDds.has(p.dds)) ids.add(p.projectId);
    }
    return ids.size;
  }, [projects, selectedDds, selectedProjects]);

  const filteredProjects = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.trim().toLowerCase();
    return projects
      .filter(p => p.projectId.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .slice(0, 20);
  }, [projects, search]);

  const toggleDds = (value: string) => {
    setSelectedDds(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const toggleProject = (id: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/scopes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dds: Array.from(selectedDds), projects: Array.from(selectedProjects) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save scope.');
      onSaved();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not save scope.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-ink-2">
        With no grant at all, <strong>{user.name || user.email}</strong> sees the entire portfolio.
        Selecting anything below narrows their view to only what is checked.
      </div>

      <div>
        <div className="text-xs font-semibold text-ink-4 mb-2 uppercase tracking-wide">DDS</div>
        <div className="flex flex-wrap gap-2">
          {ddsOptions.map(dds => (
            <label
              key={dds}
              className={`text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer select-none ${
                selectedDds.has(dds)
                  ? 'bg-accent-soft border-accent-border text-accent-text'
                  : 'bg-surface-1 border-line text-ink-3'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedDds.has(dds)}
                onChange={() => toggleDds(dds)}
                className="hidden"
              />
              {dds}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-ink-4 mb-2 uppercase tracking-wide">
          Projetos avulsos ({selectedProjects.size} selecionado{selectedProjects.size === 1 ? '' : 's'})
        </div>
        {selectedProjects.size > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Array.from(selectedProjects).map(id => {
              const p = projects.find(pr => pr.projectId === id);
              return (
                <span
                  key={id}
                  className="text-xs px-2 py-1 rounded bg-surface-2 border border-line text-ink-2 flex items-center gap-1.5"
                >
                  {p ? `${p.projectId} — ${p.name}` : id}
                  <button onClick={() => toggleProject(id)} className="text-ink-faint hover:text-ink-1">
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search project by ID or name…"
          className="w-full px-3 py-2 rounded-lg bg-surface-1 border border-line text-ink-1 text-sm"
        />
        {filteredProjects.length > 0 && (
          <div className="mt-1 border border-line rounded-lg bg-surface-1 max-h-48 overflow-y-auto">
            {filteredProjects.map(p => (
              <button
                key={p.projectId}
                onClick={() => toggleProject(p.projectId)}
                className="w-full text-left px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2 flex items-center justify-between"
              >
                <span>
                  {p.projectId} — {p.name} <span className="text-ink-faint">({p.dds})</span>
                </span>
                {selectedProjects.has(p.projectId) && <span className="text-accent-text">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-accent-hover text-white text-sm font-semibold hover:bg-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save scope'}
        </button>
        <span className="text-sm text-ink-muted">
          Preview: {previewCount === 'ALL' ? 'the entire portfolio' : `${previewCount} project(s) visible`}
        </span>
      </div>
    </div>
  );
}
