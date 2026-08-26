import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ProjectProvider } from "@/context/ProjectContext";
import { isAnonymousExternal } from '@/lib/public-host';

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // "Public" = external host AND middleware did NOT stamp the authed header.
  // Once a user passes Basic Auth, isPublic flips to false and the UI behaves
  // exactly like localhost (full nav, admin link, etc).
  const isPublic = isAnonymousExternal(headers());
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="antialiased">
        <ProjectProvider isPublic={isPublic}>
          {children}
        </ProjectProvider>
      </body>
    </html>
  );
}
