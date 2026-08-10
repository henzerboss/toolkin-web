import { cors, guard, json } from '../_shared';

export const runtime = 'nodejs';

type Platform = 'ios' | 'android';

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function parseVersion(version: string): number[] {
  return version
    .split(/[.+\-]/)
    .map((part) => Number.parseInt(part.replace(/\D/g, ''), 10))
    .filter((part) => Number.isFinite(part));
}

function compare(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < Math.max(av.length, bv.length, 3); i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

/**
 * Единый ответ для обеих платформ вместо iTunes Lookup на iOS и отсутствующего
 * API на Android. Версии задаются переменными окружения, поэтому баннер об
 * обновлении включается без выкатки бэкенда.
 *
 * isBlocking нужен для случая, когда сломался контракт API: старый клиент
 * получит экран «обновитесь», а не непонятную ошибку в середине генерации.
 */
export async function GET(req: Request) {
  const g = await guard(req, { requireAccount: false });
  if (!g.ok) return g.response!;
  const { headers } = g;

  const url = new URL(req.url);
  const platform = (url.searchParams.get('platform') ?? '').toLowerCase() as Platform;
  const current = (url.searchParams.get('version') ?? '').trim();

  if (platform !== 'ios' && platform !== 'android') {
    return json({ error: 'platform_required' }, 400, headers);
  }
  if (!current) return json({ error: 'version_required' }, 400, headers);

  const prefix = platform === 'ios' ? 'TOOLKIN_IOS' : 'TOOLKIN_ANDROID';
  const latestVersion = envValue(`${prefix}_LATEST_VERSION`) ?? current;
  const minimumVersion = envValue(`${prefix}_MIN_VERSION`);
  const storeUrl =
    envValue(`${prefix}_STORE_URL`) ??
    (platform === 'ios'
      ? 'https://apps.apple.com/app/id6799972749'
      : 'https://play.google.com/store/apps/details?id=store.evsi.toolkin');

  const updateAvailable = compare(current, latestVersion) < 0;
  const isBlocking = minimumVersion !== null && compare(current, minimumVersion) < 0;

  return json(
    {
      currentVersion: current,
      latestVersion,
      minimumVersion,
      updateAvailable,
      isBlocking,
      releaseNotes: envValue(`${prefix}_RELEASE_NOTES`),
      storeUrl,
    },
    200,
    headers,
  );
}
