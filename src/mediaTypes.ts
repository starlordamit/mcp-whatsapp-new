/**
 * Small extension -> mimetype table covering common chat attachments.
 * Not exhaustive by design — `send_file` accepts an explicit
 * `mimetype` override for anything outside this list, and falls back
 * to `application/octet-stream` (sent as a document) rather than
 * guessing wrong.
 */
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  json: 'application/json',
};

export function mimetypeFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export type SendableMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Which `/messages/{kind}` endpoint a mimetype should go through. */
export function mediaKindFromMimetype(mimetype: string): SendableMediaKind {
  if (mimetype === 'image/webp') return 'sticker';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_TO_MIME).map(([ext, mime]) => [mime, ext]),
);

export function extensionForMimetype(mimetype: string): string {
  return MIME_TO_EXT[mimetype] ?? 'bin';
}
