import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const FORM_LIMIT = 64 * 1024;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

export interface OAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  signingSecret: string;
  redirectUris: string[];
}

export class LocalOAuthServer {
  private readonly codes = new Map<string, AuthorizationCode>();

  constructor(private readonly config: OAuthConfig) {}

  get protectedResourceMetadataUrl(): string {
    return `${this.config.issuer}/.well-known/oauth-protected-resource/mcp`;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.sendJson(res, 200, {
        issuer: this.config.issuer,
        authorization_endpoint: `${this.config.issuer}/oauth/authorize`,
        token_endpoint: `${this.config.issuer}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        scopes_supported: ['mcp', 'offline_access'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
      return true;
    }

    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.sendJson(res, 200, {
        resource: `${this.config.issuer}/mcp`,
        authorization_servers: [this.config.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp', 'offline_access'],
      });
      return true;
    }

    if (url.pathname === '/oauth/authorize') {
      if (req.method === 'GET') {
        this.renderLogin(res, url.searchParams);
        return true;
      }
      if (req.method === 'POST') {
        await this.authorize(req, res);
        return true;
      }
      return this.methodNotAllowed(res, 'GET, POST');
    }

    if (url.pathname === '/oauth/token') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST');
      await this.token(req, res);
      return true;
    }

    return false;
  }

  validateAccessToken(token: string): boolean {
    const claims = this.verifyJwt(token);
    return (
      claims?.typ === 'access' &&
      claims.iss === this.config.issuer &&
      claims.aud === `${this.config.issuer}/mcp` &&
      typeof claims.scope === 'string' &&
      claims.scope.split(' ').includes('mcp') &&
      claims.sub === this.config.username
    );
  }

  private renderLogin(
    res: ServerResponse,
    params: URLSearchParams,
    error?: string,
  ): void {
    const validationError = this.validateAuthorizationRequest(params);
    if (validationError) {
      this.sendHtml(res, 400, page('Invalid authorization request', `<p>${escapeHtml(validationError)}</p>`));
      return;
    }

    const values: Record<string, string> = {
      response_type: 'code',
      client_id: params.get('client_id') ?? '',
      redirect_uri: params.get('redirect_uri') ?? '',
      state: params.get('state') ?? '',
      scope: params.get('scope') ?? 'mcp',
      code_challenge: params.get('code_challenge') ?? '',
      code_challenge_method: params.get('code_challenge_method') ?? '',
    };
    const fields = Object.entries(values)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join('');
    const message = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
    this.sendHtml(
      res,
      error ? 401 : 200,
      page(
        'Connect WhatsApp MCP',
        `${message}<p>Sign in to allow ChatGPT to use this WhatsApp MCP server.</p>
        <form method="post" action="/oauth/authorize">
          ${fields}
          <label>Username<input name="username" autocomplete="username" required autofocus></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Authorize</button>
        </form>`,
      ),
    );
  }

  private async authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const error = this.validateAuthorizationRequest(form);
    if (error) {
      this.sendJson(res, 400, { error: 'invalid_request', error_description: error });
      return;
    }

    if (
      !secureEqual(form.get('username') ?? '', this.config.username) ||
      !secureEqual(form.get('password') ?? '', this.config.password)
    ) {
      this.renderLogin(res, form, 'Incorrect username or password.');
      return;
    }

    this.pruneCodes();
    const code = randomBytes(32).toString('base64url');
    const redirectUri = form.get('redirect_uri')!;
    this.codes.set(code, {
      clientId: this.config.clientId,
      redirectUri,
      codeChallenge: form.get('code_challenge')!,
      scope: normalizeScope(form.get('scope'))!,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    const state = form.get('state');
    if (state) redirect.searchParams.set('state', state);
    res.writeHead(302, { Location: redirect.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    if (!this.validateClient(req, form)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="oauth-token"');
      this.sendJson(res, 401, { error: 'invalid_client' });
      return;
    }

    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      const codeValue = form.get('code') ?? '';
      const code = this.codes.get(codeValue);
      this.codes.delete(codeValue);
      if (
        !code ||
        code.expiresAt < Date.now() ||
        code.clientId !== this.config.clientId ||
        code.redirectUri !== form.get('redirect_uri') ||
        !verifyPkce(form.get('code_verifier') ?? '', code.codeChallenge)
      ) {
        this.sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      this.sendTokens(res, code.scope);
      return;
    }

    if (grantType === 'refresh_token') {
      const claims = this.verifyJwt(form.get('refresh_token') ?? '');
      if (
        claims?.typ !== 'refresh' ||
        claims.iss !== this.config.issuer ||
        claims.aud !== `${this.config.issuer}/mcp` ||
        typeof claims.scope !== 'string' ||
        !claims.scope.split(' ').includes('mcp') ||
        claims.sub !== this.config.username
      ) {
        this.sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      this.sendTokens(res, claims.scope);
      return;
    }

    this.sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  private validateAuthorizationRequest(params: URLSearchParams): string | undefined {
    if (params.get('response_type') !== 'code') return 'response_type must be code';
    if (params.get('client_id') !== this.config.clientId) return 'Unknown client_id';
    if (!normalizeScope(params.get('scope'))) return 'Unsupported scope';
    if (params.get('code_challenge_method') !== 'S256') return 'PKCE S256 is required';
    if (!params.get('code_challenge')) return 'code_challenge is required';
    const redirectUri = params.get('redirect_uri');
    if (!redirectUri || !this.isRedirectAllowed(redirectUri)) return 'redirect_uri is not allowed';
    return undefined;
  }

  private isRedirectAllowed(value: string): boolean {
    if (this.config.redirectUris.length > 0) return this.config.redirectUris.includes(value);
    try {
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    } catch {
      return false;
    }
  }

  private validateClient(req: IncomingMessage, form: URLSearchParams): boolean {
    let clientId = form.get('client_id') ?? '';
    let clientSecret = form.get('client_secret') ?? '';
    const authorization = req.headers.authorization;
    if (authorization?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 0) return false;
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      } catch {
        return false;
      }
    }
    return secureEqual(clientId, this.config.clientId) && secureEqual(clientSecret, this.config.clientSecret);
  }

  private sendTokens(res: ServerResponse, scope: string): void {
    this.sendJson(res, 200, {
      access_token: this.signJwt('access', ACCESS_TOKEN_TTL_SECONDS, scope),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: this.signJwt('refresh', REFRESH_TOKEN_TTL_SECONDS, scope),
      scope,
    });
  }

  private signJwt(type: 'access' | 'refresh', ttlSeconds: number, scope: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: this.config.issuer,
      sub: this.config.username,
      aud: `${this.config.issuer}/mcp`,
      scope,
      typ: type,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomBytes(16).toString('hex'),
    })).toString('base64url');
    const signature = createHmac('sha256', this.config.signingSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private verifyJwt(token: string): Record<string, unknown> | undefined {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const expected = createHmac('sha256', this.config.signingSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    if (!secureEqual(parts[2], expected)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return undefined;
      return claims;
    } catch {
      return undefined;
    }
  }

  private pruneCodes(): void {
    for (const [code, data] of this.codes) if (data.expiresAt < Date.now()) this.codes.delete(code);
  }

  private methodNotAllowed(res: ServerResponse, allow: string): true {
    res.setHeader('Allow', allow);
    res.writeHead(405).end('Method Not Allowed');
    return true;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private sendHtml(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(body);
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > FORM_LIMIT) throw new Error('Form body too large');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash('sha256').update(verifier).digest();
  const actual = computed.toString('base64url');
  return secureEqual(actual, challenge);
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function normalizeScope(value: string | null): string | undefined {
  const scopes = [...new Set((value ?? 'mcp').split(/\s+/).filter(Boolean))];
  if (!scopes.includes('mcp') || scopes.some(scope => scope !== 'mcp' && scope !== 'offline_access')) {
    return undefined;
  }
  return scopes.join(' ');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:420px;margin:10vh auto;padding:24px;color:#202124}h1{font-size:24px}label{display:block;margin:16px 0}input{box-sizing:border-box;width:100%;padding:10px;margin-top:6px}button{width:100%;padding:11px;background:#1677ff;color:white;border:0;border-radius:6px;font-weight:600}.error{color:#b42318}</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}
