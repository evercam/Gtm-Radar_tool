import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import './globals.css';
import AppShell from '@/components/shell/AppShell';
import AuthNotInstalled from '@/components/AuthNotInstalled';
import { ToastProvider } from '@/components/ui/Toast';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
  preload: false,
});

export const metadata: Metadata = {
  title: 'Evercam Source Hub',
  description: 'Sales intelligence and lead enrichment across construction, procurement, permits and energy sources.',
};

/**
 * Applies the stored theme before first paint. Without this the page renders
 * in the system theme and then snaps to the stored one — a visible flash on
 * every navigation. Kept inline and dependency-free so it runs synchronously,
 * ahead of any Next.js module.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        {/*
          A raw script, deliberately, despite React's dev warning that scripts
          in components "are never executed when rendering on the client".
          That is true and harmless here: this only ever needs to run in the
          server-rendered HTML, and the root layout is never re-rendered on the
          client.

          next/script with `beforeInteractive` is the documented alternative and
          is wrong for this one job — it emits the code as a STRING pushed onto
          `self.__next_s`, drained by the Next runtime after the framework
          bundle loads. That is before hydration but after first paint, which
          reintroduces exactly the theme flash this exists to prevent.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-background flex min-h-full flex-col">
        <ToastProvider>
          <AuthNotInstalled />
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
