import { afterEach, describe, expect, it } from 'vitest';
import { classifyCommand, inputReferencesSelf, relativeClimbTargets, relativizeOwnRoots, setSelfReferences } from '../src/index.js';

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

  it('failing closed, leaves an input with a climb anywhere in it as written, however the climb is spelled', () => {
    // A space or bracket inside the path, the root in its own quotes, a variable or Join-Path holding it: each once
    // rewrote only the root and left a `..` climb that no longer named the data folder (review, 2026-09-28).
    for (const text of [
      `Get-Content "${ROOT}\\x y\\..\\..\\..\\..\\auth-tok*"`,
      `Get-Content "${ROOT}\\(x)\\..\\..\\..\\..\\acc.db"`,
      `dir "${ROOT}\\a b\\..\\..\\TASK-0098"`,
      `Get-Content "${ROOT}"\\..\\..\\..\\acc.db`,
      `$w = "${ROOT}"; Get-Content "$w\\..\\..\\..\\acc.db"`,
      `Join-Path "${ROOT}" "..\\..\\..\\acc.db" | Get-Content`,
      `cat '${ROOT.replace(/\\/g, '/')}'/../../../acc.db`,
    ]) {
      expect(relativizeOwnRoots(text, [ROOT], ROOT, { failClosed: true }), text).toBe(text);
    }
    // The root in one argument, the climb in another.
    const split = { script: String.raw`Get-Content "$($args[0])"\..\..\..\acc.db`, args: [ROOT] };
    expect(relativizeOwnRoots(split, [ROOT], ROOT, { failClosed: true })).toEqual(split);
    // The folder the call runs in stays its own (a climb from it is resolved separately), unless it climbs itself.
    expect(relativizeOwnRoots({ cwd: ROOT, script: 'Get-Content src\\..\\src\\a.txt', args: [ROOT] }, [ROOT], ROOT, { failClosed: true })).toEqual({ cwd: '.', script: 'Get-Content src\\..\\src\\a.txt', args: [ROOT] });
    expect(relativizeOwnRoots({ cwd: `${ROOT}\\..\\..`, script: 'dir' }, [ROOT], ROOT, { failClosed: true })).toEqual({ cwd: `${ROOT}\\..\\..`, script: 'dir' });
    // Without failing closed (the classifier's reading), the root is still written relative, climb or not.
    expect(relativizeOwnRoots(`git checkout -- "${ROOT}"; echo ..`, [ROOT], ROOT)).toBe('git checkout -- "."; echo ..');
    // Dots that are not a climb do not count: a range, a spread, a Git range.
    expect(relativizeOwnRoots(`cd "${ROOT}"; 1..3 | % { $_ }; git log main..HEAD; node -e "f(...a)"`, [ROOT], ROOT, { failClosed: true })).toBe('cd "."; 1..3 | % { $_ }; git log main..HEAD; node -e "f(...a)"');
  });

  it('writes a path relative to the folder the call runs in, so a sibling repository is never read as "."', () => {
    const ws = String.raw`C:\Users\op\AppData\Local\AIDevControlCenter\workspaces\TASK-0100`;
    const [a, b] = [`${ws}\\shop`, `${ws}\\shop-api`];
    expect(relativizeOwnRoots(`git -C "${b}" push`, [a, b], a)).toBe('git -C "..\\shop-api" push');
    expect(relativizeOwnRoots(`git -C "${a}" push`, [a, b], a)).toBe('git -C "." push');
    expect(relativizeOwnRoots(`${a}\\src\\x.ts`, [a, b], a)).toBe('.\\src\\x.ts');
    // From a folder inside the root, the root's own files are one level up.
    expect(relativizeOwnRoots(`${a}\\README.md`, [a], `${a}\\src`)).toBe('..\\README.md');
    // Without a working folder, relative to the root that holds the path, as before.
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
  });
});

