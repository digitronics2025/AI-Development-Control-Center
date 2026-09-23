import { VAULT_RESOLVE_ACTIONS } from '@acc/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../app.js';

/**
 * MyVault bridge routes (docs/systems/credential-broker.md, "MyVault bridge").
 * Local-token routes like every other /api route: only the dashboard's own
 * bridge page can call them. They are not tool capabilities, not MCP tools
 * and not remote operations — an agent or the cloud can never drive the
 * bridge. Envelopes in and out are ciphertext; no route returns a value.
 */

const idParam = z.object({ id: z.string().min(1).max(100) });
const originBody = z.object({ origin: z.string().min(1).max(300) });
const MESSAGE_BODY_LIMIT = 512 * 1024;

export function registerVaultBridgeRoutes(app: FastifyInstance, s: AppServices): void {
  const bridge = s.vaultBridge;

  app.get('/api/vault-bridge/status', async () => bridge.status());
  app.post('/api/vault-bridge/origins', async (request) => bridge.trustOrigin(originBody.parse(request.body).origin));
  app.post('/api/vault-bridge/origins/remove', async (request) => bridge.untrustOrigin(originBody.parse(request.body).origin));

  app.post('/api/vault-bridge/sessions', { bodyLimit: 16 * 1024 }, async (request, reply) => reply.code(201).send(await bridge.open(request.body)));
  app.post('/api/vault-bridge/sessions/:id/messages', { bodyLimit: MESSAGE_BODY_LIMIT }, async (request) => {
    const { envelope } = z.object({ envelope: z.unknown() }).parse(request.body);
    return bridge.message(idParam.parse(request.params).id, envelope);
  });
  app.delete('/api/vault-bridge/sessions/:id', async (request, reply) => {
    bridge.close(idParam.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/credentials/:id/events', async (request) => s.credentials.events(s.credentials.get(idParam.parse(request.params).id)?.id ?? '__none__', 100));
  app.post('/api/credentials/:id/vault-resolve', async (request) => s.credentials.resolve(idParam.parse(request.params).id, z.object({ action: z.enum(VAULT_RESOLVE_ACTIONS) }).parse(request.body).action));
}
