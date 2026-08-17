import { randomBytes } from 'node:crypto';
import path from 'node:path';

export type WaxumMode = 'spawn' | 'client';

export interface SpawnConfig {
  binaryPath: string;
  workdir: string;
  port: number;
  token: string;
  env: Record<string, string>;
}

export interface Config {
  mode: WaxumMode;
  sessionId: string;
  mediaDir: string;
  spawn?: SpawnConfig;
  client?: {
    baseUrl: string;
    token: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required but not set`);
  }
  return value;
}

/**
 * Resolves configuration from the environment. Mode defaults to
 * `client` when `WAXUM_BASE_URL` is set, otherwise `spawn` — an
 * explicit `WAXUM_MODE` always wins. Spawn mode generates a random
 * `SUPERADMIN_TOKEN` when `WAXUM_TOKEN` is unset, since a freshly
 * spawned waxum has no token minted yet and the superadmin token is
 * the only bootstrap credential it accepts.
 */
export function loadConfig(): Config {
  const sessionId = required('WAXUM_SESSION_ID');
  const mediaDir = path.resolve(process.env.WAXUM_MEDIA_DIR ?? './media');

  const explicitMode = process.env.WAXUM_MODE as WaxumMode | undefined;
  const mode: WaxumMode = explicitMode ?? (process.env.WAXUM_BASE_URL ? 'client' : 'spawn');

  if (mode === 'client') {
    return {
      mode,
      sessionId,
      mediaDir,
      client: {
        baseUrl: required('WAXUM_BASE_URL').replace(/\/+$/, ''),
        token: required('WAXUM_TOKEN'),
      },
    };
  }

  const port = Number(process.env.WAXUM_PORT ?? 3451);
  const token = process.env.WAXUM_TOKEN ?? randomBytes(24).toString('hex');
  const binaryPath = required('WAXUM_BINARY_PATH');
  const workdir = path.resolve(process.env.WAXUM_WORKDIR ?? path.dirname(binaryPath));
  const databaseUrl =
    process.env.WAXUM_DATABASE_URL ?? `sqlite://${path.join(workdir, 'waxum.db')}`;

  return {
    mode,
    sessionId,
    mediaDir,
    spawn: {
      binaryPath,
      workdir,
      port,
      token,
      env: {
        SUPERADMIN_TOKEN: token,
        PORT: String(port),
        DATABASE_URL: databaseUrl,
      },
    },
  };
}
