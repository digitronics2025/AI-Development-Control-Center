import { referencesSelf } from '@acc/security';
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Signing in to a remote MCP server with OAuth (docs/systems/mcp.md#oauth):
 * the MCP SDK does discovery, dynamic client registration, PKCE, the code
 * exchange and refresh; this provider only keeps what they produce in a store
 * the orchestrator seals in the credential broker, and never opens a browser.
 * An interactive start hands the authorization address back to the operator;
 * a background call that finds its sign-in expired stops with
 * `McpSignInRequired` instead of starting one.
 */

/** Everything one server's sign-in keeps between runs. Sealed at rest; never shown. */
export interface McpOAuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the tokens were saved, so expiry can be reported without the token. */
  savedAt?: string;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
}

/** Where one server's sign-in lives (the orchestrator seals it in the broker, so reads and writes may be async). */
export interface McpOAuthStore {
  load(): McpOAuthState | null | Promise<McpOAuthState | null>;
  save(state: McpOAuthState): void | Promise<void>;
}

export interface McpOAuthOptions {
  /** Where the authorization server sends the browser back (the orchestrator's callback route). */
  redirectUrl: string;
  /** Interactive starts only: the single-use value the callback must return. */
  state?: string;
  scope?: string;
  clientName?: string;
}

/** A call needs the operator to sign in (again): no tokens, or they expired and could not be refreshed. */
export class McpSignInRequired extends Error {
  constructor(server: string) {
    super(`Not signed in to ${server}: sign in again from Tools → MCP servers`);
    this.name = 'McpSignInRequired';
  }
}

export class McpOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK asks for a browser sign-in; the orchestrator hands it to the operator. */
  authorizationUrl: URL | null = null;

  constructor(
    private readonly store: McpOAuthStore,
    private readonly options: McpOAuthOptions & { interactive: boolean },
  ) {}

  private async update(patch: Partial<McpOAuthState>): Promise<void> {
    await this.store.save({ ...((await this.store.load()) ?? {}), ...patch });
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName ?? 'AI Development Control Center',
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  state(): string {
    return this.options.state ?? '';
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.load())?.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.update({ client });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens, savedAt: new Date().toISOString(), codeVerifier: undefined });
  }

  redirectToAuthorization(url: URL): void {
    // Never opened here. A background call must not start a sign-in the operator did not ask for.
    if (this.options.interactive) this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // A background refresh that fell through to a new authorization must not replace a sign-in in progress.
    if (this.options.interactive) await this.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.load())?.codeVerifier;
    if (!verifier) throw new Error('No sign-in is in progress for this server; start it again');
    return verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.update({ discovery });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.load())?.discovery;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const current = (await this.store.load()) ?? {};
    if (scope === 'all') return this.store.save({});
    if (scope === 'client') return this.store.save({ ...current, client: undefined });
    if (scope === 'tokens') return this.store.save({ ...current, tokens: undefined, savedAt: undefined });
    if (scope === 'verifier') return this.store.save({ ...current, codeVerifier: undefined });
    return this.store.save({ ...current, discovery: undefined });
  }
}

/** `fetch` for sign-in and for the server itself: never into the Control Center's own address. */
export const guardedFetch: FetchLike = (url, init) => {
  if (referencesSelf(String(url))) return Promise.reject(new Error("Refused a request into the Control Center's own address"));
  return fetch(url, init);
};

/** Start a sign-in: the address to open, or `authorized` when saved tokens still work (or were refreshed). */
export async function startMcpSignIn(serverUrl: string, provider: McpOAuthProvider, scope?: string): Promise<{ authorized: true } | { authorized: false; authorizationUrl: string }> {
  const result = await auth(provider, { serverUrl, scope, fetchFn: guardedFetch });
  if (result === 'AUTHORIZED') return { authorized: true };
  if (!provider.authorizationUrl) throw new Error('The server asked for a sign-in but gave no authorization address');
  return { authorized: false, authorizationUrl: provider.authorizationUrl.href };
}

/** Finish a sign-in with the code the callback received; the tokens land in the provider's store. */
export async function finishMcpSignIn(serverUrl: string, provider: McpOAuthProvider, authorizationCode: string, scope?: string): Promise<void> {
  const result = await auth(provider, { serverUrl, authorizationCode, scope, fetchFn: guardedFetch });
  if (result !== 'AUTHORIZED') throw new Error('The authorization server did not accept the sign-in');
}

export { UnauthorizedError };
