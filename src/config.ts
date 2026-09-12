import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { OAuthConfig } from './oauthServer.js';

export type WaxumMode = 'spawn' | 'client';
export type McpTransport = 'stdio' | 'http';
export type McpAuthMode = 'token' | 'oauth';

export interface SpawnConfig {
  binaryPath: string;
  workdir: string;
  port: number;
  token: string;
  env: Record<string, string>;
}

export interface Config {
  transport: McpTransport;
  http?: {
    host: string;
    port: number;
    auth:
      | { mode: 'token'; publicToken: string }
      | { mode: 'oauth'; oauth: OAuthConfig };
  };
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
  const transport = (process.env.MCP_TRANSPORT ?? 'stdio') as McpTransport;
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error('MCP_TRANSPORT must be either "stdio" or "http"');
  }

  const http = transport === 'http' ? loadHttpConfig() : undefined;

  const sessionId = required('WAXUM_SESSION_ID');
  const mediaDir = path.resolve(process.env.WAXUM_MEDIA_DIR ?? './media');

  const explicitMode = process.env.WAXUM_MODE as WaxumMode | undefined;
  const mode: WaxumMode = explicitMode ?? (process.env.WAXUM_BASE_URL ? 'client' : 'spawn');

  if (mode === 'client') {
    return {
      transport,
      http,
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
    transport,
    http,
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

function loadHttpConfig(): NonNullable<Config['http']> {
  const mode = (process.env.MCP_AUTH_MODE ?? 'token') as McpAuthMode;
  if (mode !== 'token' && mode !== 'oauth') {
    throw new Error('MCP_AUTH_MODE must be either "token" or "oauth"');
  }
  const auth: NonNullable<Config['http']>['auth'] = mode === 'oauth'
    ? {
        mode,
        oauth: {
          issuer: validateIssuer(required('OAUTH_ISSUER')),
          clientId: required('OAUTH_CLIENT_ID'),
          clientSecret: minimumLength('OAUTH_CLIENT_SECRET', 24),
          username: required('OAUTH_USERNAME'),
          password: minimumLength('OAUTH_PASSWORD', 12),
          signingSecret: minimumLength('OAUTH_SIGNING_SECRET', 32),
          redirectUris: (process.env.OAUTH_REDIRECT_URIS ?? '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean),
        },
      }
    : { mode, publicToken: required('MCP_PUBLIC_TOKEN') };
  return {
    host: process.env.MCP_HOST ?? '0.0.0.0',
    port: parsePort('MCP_PORT', process.env.MCP_PORT ?? '8080'),
    auth,
  };
}

function validateIssuer(value: string): string {
  const issuer = value.replace(/\/+$/, '');
  const url = new URL(issuer);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('OAUTH_ISSUER must use HTTPS (HTTP is allowed only for localhost testing)');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OAUTH_ISSUER must be an origin without a path, query, or fragment');
  }
  return issuer;
}

function minimumLength(name: string, length: number): string {
  const value = required(name);
  if (Buffer.byteLength(value, 'utf8') < length) {
    throw new Error(`${name} must be at least ${length} bytes`);
  }
  return value;
}

function parsePort(name: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}
