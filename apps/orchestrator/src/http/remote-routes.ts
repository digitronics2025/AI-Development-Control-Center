import type { FastifyInstance, FastifyRequest } from 'fastify';
import { remotePairInputSchema, remotePermissionsSchema } from '@acc/shared';
import type { AppServices } from '../app.js';
import { RemoteError } from '../remote/service.js';

/**
 * This machine's own remote-access controls (docs/systems/remote-node.md).
 * Local only: none of these routes is in the remote operation catalog, and a
 * request that arrives through a remote command is refused here as well, so
 * the cloud can never pair, unpair, re-enable or widen its own access.
 */
export function registerRemoteRoutes(app: FastifyInstance, s: AppServices): void {
  const localOnly = (request: FastifyRequest) => {
    if (request.headers['x-acc-remote-request']) throw new RemoteError('Remote access can only be changed on this machine.', 'LOCAL_ONLY');
  };

  app.get('/api/remote', async (request) => {
    localOnly(request);
    return s.remote.status();
  });

  app.post('/api/remote/pair', async (request) => {
    localOnly(request);
    return s.remote.pair(remotePairInputSchema.parse(request.body));
  });

  app.post('/api/remote/unpair', async (request) => {
    localOnly(request);
    return s.remote.unpair();
  });

  app.patch('/api/remote', async (request) => {
    localOnly(request);
    return s.remote.updatePermissions(remotePermissionsSchema.parse(request.body ?? {}));
  });

  app.post('/api/remote/rotate', async (request) => {
    localOnly(request);
    return s.remote.rotate();
  });

  app.post('/api/remote/reconnect', async (request) => {
    localOnly(request);
    return s.remote.reconnectNow();
  });
}
