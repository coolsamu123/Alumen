import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isAnonymousExternal } from '@/lib/public-host';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // Defense-in-depth: src/middleware.ts already returns 401 for unauthed
  // external clients before this layout runs. The redirect below only fires
  // if middleware was bypassed or disabled (and never for authed externals).
  if (isAnonymousExternal(headers())) redirect('/');
  return <>{children}</>;
}
