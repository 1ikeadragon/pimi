/** The most a viewer keeps and a single read returns. Providers count it in their own unit. */
export const BACKGROUND_OUTPUT_PAGE_LIMIT = 64 * 1024;

export interface BackgroundWorkOutputPage {
  output: string;
  /** Pass back to read on. Opaque to callers; each provider chooses its unit. */
  cursor: number;
  /** Output before `output` was left out: the first read of a long job, or the reader fell behind. */
  skipped: boolean;
}

export interface BackgroundWorkOutputRead extends BackgroundWorkOutputPage {
  /** False when the item had already left the inventory before this read, so the read is final. */
  running: boolean;
}
