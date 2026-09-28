import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import ThemeProvider from "@/components/ThemeProvider";
import { AuthThemeToggle } from "@/components/ThemeToggle";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "TradeJournal — MT5 Analytics",
  description: "Automated trade journal synced directly from your MetaTrader 5 account. Track P&L, win rate, drawdown, and more.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const themeScript = `(() => { try { const saved = localStorage.getItem('trade-journal-theme') || 'system'; const resolved = saved === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : saved; document.documentElement.dataset.theme = resolved; document.documentElement.style.colorScheme = resolved; if (localStorage.getItem('tj-sidebar') === 'collapsed') document.documentElement.dataset.sidebar = 'collapsed'; } catch (_) {} })();`;
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>
        <ThemeProvider>
          <AuthThemeToggle />
          <div className="app-shell">
            <Sidebar />
            <main className="main-content">
              {children}
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
