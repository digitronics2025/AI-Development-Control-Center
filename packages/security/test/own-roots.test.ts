import { describe, expect, it } from 'vitest';
import { classifyCommand, relativizeOwnRoots } from '../src/index.js';

/**
 * A call is classified with the task's own folders written relative (docs/systems/security.md): a whole-tree command
 * on its own folder reads as one, and a sibling repository of a multi-repository task is never read as the call's
 * own folder. The self-reference check does not use this form; an agent never works inside the data folder.
 */

const ROOT = String.raw`C:\work\acc-work\worktrees\shop-1a2b3c\TASK-0099`;

describe('relativizeOwnRoots', () => {
  it("writes a path inside the task's folder relative to it, in every spelling", () => {
    expect(relativizeOwnRoots(`cd "${ROOT}" && npm test`, [ROOT])).toBe('cd "." && npm test');
    expect(relativizeOwnRoots(`${ROOT}\\src\\a.ts`, [ROOT])).toBe('.\\src\\a.ts');
    expect(relativizeOwnRoots(ROOT.replace(/\\/g, '/') + '/src/a.ts', [ROOT])).toBe('.\\src\\a.ts');
    expect(relativizeOwnRoots(ROOT.toLowerCase(), [ROOT])).toBe('.');
    expect(relativizeOwnRoots({ cwd: ROOT, files: [`${ROOT}\\x`], [`${ROOT}\\key`]: 1 }, [ROOT])).toEqual({ cwd: '.', files: ['.\\x'], ['.\\key']: 1 });
  });

  it('leaves a path that climbs out, a sibling folder and anything else as written', () => {
    const out = `${ROOT}\\..\\..\\..\\secret.txt`;
    expect(relativizeOwnRoots(out, [ROOT])).toBe(out);
    expect(relativizeOwnRoots(`${ROOT}\\src\\..\\..\\TASK-0098\\a`, [ROOT])).toBe(`${ROOT}\\src\\..\\..\\TASK-0098\\a`);
    // A folder whose name only starts like the root is another folder.
    expect(relativizeOwnRoots(`${ROOT}-old\\a`, [ROOT])).toBe(`${ROOT}-old\\a`);
    // Roots that are not absolute paths are ignored, never matched loosely.
    expect(relativizeOwnRoots('src/a.ts', ['', 'src'])).toBe('src/a.ts');
  });

  it('writes a path relative to the folder the call runs in, so a sibling repository is never read as "."', () => {
    const ws = String.raw`C:\work\acc-work\workspaces\TASK-0100`;
    const [a, b] = [`${ws}\\shop`, `${ws}\\shop-api`];
    expect(relativizeOwnRoots(`git -C "${b}" push`, [a, b], a)).toBe('git -C "..\\shop-api" push');
    expect(relativizeOwnRoots(`git -C "${a}" push`, [a, b], a)).toBe('git -C "." push');
    expect(relativizeOwnRoots(`${a}\\src\\x.ts`, [a, b], a)).toBe('.\\src\\x.ts');
    // From a folder inside the root, the root's own files are one level up.
    expect(relativizeOwnRoots(`${a}\\README.md`, [a], `${a}\\src`)).toBe('..\\README.md');
    // Without a working folder, relative to the root that holds the path.
    expect(relativizeOwnRoots(`${b}\\x`, [a, b])).toBe('.\\x');
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
    // Discarding the whole folder, named absolutely, reads as discarding everything.
    expect(classifyCommand(relativizeOwnRoots(`git checkout -- "${ROOT}"`, [ROOT], ROOT)).level).toBe(5);
  });
});
