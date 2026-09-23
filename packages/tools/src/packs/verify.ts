import { z } from 'zod';
import { builtinDetection, failure, operation, type OperationContext, type OperationResult, type ToolProvider } from '../sdk.js';
import { checkPage } from './browser.js';
import { waitForHttp } from './http.js';

/**
 * Real end-to-end verification (V2 plan §21): start the app, wait until it
 * is healthy, look at it in a real browser (or hit its HTTP endpoints),
 * collect evidence, stop the app. The orchestrator's `verify` stage and
 * agents use the same operation.
 */

export const webVerifyInput = z.object({
  startCommand: z.string().min(1).max(2000).optional().describe('Command that starts the app (omit when it is already running).'),
  url: z.string().url().max(1000).describe('Base URL the app serves, e.g. http://127.0.0.1:5173'),
  paths: z.array(z.string().max(500).regex(/^\//)).min(1).max(20).default(['/']),
  viewports: z.array(z.enum(['desktop', 'phone', 'tablet'])).min(1).max(3).default(['desktop', 'phone']),
  readyTimeoutSec: z.number().int().min(5).max(600).default(120),
  mode: z.enum(['browser', 'http']).default('browser'),
  expectStatus: z.number().int().optional(),
});
export type WebVerifyInput = z.infer<typeof webVerifyInput>;

export async function verifyWeb(input: WebVerifyInput, ctx: OperationContext): Promise<OperationResult> {
  const evidence: string[] = [];
  const artifacts: Array<{ id: string; name: string }> = [];
  let processId: string | null = null;
  const port = Number(new URL(input.url).port || (input.url.startsWith('https') ? 443 : 80));
  try {
    if (input.startCommand) {
      if (!ctx.processes) return failure('UNAVAILABLE', 'Starting the app needs task processes');
      const proc = await ctx.processes.start({ name: 'app under test', command: input.startCommand, cwd: ctx.cwd, port, readyUrl: input.url, readyTimeoutSec: input.readyTimeoutSec });
      processId = proc.id;
      evidence.push(`started "${input.startCommand}" → ${proc.status}`);
      if (proc.status !== 'healthy') {
        const tail = ctx.processes.logs(proc.id, 40);
        return failure('FAILED', `The app did not become healthy at ${input.url} within ${input.readyTimeoutSec}s (${proc.status})`, { evidence, stdout: tail.join('\n') });
      }
    } else {
      const health = await waitForHttp(input.url, { timeoutMs: input.readyTimeoutSec * 1000, signal: ctx.signal });
      if (!health.ok) return failure('FAILED', `${input.url} is not answering: ${health.lastError}`, { evidence: [`health ${input.url} → ${health.lastError}`] });
      evidence.push(`health ${input.url} → HTTP ${health.status}`);
    }

    const problems: string[] = [];
    const pages: unknown[] = [];
    for (const p of input.paths) {
      const url = new URL(p, input.url).toString();
      if (input.mode === 'http') {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((e: Error) => e);
        if (res instanceof Error) {
          problems.push(`${p}: ${res.message}`);
          evidence.push(`GET ${p} → failed`);
          continue;
        }
        await res.arrayBuffer();
        const bad = input.expectStatus ? res.status !== input.expectStatus : res.status >= 500;
        if (bad) problems.push(`${p}: HTTP ${res.status}`);
        evidence.push(`GET ${p} → ${res.status}`);
        continue;
      }
      const result = await checkPage(ctx, { url, viewports: input.viewports, waitUntil: 'load', settleMs: 800, sameOriginOnly: true, screenshot: true, timeoutSec: 45 });
      pages.push(result.output);
      evidence.push(...(result.evidence ?? []));
      artifacts.push(...(result.artifacts ?? []));
      if (!result.ok) problems.push(...(((result.output as { problems?: string[] })?.problems ?? [result.summary]).map((x) => `${p} ${x}`)));
    }
    return {
      ok: problems.length === 0,
      summary: problems.length ? `Verification found ${problems.length} problem(s): ${problems[0]}` : `Verified ${input.paths.length} page(s) at ${input.mode === 'browser' ? input.viewports.join(' and ') : 'HTTP'}${input.mode === 'browser' ? ' widths' : ''}`,
      output: { problems, pages },
      evidence,
      artifacts,
      ...(problems.length ? { error: { code: 'FAILED' as const, message: problems.slice(0, 5).join('; ') } } : {}),
    };
  } finally {
    if (processId && ctx.processes) await ctx.processes.stop(processId, 'verification finished').catch(() => undefined);
  }
}

export function verifyProvider(): ToolProvider {
  return {
    id: 'verify',
    name: 'End-to-end verification',
    description: 'Start the app, check it in a real browser or over HTTP, stop it.',
    category: 'verification',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'verify.web',
        title: 'Verify the app end to end',
        description: 'Start the app (optional), wait until it answers, open each path at desktop and phone widths (or call it over HTTP), report console errors, failed requests and screenshots, then stop it.',
        input: webVerifyInput,
        level: 2,
        classify: (input) => (input.startCommand ? { reasons: ['Starts the app for verification'], effects: ['process'] } : { level: 1 }),
        run: (input, ctx) => verifyWeb(input, ctx),
      }),
    ],
  };
}
