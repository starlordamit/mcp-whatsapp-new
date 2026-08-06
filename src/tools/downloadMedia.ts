import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../context.js';
import { extensionForMimetype } from '../mediaTypes.js';

const mediaSchema = z
  .object({
    direct_path: z.string(),
    media_key: z.string(),
    file_sha256: z.string(),
    file_enc_sha256: z.string(),
    file_length: z.number(),
    media_type: z.enum(['image', 'video', 'audio', 'document', 'sticker']),
    mimetype: z.string(),
  })
  .describe("The `media` object from a get_messages result — pass it through unchanged");

export function registerDownloadMedia(server: McpServer, ctx: Ctx): void {
  server.tool(
    'download_media',
    'Download a media message (image, video, audio, document, or sticker) to local disk. Pass the `media` object exactly as returned by get_messages. Returns the saved file path and metadata — read the file at that path to inspect its contents.',
    {
      media: mediaSchema,
      message_id: z
        .string()
        .optional()
        .describe('Message ID, used to name the saved file (falls back to a random name)'),
    },
    async ({ media, message_id }) => {
      const { data, size } = await ctx.client.downloadMedia(ctx.sessionId, media);
      const bytes = Buffer.from(data, 'base64');

      await mkdir(ctx.mediaDir, { recursive: true });
      const ext = extensionForMimetype(media.mimetype);
      const baseName = message_id ?? `media-${Date.now()}`;
      const filePath = path.join(ctx.mediaDir, `${baseName}.${ext}`);
      await writeFile(filePath, bytes);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                path: filePath,
                size,
                mimetype: media.mimetype,
                media_type: media.media_type,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
