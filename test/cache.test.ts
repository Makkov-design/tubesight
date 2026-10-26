import { describe, expect, it, vi } from "vitest";
import type { AnalyzeRequest, AnalyzeResult, VideoAnalyzer } from "../src/analyzer.js";
import { CachedAnalyzer, TtlCache } from "../src/cache.js";
import { parseVideoRef } from "../src/youtube.js";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TtlCache", () => {
  it("returns stored values until they expire", () => {
    const c = clock();
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 10, now: c.now });
    cache.set("a", "1");
    expect(cache.get("a")).toBe("1");
    c.advance(999);
    expect(cache.get("a")).toBe("1");
    c.advance(1);
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("stores nothing when the TTL is zero", () => {
    const cache = new TtlCache<number>({ ttlMs: 0, maxEntries: 10 });
    cache.set("a", 1);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("CachedAnalyzer", () => {
  const request: AnalyzeRequest = { video: parseVideoRef("dQw4w9WgXcQ"), prompt: "p", detail: "default" };

  function fake(result: Partial<AnalyzeResult> = {}) {
    const analyze = vi.fn(async (): Promise<AnalyzeResult> => ({ text: "t", model: "m", usage: {}, truncated: false, ...result }));
    const inner: VideoAnalyzer = { model: "m", analyze, listModels: async () => [] };
    return { inner, analyze };
  }

  it("serves repeated requests from the cache", async () => {
    const { inner, analyze } = fake();
    const cached = new CachedAnalyzer(inner, { ttlMs: 60_000 });
    expect((await cached.analyze(request)).cached).toBeUndefined();
    expect((await cached.analyze(request)).cached).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("keys on everything that changes the answer", async () => {
    const { inner, analyze } = fake();
    const cached = new CachedAnalyzer(inner, { ttlMs: 60_000 });
    await cached.analyze(request);
    await cached.analyze({ ...request, prompt: "other" });
    await cached.analyze({ ...request, detail: "low" });
    await cached.analyze({ ...request, clip: { startSeconds: 5 } });
    await cached.analyze({ ...request, responseJsonSchema: { type: "object" } });
    expect(analyze).toHaveBeenCalledTimes(5);
  });

  it("does not cache answers that fail the request's validation", async () => {
    const { inner, analyze } = fake({ text: "{not json" });
    const cached = new CachedAnalyzer(inner, { ttlMs: 60_000 });
    const validated = {
      ...request,
      validate: (result: AnalyzeResult) => {
        JSON.parse(result.text);
      },
    };
    await expect(cached.analyze(validated)).rejects.toThrow(SyntaxError);
    await expect(cached.analyze(validated)).rejects.toThrow(SyntaxError);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("does not cache truncated answers or failures", async () => {
    const { inner, analyze } = fake({ truncated: true });
    const cached = new CachedAnalyzer(inner, { ttlMs: 60_000 });
    await cached.analyze(request);
    await cached.analyze(request);
    expect(analyze).toHaveBeenCalledTimes(2);

    analyze.mockRejectedValueOnce(new Error("x"));
    const failing = new CachedAnalyzer(inner, { ttlMs: 60_000 });
    await expect(failing.analyze(request)).rejects.toThrow("x");
    await failing.analyze(request);
    expect(analyze).toHaveBeenCalledTimes(4);
  });
});
