import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from '@acc/security';
import { expandPackageScripts } from '../src/engine/script-resolve.js';

describe('expandPackageScripts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-scripts-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      scripts: {
        build: 'tsc && npm run clean',
        clean: 'rm -rf dist',
        test: 'vitest run',
        pretest: 'echo pre',
        deploy: 'wrangler deploy --env production',
      },
    }),
  );

  it('expands nested scripts so dangerous bodies are classified', () => {
    const expanded = expandPackageScripts(dir, 'npm run build');
    expect(expanded).toContain('rm -rf dist');
    expect(classifyCommand(expanded).risk).toBe('dangerous');
  });

  it('handles npm test, pnpm and yarn forms, including pre/post hooks', () => {
    expect(expandPackageScripts(dir, 'npm test')).toContain('echo pre && vitest run');
    expect(expandPackageScripts(dir, 'pnpm run deploy')).toContain('--env production');
    expect(expandPackageScripts(dir, 'yarn deploy')).toContain('wrangler deploy');
    expect(classifyCommand(expandPackageScripts(dir, 'pnpm run deploy')).level).toBe(5);
  });

  it('leaves unrelated commands alone', () => {
    expect(expandPackageScripts(dir, 'npm install')).toBe('npm install');
    expect(expandPackageScripts(dir, 'cargo test')).toBe('cargo test');
    expect(expandPackageScripts(path.join(dir, 'missing'), 'npm run build')).toBe('npm run build');
  });
});
