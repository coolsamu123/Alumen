'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no login.');
      router.push('/');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Falha no login.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <form
        onSubmit={handleSubmit}
        className="bg-surface-1 border border-line rounded-xl p-8 w-full max-w-sm"
      >
        <div className="flex items-center gap-2 mb-6">
          <img src="/icon-192.png" alt="Alumen" className="w-9 h-9 rounded-lg" />
          <div>
            <div className="text-lg font-extrabold text-ink-1 leading-none">Alumen</div>
            <div className="text-xs text-ink-muted mt-0.5">Entrar</div>
          </div>
        </div>

        <label className="block text-xs font-medium text-ink-4 mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded-lg bg-surface-2 border border-line text-ink-1 text-sm outline-none focus:border-accent-border"
          required
          autoFocus
          autoComplete="username"
        />

        <label className="block text-xs font-medium text-ink-4 mb-1">Senha</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded-lg bg-surface-2 border border-line text-ink-1 text-sm outline-none focus:border-accent-border"
          required
          autoComplete="current-password"
        />

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-accent-hover text-white text-sm font-semibold hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
