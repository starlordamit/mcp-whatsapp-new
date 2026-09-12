import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { LocalOAuthServer, type OAuthConfig } from './oauthServer.js';

const MCP_PATH = '/mcp';
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  auth:
    | { mode: 'token'; publicToken: string }
    | { mode: 'oauth'; oauth: OAuthConfig };
  createServer: () => McpServer;
}

export interface RunningHttpMcpServer {
  close: () => Promise<void>;
}

export async function startHttpMcpServer(
  options: HttpMcpServerOptions,
): Promise<RunningHttpMcpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const oauth = options.auth.mode === 'oauth' ? new LocalOAuthServer(options.auth.oauth) : undefined;

  const httpServer = createNodeServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/healthz') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          sendText(res, 405, 'Method Not Allowed');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok', transport: 'http', auth: options.auth.mode }));
        return;
      }
      if (oauth && await oauth.handle(req, res, url)) return;

      if (url.pathname !== MCP_PATH) {
        sendText(res, 404, 'Not Found');
        return;
      }

      if (!isAuthorized(req, options.auth, oauth)) {
        const challenge = oauth
          ? `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}"`
          : 'Bearer';
        res.setHeader('WWW-Authenticate', challenge);
        sendText(res, 401, 'Unauthorized');
        return;
      }

      if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
        res.setHeader('Allow', 'POST, GET, DELETE');
        sendText(res, 405, 'Method Not Allowed');
        return;
      }

      const sessionId = headerValue(req, 'mcp-session-id');
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing) {
        await existing.handleRequest(req, res);
        return;
      }

      if (sessionId) {
        sendJsonRpcError(res, 404, 'MCP session not found');
        return;
      }

      if (req.method !== 'POST') {
        sendJsonRpcError(res, 400, 'Missing MCP-Session-Id header');
        return;
      }

      const body = await readJsonBody(req);
      if (!isInitializeRequest(body)) {
        sendJsonRpcError(res, 400, 'A new MCP session must begin with an initialize request');
        return;
      }

      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: id => {
          transports.set(id, transport);
        },
        onsessionclosed: id => {
          transports.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const mcpServer = options.createServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      process.stderr.write(
        `[waxum-mcp] HTTP request failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal server error');
      else if (!res.writableEnded) res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return {
    close: async () => {
      await Promise.allSettled([...transports.values()].map(transport => transport.close()));
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()));
      });
    },
  };
}

function isAuthorized(
  req: IncomingMessage,
  auth: HttpMcpServerOptions['auth'],
  oauth: LocalOAuthServer | undefined,
): boolean {
  const authorization = headerValue(req, 'authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length);
  if (auth.mode === 'oauth') return oauth?.validateAccessToken(token) ?? false;
  const expectedToken = auth.publicToken;
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('Request body exceeds 1 MiB');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}
