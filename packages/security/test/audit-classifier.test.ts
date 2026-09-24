import { afterEach, describe, expect, it } from 'vitest';
import { classifyCommand, setSelfReferences } from '../src/index.js';

/** Regression tests for the 2026-09-24 pre-release audit (F-02, F-13, F-52). */

describe('F-13 / F-52: destructive Git and delete spellings the classifier missed', () => {
  it.each([
    'git clean -d -f',
    'git clean --force -d',
    'git clean -xdf',
    'git branch -D feature',
    'git branch --delete --force feature',
    'git branch -d -f feature',
    'git branch -df feature',
    'git worktree remove --force ../wt',
    'git push --mirror origin',
    'git push origin --delete old',
    'git checkout -f main',
    'git switch --discard-changes main',
    'npx rimraf dist',
    'python -c "import shutil; shutil.rmtree(\'dist\')"',
    'node -e "require(\'fs\').rmSync(\'dist\', { recursive: true })"',
  ])('%s is Level 5', (command) => {
    const c = classifyCommand(command);
    expect(c.level, c.reasons.join('; ')).toBe(5);
    expect(c.risk).toBe('dangerous');
    expect(c.readOnly).toBe(false);
  });

  it.each(['git checkout -- src/app.ts', 'git restore src/app.ts', 'git restore --worktree --staged src'])('%s discards changes and is Level 3', (command) => {
    expect(classifyCommand(command)).toMatchObject({ level: 3, readOnly: false });
  });

  it.each(['gh secret set FOO', 'gh variable delete BAR'])('%s changes CI secrets and is Level 4', (command) => {
    expect(classifyCommand(command).level).toBe(4);
  });

  it('keeps listing forms read-only and no longer treats writes as reads', () => {
    for (const command of ['git branch', 'git branch -a', 'git branch --show-current', 'git tag --list', 'git remote -v', 'git config --get user.name', 'git stash list', 'git restore --staged src/app.ts'.replace(/.*/, 'git status')]) {
      expect(classifyCommand(command).readOnly, command).toBe(true);
    }
    for (const command of ['git branch newbranch', 'git tag v1.0', 'git remote add evil https://x', 'git reflog expire --all', 'git config --global user.name x']) {
      expect(classifyCommand(command).readOnly, command).toBe(false);
    }
    expect(classifyCommand('git restore --staged src/app.ts').level).toBe(2);
  });
});

describe('F-02: commands that reach the Control Center itself are Level 5', () => {
  afterEach(() => setSelfReferences({}));

  it.each([
    String.raw`type %LOCALAPPDATA%\AIDevControlCenter\auth-token`,
    'Get-Content $env:LOCALAPPDATA/AIDevControlCenter/auth-token',
    'cat ~/.local/share/ai-control-center/auth-token',
    'curl -X POST http://127.0.0.1:4317/api/approvals/x/approve',
    'Invoke-RestMethod http://localhost:4317/api/settings -Method Patch',
  ])('%s', (command) => {
    const c = classifyCommand(command);
    expect(c.level).toBe(5);
    expect(c.reasons).toContain("Reaches the Control Center's own token, data folder or API");
  });

  it('learns a custom data folder and port', () => {
    expect(classifyCommand(String.raw`dir D:\acc-data\tasks`).level).toBeLessThan(5);
    setSelfReferences({ dataDir: String.raw`D:\acc-data`, port: 5000 });
    expect(classifyCommand(String.raw`dir D:\acc-data\tasks`).level).toBe(5);
    expect(classifyCommand('dir D:/acc-data/tasks').level).toBe(5);
    expect(classifyCommand('curl http://127.0.0.1:5000/api/tasks').level).toBe(5);
    expect(classifyCommand('curl http://127.0.0.1:5001/api/tasks').level).toBeLessThan(5);
  });

  it('leaves ordinary port inspection alone', () => {
    expect(classifyCommand('Get-NetTCPConnection -LocalPort 4317').level).toBe(1);
  });
});
