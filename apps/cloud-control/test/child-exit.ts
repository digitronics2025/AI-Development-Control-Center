import type { ChildProcess } from 'node:child_process';

/** Stop an owned fixture and clear the fallback timer as soon as it exits. */
export function stopChildAndWait(child: ChildProcess, stop: () => void): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, 10_000);
    child.once('exit', finish);
    try {
      stop();
    } catch (error) {
      clearTimeout(timer);
      child.off('exit', finish);
      reject(error);
    }
  });
}
