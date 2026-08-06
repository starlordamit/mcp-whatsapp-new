import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';

export function registerListGroups(server: McpServer, ctx: Ctx): void {
  server.tool(
    'list_groups',
    'List WhatsApp groups this session is a participant of, with their JIDs, subjects, and member lists — use this to find a group\'s JID by name before sending to or reading from it.',
    {},
    async () => {
      const result = await ctx.client.listGroups(ctx.sessionId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
