import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Defense-in-depth: src/middleware.ts already redirects/403s non-admins
  // before this layout runs. This is the same check at the route level, using
  // the authoritative session (rereads is_active/token_version from SQLite),
  // so a misconfigured middleware can't expose the admin pages on its own.
  const session = await getSession();
  if (session?.role !== 'admin') redirect('/');
  return <>{children}</>;
}
