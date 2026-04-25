// Stops the test server spawned in global-setup.

export default async function globalTeardown() {
  const proc = globalThis.__E2E_SERVER_PROC__;
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.on('exit', finish);
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} finish(); }, 3000);
  });
}
