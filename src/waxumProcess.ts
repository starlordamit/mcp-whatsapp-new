import { spawn, ChildProcess } from 'node:child_process';
import type { SpawnConfig } from './config.js';

/**
 * Spawns the waxum binary and waits for `/health` to answer before
 * returning. stdout/stderr are piped to THIS process's stderr, never
 * stdout — stdout is the MCP JSON-RPC channel over the stdio
 * transport, and anything waxum prints there would corrupt it.
 */
export async function spawnWaxum(config: SpawnConfig): Promise<ChildProcess> {
  const child = spawn(config.binaryPath, [], {
    cwd: config.workdir,
    env: { ...process.env, ...config.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[waxum] ${chunk}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[waxum] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[waxum-mcp] waxum process exited (code=${code}, signal=${signal})\n`);
  });

  await waitForHealth(`http://127.0.0.1:${config.port}`, child);
  return child;
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`waxum process exited before becoming healthy (code=${child.exitCode})`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `waxum did not become healthy within ${timeoutMs}ms: ${String(lastError ?? 'timed out')}`,
  );
}
