import type { WaxumClient } from './waxumClient.js';

export interface Ctx {
  client: WaxumClient;
  sessionId: string;
  mediaDir: string;
}
