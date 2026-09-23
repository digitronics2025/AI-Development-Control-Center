import { git } from '@acc/git';
import { sha256Hex } from '@acc/shared';

/**
 * Normalized identity of a Git remote: host/owner/repo, lower-cased host,
 * credentials, port for SSH, scheme and a trailing `.git` removed. Two clones
 * of one repository on two machines get the same identity; the local folder
 * never enters it.
 */
export function normalizeRemote(url: string): { identity: string; host: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // scp-like SSH: git@github.com:owner/repo.git
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  let host: string;
  let pathPart: string;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    host = scp[1]!;
    pathPart = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === 'file:') return null;
    host = parsed.hostname;
    pathPart = parsed.pathname;
  }
  const cleanPath = pathPart
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!host || !cleanPath) return null;
  return { identity: `${host.toLowerCase()}/${cleanPath}`, host: host.toLowerCase() };
}

/** Privacy-safe repository fingerprint: SHA-256 of the remote identity, or of node + repository id when there is no usable remote. */
export async function repositoryFingerprint(repoPath: string, nodeId: string, repositoryId: string): Promise<{ fingerprint: string; remoteHost: string | null }> {
  let remote: { identity: string; host: string } | null = null;
  try {
    const result = await git(repoPath, ['remote', 'get-url', 'origin'], { timeoutMs: 5_000 });
    if (result.code === 0) remote = normalizeRemote(result.stdout);
  } catch {
    remote = null;
  }
  if (remote) return { fingerprint: await sha256Hex(`remote:${remote.identity}`), remoteHost: remote.host };
  return { fingerprint: await sha256Hex(`local:${nodeId}:${repositoryId}`), remoteHost: null };
}
