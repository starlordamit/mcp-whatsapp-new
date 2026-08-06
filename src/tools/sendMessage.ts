import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';

export function registerSendMessage(server: McpServer, ctx: Ctx): void {
  server.tool(
    'send_message',
    'Send a plain text message to a WhatsApp contact or group. `to` is a JID (e.g. "6281234567890@s.whatsapp.net" for a contact, "1234567890@g.us" for a group) — use list_groups or list_chats to find one by name.',
    {
      to: z.string().describe('Recipient JID'),
      text: z.string().describe('Message text'),
      reply_to: z.string().optional().describe('Message ID to reply to, if quoting'),
    },
    async ({ to, text, reply_to }) => {
      const result = await ctx.client.sendText(ctx.sessionId, { to, text, reply_to });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
