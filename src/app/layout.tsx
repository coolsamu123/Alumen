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
// Reads localStorage('strom-theme') — 'dark' | 'paper' | 'ocean'; anything else
// (including nothing) means "follow the OS" via prefers-color-scheme. The
// retired 'light' and 'dim' are rewritten to 'paper' and 'dark'.
const THEME_BOOT = `
(function(){
  try {
    var t = localStorage.getItem('strom-theme');
    var legacy = { light: 'paper', dim: 'dark' };
    if (legacy[t]) { t = legacy[t]; localStorage.setItem('strom-theme', t); }
    if (t !== 'dark' && t !== 'paper' && t !== 'ocean') {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'dark';
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
  // Every rendered page is behind the session gate (middleware.ts, Fase 5),
  // so by the time this runs there is always a session — except on /login,
  // which renders through this layout before one exists. The provider derives
  // `role`/`isAdmin` from this; the header's user menu uses the name/email.
  const session = await getSession();

  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="antialiased">
        <ProjectProvider user={session}>
          {children}
        </ProjectProvider>
      </body>
    </html>
  );
}
