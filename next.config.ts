import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Ответы API нигде не кэшируются: баланс кредитов и версия в сторе
        // меняются в реальном времени, а промежуточный кэш CDN отдал бы
        // пользователю чужой или устаревший баланс.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default config;
