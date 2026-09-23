import { z } from 'zod';
import { builtinDetection, failure, operation, type ToolProvider } from '../sdk.js';

/**
 * Secrets an agent needs but must never see (docs/systems/credential-broker.md).
 * `credential.generate` asks the orchestrator's broker for a CSPRNG value,
 * which is sealed before the call returns; the agent gets a name and a
 * fingerprint to pass to structured tools such as `cloudflare.secret_put`.
 */

const name = z.string().min(1).max(100).regex(/^[\w.-]+$/, 'Letters, digits, dot, dash and underscore');

export function credentialProvider(): ToolProvider {
  return {
    id: 'credential-broker',
    name: 'Credential broker',
    description: 'Generates secrets that are stored encrypted and never shown to an agent.',
    category: 'system',
    builtin: true,
    async detect() {
      return builtinDetection();
    },
    operations: [
      operation({
        id: 'credential.generate',
        title: 'Generate a secret',
        description:
          'Create a strong random secret (32 random bytes as base64url unless asked otherwise) and store it encrypted under `name`. The value is never returned to you: use it by name in structured tools such as cloudflare.secret_put. Calling again with the same name returns the same secret — it is never regenerated. It is scoped to this repository and must be saved to MyVault before its first deployment.',
        input: z.object({
          name,
          kind: z.enum(['cloudflare', 'github', 'postgres', 'mysql', 'http', 'npm', 'other']).default('other'),
          envVar: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
            .nullable()
            .default(null),
          description: z.string().max(300).default(''),
          bytes: z.number().int().min(16).max(64).default(32),
          encoding: z.enum(['base64url', 'hex']).default('base64url'),
        }),
        level: 2,
        classify: () => ({ level: 2, reasons: ['Stores a new secret in the local credential broker'], effects: [] }),
        async run(input, ctx) {
          if (!ctx.credentials?.generate) return failure('UNAVAILABLE', 'Secret generation is not available in this session');
          try {
            const r = await ctx.credentials.generate(input);
            const c = r.credential;
            return {
              ok: true,
              summary: r.created ? `Generated ${c.name} (fingerprint ${c.fingerprint}); MyVault sync ${r.vaultSync ?? 'not linked'}` : `${c.name} already exists (fingerprint ${c.fingerprint}); it was not regenerated`,
              output: { name: c.name, id: c.id, kind: c.kind, envVar: c.envVar, fingerprint: c.fingerprint, repositoryIds: c.repositoryIds, created: r.created, vaultSync: r.vaultSync },
              evidence: [`credential ${c.name} ${r.created ? 'generated' : 'reused'} fingerprint ${c.fingerprint}`],
            };
          } catch (error) {
            return failure('INVALID_INPUT', (error as Error).message);
          }
        },
      }),
    ],
  };
}
