import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ProjectProvider } from "@/context/ProjectContext";
import { isAnonymousExternal, isPublicHost } from '@/lib/public-host';
import { getSession } from '@/lib/auth';

export const metadata: Metadata = {
  title: "Alumen — Portfolio Intelligence",
  description: "Air Liquide — Project intersection analysis",
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-icon.png',
  },
};

// Runs before React hydrates so the page never paints with the wrong theme.
// Reads localStorage('strom-theme'); falls back to prefers-color-scheme.
const THEME_BOOT = `
(function(){
  try {
    var t = localStorage.getItem('strom-theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // "Public" = external host AND middleware did NOT stamp the authed header.
  // Once a user passes Basic Auth, isPublic flips to false and the UI behaves
  // exactly like localhost (full nav, admin link, etc).
  const isPublic = isAnonymousExternal(headers());

  // Role drives Fase 4's per-button/per-view admin gating — distinct from
  // isPublic, which only distinguishes "no session at all" from "any
  // session." A logged-in basic user has isPublic=false (they passed the
  // session check) but is not an admin, which isPublic alone can't express.
  const session = await getSession();
  const role = session?.role ?? null;

  // isAdmin accounts for the local/SSH bypass (§2.4, still open): those
  // requests never touch middleware or a session cookie at all, but already
  // have unrestricted write access to every API today (middleware's
  // `!isPublicHost(host)` early-return applies there too). Gating Fase 4's
  // buttons on role alone would newly disable them for that path — a
  // regression, not a tightening. Treating "local" the same as "admin" here
  // keeps this purely cosmetic layer consistent with the server behavior it
  // mirrors.
  const isLocal = !isPublicHost(headers().get('host'));
  const isAdmin = isLocal || role === 'admin';

  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="antialiased">
        <ProjectProvider isPublic={isPublic} role={role} isAdmin={isAdmin}>
          {children}
        </ProjectProvider>
      </body>
    </html>
  );
}
