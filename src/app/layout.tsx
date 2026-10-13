import type { Metadata } from "next";
import "./globals.css";
import { ProjectProvider } from "@/context/ProjectContext";
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
// Reads localStorage('strom-theme') — 'airliquide' | 'dark' | 'paper' | 'ocean',
// or 'system' to follow the OS via prefers-color-scheme. Nothing stored means
// the default, Air Liquide. The retired 'light' and 'dim' are rewritten to
// 'paper' and 'dark'.
const THEME_BOOT = `
(function(){
  try {
    var t = localStorage.getItem('strom-theme');
    var legacy = { light: 'paper', dim: 'dark' };
    if (legacy[t]) { t = legacy[t]; localStorage.setItem('strom-theme', t); }
    if (t === 'system') {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'dark';
    } else if (t !== 'airliquide' && t !== 'dark' && t !== 'paper' && t !== 'ocean') {
      t = 'airliquide';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'airliquide');
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Every rendered page is behind the session gate (middleware.ts, Fase 5),
  // so by the time this runs there is always a session — except on /login,
  // which renders through this layout before one exists. The provider derives
  // `role`/`isAdmin` from this; the header's user menu uses the name/email.
  const session = await getSession();

  return (
    <html lang="en" data-theme="airliquide">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {/* Theme fonts. A link, not an @import in globals.css: the bundler puts
            Tailwind's base before it, and browsers ignore an @import that isn't first. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700;800&family=Roboto:wght@400;500;700;900&family=Roboto+Slab:wght@400;500;600;700;800&display=swap" />
      </head>
      <body className="antialiased">
        <ProjectProvider user={session}>
          {children}
        </ProjectProvider>
      </body>
    </html>
  );
}
