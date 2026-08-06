import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';

export function registerSessionStatus(server: McpServer, ctx: Ctx): void {
  server.tool(
    'session_status',
    'Check whether the WhatsApp session is connected and logged in, and get its phone number / display name. Call this first if a send or read fails — the session may be disconnected or not yet paired (pairing/QR setup is done directly against waxum, not through this MCP server).',
    {},
    async () => {
      const result = await ctx.client.getSessionStatus(ctx.sessionId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
