import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Plan } from '@/app/api/_plan';

const TOKEN_VERSION = 2;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

interface PlanTokenPayload {
  v: number;
  exp: number;
  promptHash: string;
  locale: string;
  plan: Plan;
}

function secret(): string {
  // Keep existing deployments functional, but a dedicated signing key is strongly preferred.
  const value = process.env.TOOLKIN_PLAN_SECRET
    ?? process.env.TOOLKIN_GEMINI_API_KEY
    ?? process.env.RECIPE_GEMINI_API_KEY;
  if (!value) throw new Error('TOOLKIN_PLAN_SECRET missing');
  return value;
}

function promptHash(prompt: string, locale: string): string {
  return createHash('sha256').update(`${locale.trim()}\n${prompt.trim()}`, 'utf8').digest('base64url');
}

function signature(encodedPayload: string): string {
  return createHmac('sha256', secret()).update(encodedPayload, 'utf8').digest('base64url');
}

export function signPlanToken(prompt: string, locale: string, plan: Plan): string {
  const payload: PlanTokenPayload = {
    v: TOKEN_VERSION,
    exp: Date.now() + TOKEN_TTL_MS,
    promptHash: promptHash(prompt, locale),
    locale: locale.trim(),
    plan,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

export function verifyPlanToken(token: string, prompt: string, locale: string): Plan | null {
  const [encoded, supplied] = token.split('.');
  if (!encoded || !supplied || token.split('.').length !== 2) return null;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(signature(encoded), 'base64url');
    actual = Buffer.from(supplied, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<PlanTokenPayload>;
    if (payload.v !== TOKEN_VERSION || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (payload.locale !== locale.trim()) return null;
    if (payload.promptHash !== promptHash(prompt, locale)) return null;
    if (!payload.plan || typeof payload.plan !== 'object') return null;
    return payload.plan as Plan;
  } catch {
    return null;
  }
}
