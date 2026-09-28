import { afterEach, describe, expect, it } from 'vitest';
import { classifyCommand, inputReferencesSelf, relativizeOwnRoots, setSelfReferences } from '../src/index.js';

/**
 * An isolated task's worktree lives in the data folder (…\AIDevControlCenter\worktrees\…). Its own path is the
 * task's folder, not the Control Center's files; anything past it still is (seen live on TASK-0022, 2026-09-28).
 */

const DATA = String.raw`C:\Users\op\AppData\Local\AIDevControlCenter`;
const ROOT = String.raw`C:\Users\op\AppData\Local\AIDevControlCenter\worktrees\shop-1a2b3c\TASK-0099`;

afterEach(() => setSelfReferences({}));

describe('relativizeOwnRoots', () => {
  it("writes a path inside the task's folder relative to it, in every spelling", () => {
    expect(relativizeOwnRoots(`cd "${ROOT}" && npm test`, [ROOT])).toBe('cd "." && npm test');
    expect(relativizeOwnRoots(`${ROOT}\\src\\a.ts`, [ROOT])).toBe('.\\src\\a.ts');
    expect(relativizeOwnRoots(ROOT.replace(/\\/g, '/') + '/src/a.ts', [ROOT])).toBe('.\\src\\a.ts');
    expect(relativizeOwnRoots(ROOT.toLowerCase(), [ROOT])).toBe('.');
    expect(relativizeOwnRoots({ cwd: ROOT, files: [`${ROOT}\\x`], [`${ROOT}\\key`]: 1 }, [ROOT])).toEqual({ cwd: '.', files: ['.\\x'], ['.\\key']: 1 });
  });

  it('leaves a path that climbs out, a sibling folder and anything else as written', () => {
    const out = `${ROOT}\\..\\..\\..\\acc.db`;
    expect(relativizeOwnRoots(out, [ROOT])).toBe(out);
    expect(relativizeOwnRoots(`${ROOT}\\src\\..\\..\\TASK-0098\\a`, [ROOT])).toBe(`${ROOT}\\src\\..\\..\\TASK-0098\\a`);
    // A folder whose name only starts like the root is another folder.
    expect(relativizeOwnRoots(`${ROOT}-old\\a`, [ROOT])).toBe(`${ROOT}-old\\a`);
    expect(relativizeOwnRoots(`${DATA}\\tasks`, [ROOT])).toBe(`${DATA}\\tasks`);
    // Roots that are not absolute paths are ignored, never matched loosely.
    expect(relativizeOwnRoots('src/a.ts', ['', 'src'])).toBe('src/a.ts');
  });

  it('keeps the file name, and judges the call as the same call in an ordinary folder', () => {
    const judged = relativizeOwnRoots(`Get-Content "${ROOT}\\.env"`, [ROOT]);
    expect(judged).toBe('Get-Content ".\\.env"');
    const ordinary = String.raw`Get-Content "D:\work\shop\.env"`;
    for (const command of [`Remove-Item -Recurse "${ROOT}\\dist"`, `git -C "${ROOT}" push origin main`, `Get-Content "${ROOT}\\src\\a.ts"`]) {
      const inOrdinary = command.split(ROOT).join(String.raw`D:\work\shop`);
      const { reasons: _a, ...ours } = classifyCommand(relativizeOwnRoots(command, [ROOT]));
      const { reasons: _b, ...theirs } = classifyCommand(inOrdinary);
      expect(ours, command).toEqual(theirs);
    }
    expect(classifyCommand(judged).level).toBe(classifyCommand(ordinary).level);
  });
});

describe('the self-reference check after it', () => {
  it("lets the task name its own folder, and still refuses the data folder and the key files", () => {
    setSelfReferences({ dataDir: DATA, port: 4317 });
    // Before: the task's own folder reads as the data folder.
    expect(inputReferencesSelf({ cwd: ROOT })).toBe(true);
    expect(inputReferencesSelf(relativizeOwnRoots({ cwd: ROOT, command: 'node server.mjs --port 5231' }, [ROOT]))).toBe(false);
    for (const input of [{ script: `type "${ROOT}\\..\\..\\..\\acc.db"` }, { script: `type "${DATA}\\auth-token"` }, { path: `${ROOT}\\..\\..\\TASK-0098` }, { url: 'http://127.0.0.1:4317/api/tasks' }]) {
      expect(inputReferencesSelf(relativizeOwnRoots(input, [ROOT])), JSON.stringify(input)).toBe(true);
    }
  });
});
