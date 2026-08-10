import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://toolkin.app'),
  title: 'Toolkin — mini apps made to order',
  description:
    'Опишите нужную утилиту словами — Toolkin соберёт её за несколько секунд. Калькуляторы, таймеры, счётчики и трекеры под вашу задачу, без установки десятков приложений.',
  openGraph: {
    title: 'Toolkin — mini apps made to order',
    description: 'Опишите утилиту словами — получите работающее мини-приложение.',
    url: 'https://toolkin.app',
    siteName: 'Toolkin',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
