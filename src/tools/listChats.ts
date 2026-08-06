import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';

export function registerListChats(server: McpServer, ctx: Ctx): void {
  server.tool(
    'list_chats',
    'List or search known WhatsApp contacts (1:1 chats), with their JID, phone number, and push_name — use this to find a contact\'s JID by name before sending to or reading from it.',
    {
      q: z.string().optional().describe('Filter by name, phone, or push_name substring'),
      limit: z.number().int().min(1).max(1000).optional().describe('Page size (default 100, max 1000)'),
      offset: z.number().int().min(0).optional().describe('Rows to skip (default 0)'),
    },
    async ({ q, limit, offset }) => {
      const result = await ctx.client.listContacts(ctx.sessionId, { q, limit, offset });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
