import type { AnalyzeRequest, AnalyzeResult, ModelInfo, VideoAnalyzer } from "./analyzer.js";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** In-memory LRU cache with a fixed time-to-live. A TTL of 0 disables it. */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry); // move to most recently used
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Remembers successful analyses, so asking the same thing about the same video again
 * costs no quota. Results served from the cache have `cached: true`.
 */
export class CachedAnalyzer implements VideoAnalyzer {
  private readonly cache: TtlCache<AnalyzeResult>;

  constructor(
    private readonly inner: VideoAnalyzer,
    options: { ttlMs: number; maxEntries?: number; now?: () => number },
  ) {
    this.cache = new TtlCache({ maxEntries: 200, ...options });
  }

  get model(): string {
    return this.inner.model;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const key = JSON.stringify([
      this.inner.model,
      request.video.url,
      request.clip?.startSeconds ?? null,
      request.clip?.endSeconds ?? null,
      request.detail,
      request.prompt,
      request.responseJsonSchema ?? null,
    ]);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };
    const result = await this.inner.analyze(request);
    request.validate?.(result);
    if (!result.truncated) this.cache.set(key, result);
    return result;
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }
}
