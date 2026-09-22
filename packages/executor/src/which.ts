import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform === 'win32') return true;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate an executable on PATH, honouring PATHEXT on Windows. Returns the
 * first match or null. Explicit paths are checked directly.
 */
export async function which(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const isWin = process.platform === 'win32';
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT') ?? 'PATHEXT';
  const exts = isWin
    ? (env[extKey] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];

  const candidatesFor = (base: string) => {
    if (!isWin) return [base];
    const ext = path.extname(base).toLowerCase();
    return ext && exts.includes(ext) ? [base] : exts.map((e) => base + e);
  };

  if (name.includes('/') || name.includes('\\')) {
    for (const candidate of candidatesFor(name)) if (await isExecutableFile(candidate)) return candidate;
    return null;
  }

  const dirs = (env[pathKey] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidatesFor(path.join(dir.replace(/^"|"$/g, ''), name))) {
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
