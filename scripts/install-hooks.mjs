// Points Git at the repository's tracked hooks (.githooks: the secret scan and
// the docs guard) on `pnpm install`, so a fresh clone is protected without a
// manual step (audit F-19). Outside a Git checkout (a tarball, some CI) it does
// nothing.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  process.exit(0);
}
const current = (() => {
  try {
    return execFileSync('git', ['config', '--local', 'core.hooksPath'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();
if (current !== '.githooks') {
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('Git hooks: core.hooksPath set to .githooks (secret scan and docs guard).');
}
