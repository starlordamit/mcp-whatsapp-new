import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';
import { mediaKindFromMimetype, mimetypeFromExtension } from '../mediaTypes.js';

export function registerSendFile(server: McpServer, ctx: Ctx): void {
  server.tool(
    'send_file',
    'Send a local file (image, video, audio, document, or sticker) to a WhatsApp contact or group. The file kind is inferred from its mimetype (override with `mimetype` for files with no/wrong extension) and routed to the matching WhatsApp message type automatically.',
    {
      to: z.string().describe('Recipient JID'),
      file_path: z.string().describe('Absolute path to the local file to send'),
      mimetype: z
        .string()
        .optional()
        .describe('Override the mimetype guessed from the file extension'),
      caption: z.string().optional().describe('Caption (image/video/document only)'),
      as_voice_note: z
        .boolean()
        .optional()
        .describe('Send audio as a push-to-talk voice note instead of a regular audio file'),
      reply_to: z.string().optional().describe('Message ID to reply to, if quoting'),
    },
    async ({ to, file_path, mimetype, caption, as_voice_note, reply_to }) => {
      const data = await readFile(file_path);
      const resolvedMimetype = mimetype ?? mimetypeFromExtension(file_path);
      const kind = mediaKindFromMimetype(resolvedMimetype);
      const media = { data: data.toString('base64'), mimetype: resolvedMimetype };
      const filename = file_path.split('/').pop() ?? 'file';

      const result = await (async () => {
        switch (kind) {
          case 'image':
            return ctx.client.sendImage(ctx.sessionId, { to, image: media, caption, reply_to });
          case 'video':
            return ctx.client.sendVideo(ctx.sessionId, { to, video: media, caption, reply_to });
          case 'audio':
            return ctx.client.sendAudio(ctx.sessionId, {
              to,
              audio: media,
              ptt: as_voice_note,
              reply_to,
            });
          case 'sticker':
            return ctx.client.sendSticker(ctx.sessionId, { to, sticker: media, reply_to });
          case 'document':
            return ctx.client.sendDocument(ctx.sessionId, {
              to,
              document: media,
              filename,
              caption,
              reply_to,
            });
        }
      })();

      return {
        content: [{ type: 'text', text: JSON.stringify({ kind, ...result }, null, 2) }],
      };
    },
  );
}