describe('relativeClimbTargets', () => {
  const at = (input: unknown, bases = [ROOT]) => relativeClimbTargets(input, bases);
  it('resolves each relative climb from every folder the call may run in', () => {
    expect(at('Get-Content ..\\..\\..\\acc.db')).toEqual([`${DATA}\\acc.db`]);
    // shell.run in a sub-folder: the climb is read from there as well.
    expect(at({ script: 'Get-Content ..\\..\\..\\..\\acc.db', cwd: 'src' }, [ROOT, `${ROOT}\\src`])).toContain(`${DATA}\\acc.db`);
  });

  it('reads a climb that starts with a variable or a separator from the call folder', () => {
    for (const script of [String.raw`Get-Content "$PWD"\..\..\..\acc.db`, String.raw`Get-Content "$(Get-Location)\..\..\..\acc.db"`, String.raw`Get-Content $w\..\..\..\acc.db`, 'cat "${PWD}"/../../../acc.db', String.raw`type %CD%\..\..\..\acc.db`]) {
      expect(at(script), script).toContain(`${DATA}\\acc.db`);
    }
  });

  it('follows each cd in a command, so a climb is read from where that part runs', () => {
    expect(at('cd src && cat ../../../../acc.db')).toContain(`${DATA}\\acc.db`);
    // `cd ..` typed three times ends in the data folder.
    expect(at('cd ..; cd ..; cd ..; cat acc.db')).toContain(DATA);
    // Inside the task's folder the same climbs stay inside it.
    expect(at('cd src\\ui && cat ..\\..\\package.json')).toEqual([`${ROOT}\\src\\ui`, `${ROOT}\\package.json`]);
    // A folder only known when it runs is not followed.
    expect(at('cd $w && cat ..\\x')).toEqual([`${String.raw`C:\Users\op\AppData\Local\AIDevControlCenter\worktrees\shop-1a2b3c`}\\x`]);
  });

  it("does not read a file's content, a URL or a UNC path as a path the call acts on", () => {
    expect(at({ message: 'Move helpers to ../../../shared' })).toEqual([]);
    expect(at('git commit -am "Move helpers to ../../../shared" && git commit --message=../../../x')).toEqual([]);
    expect(at({ path: 'src/deep/a/b.ts', content: "import x from '../../../../lib/x';" })).toEqual([]);
    expect(at({ path: 'a.ts', find: '../../../x', replace: '../../../y' })).toEqual([]);
    expect(at('curl https://example.test/a/../../b')).toEqual([]);
    expect(at(String.raw`dir \\server\share\..\x`)).toEqual([]);
  });
});

describe('the self-reference check after it', () => {
  it("lets the task name its own folder, and still refuses the data folder and the key files", () => {
    setSelfReferences({ dataDir: DATA, port: 4317 });
    // Before: the task's own folder reads as the data folder.
    expect(inputReferencesSelf({ cwd: ROOT })).toBe(true);
    expect(inputReferencesSelf(relativizeOwnRoots({ cwd: ROOT, command: 'node server.mjs --port 5231' }, [ROOT]))).toBe(false);
    for (const input of [
      { script: `type "${ROOT}\\..\\..\\..\\acc.db"` },
      { script: `type "${DATA}\\auth-token"` },
      { path: `${ROOT}\\..\\..\\TASK-0098` },
      { url: 'http://127.0.0.1:4317/api/tasks' },
      { script: `Get-Content "${ROOT}\\x y\\..\\..\\..\\..\\auth-tok*"` },
      { script: `Get-Content "${ROOT}\\(x)\\..\\..\\..\\..\\acc.db"` },
      { script: `dir "${ROOT}\\a b\\..\\..\\TASK-0098"` },
      { script: `$w = "${ROOT}"; Get-Content "$w\\..\\..\\..\\acc.db"` },
    ]) {
      expect(inputReferencesSelf(relativizeOwnRoots(input, [ROOT], ROOT, { failClosed: true })), JSON.stringify(input)).toBe(true);
    }
  });
});
