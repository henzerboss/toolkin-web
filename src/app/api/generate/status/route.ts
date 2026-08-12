import { cors, guard, json } from '../../_shared';
import { getGenerationJob } from '@/lib/generationJobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req.headers.get('origin') ?? '') });
}

export async function GET(req: Request) {
  const g = await guard(req, { requireAccount: false, rateLimit: false });
  if (!g.ok) return g.response!;
  const { headers } = g;
  headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
  const appUserId = (req.headers.get('X-App-User-Id') ?? '').trim();
  if (!appUserId || appUserId.length > 128) return json({ error: 'missing_app_user_id' }, 400, headers);
  const jobId = new URL(req.url).searchParams.get('jobId')?.trim() ?? '';
  if (!jobId || jobId.length > 80) return json({ error: 'bad_request' }, 400, headers);

  const job = await getGenerationJob(appUserId, jobId);
  if (!job) return json({ error: 'generation_job_not_found' }, 404, headers);
  return json(job, 200, headers);
}
