import type { GenerateContentParameters, GenerateContentResponse, Model } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { GeminiAnalyzer, type AnalyzeRequest, type GenAiClient } from "../src/analyzer.js";
import { AnalyzerError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { parseVideoRef } from "../src/youtube.js";

const KEY = "AIzaSyTESTKEY123";
const video = parseVideoRef("dQw4w9WgXcQ");

function response(fields: Record<string, unknown>): GenerateContentResponse {
  return fields as unknown as GenerateContentResponse;
}

function setup(generate: (params: GenerateContentParameters) => Promise<GenerateContentResponse>, models: Model[] = []) {
  const generateContent = vi.fn(generate);
  const client: GenAiClient = {
    models: {
      generateContent,
      list: async () =>
        (async function* () {
          yield* models;
        })(),
    },
  };
  const analyzer = new GeminiAnalyzer({ client, model: "gemini-test", timeoutMs: 30_000, logger: silentLogger, secrets: [KEY] });
  return { analyzer, generateContent };
}

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { name: "ApiError", status });
}

const base: AnalyzeRequest = { video, prompt: "Summarize.", detail: "default" };

describe("GeminiAnalyzer.analyze", () => {
  it("sends the video, prompt and system instruction", async () => {
    const { analyzer, generateContent } = setup(async () =>
      response({ text: "ok", modelVersion: "gemini-test-001", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }),
    );
    const result = await analyzer.analyze(base);

    expect(result).toEqual({
      text: "ok",
      model: "gemini-test-001",
      truncated: false,
      usage: { promptTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const params = generateContent.mock.calls[0]![0];
    expect(params.model).toBe("gemini-test");
    expect(params.contents).toEqual([
      { role: "user", parts: [{ fileData: { fileUri: video.url } }, { text: "Summarize." }] },
    ]);
    expect(params.config?.systemInstruction).toMatch(/untrusted/);
    // one deadline for the whole call, so retries cannot stretch it
    expect(params.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(params.config?.mediaResolution).toBeUndefined();
    expect(params.config?.responseMimeType).toBeUndefined();
  });

  it("passes clip offsets, low detail and a JSON schema", async () => {
    const { analyzer, generateContent } = setup(async () => response({ text: "{}" }));
    const schema = { type: "object" };
    await analyzer.analyze({ ...base, clip: { startSeconds: 60, endSeconds: 120 }, detail: "low", responseJsonSchema: schema });

    const params = generateContent.mock.calls[0]![0];
    const parts = (params.contents as { parts: unknown[] }[])[0]!.parts;
    expect(parts[0]).toEqual({ fileData: { fileUri: video.url }, videoMetadata: { startOffset: "60s", endOffset: "120s" } });
    expect(params.config).toMatchObject({
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
  });

  it("sends only the bounds that are set", async () => {
    const { analyzer, generateContent } = setup(async () => response({ text: "x" }));
    await analyzer.analyze({ ...base, clip: { startSeconds: 30 } });
    const parts = (generateContent.mock.calls[0]![0].contents as { parts: unknown[] }[])[0]!.parts;
    expect(parts[0]).toMatchObject({ videoMetadata: { startOffset: "30s" } });
    expect((parts[0] as { videoMetadata: object }).videoMetadata).not.toHaveProperty("endOffset");
  });

  it("flags output that hit the token limit", async () => {
    const { analyzer } = setup(async () => response({ text: "partial", candidates: [{ finishReason: "MAX_TOKENS" }] }));
    expect((await analyzer.analyze(base)).truncated).toBe(true);
  });

  it.each([
    [response({ promptFeedback: { blockReason: "SAFETY" } }), "blocked"],
    [response({ text: "", candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }), "blocked"],
    [response({ text: "", candidates: [{ finishReason: "MAX_TOKENS" }] }), "empty_response"],
    [response({ text: "  " }), "empty_response"],
    [response({}), "empty_response"],
  ])("rejects unusable responses (%#)", async (res, kind) => {
    const { analyzer } = setup(async () => res);
    await expect(analyzer.analyze(base)).rejects.toMatchObject({ kind });
  });
});

describe("GeminiAnalyzer error mapping", () => {
  it.each<[unknown, string]>([
    [apiError(400, "API key not valid. Please pass a valid API key."), "auth"],
    [apiError(403, "Permission denied"), "auth"],
    [apiError(401, "Unauthenticated"), "auth"],
    [apiError(429, "Resource has been exhausted (e.g. check quota)."), "quota"],
    [apiError(404, "models/gemini-test is not found"), "model_not_found"],
    [apiError(500, "Internal error"), "unavailable"],
    [apiError(503, "The model is overloaded"), "unavailable"],
    [apiError(504, "Deadline exceeded"), "timeout"],
    [apiError(400, "Cannot fetch content from the provided URL. Video is private."), "video_unavailable"],
    [apiError(400, "The input token count exceeds the maximum number of tokens allowed"), "video_unavailable"],
    [apiError(400, "Invalid value at 'generation_config'"), "invalid_request"],
    [Object.assign(new Error("This operation was aborted"), { name: "AbortError" }), "timeout"],
    [new TypeError("fetch failed"), "unavailable"],
    [new Error("something odd"), "unknown"],
    ["a string", "unknown"],
  ])("maps %s to %s", async (thrown, kind) => {
    const { analyzer } = setup(async () => {
      throw thrown;
    });
    const error = await analyzer.analyze(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalyzerError);
    expect((error as AnalyzerError).kind).toBe(kind);
  });

  it("never leaks the API key", async () => {
    const { analyzer } = setup(async () => {
      throw apiError(400, `API key ${KEY} invalid for https://host/v1?key=${KEY}&alt=json and https://host/v2?alt=json&key=othersecret`);
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("othersecret");
    expect(error.message).toContain("[redacted]");
  });

  it("shows the message from a JSON error body instead of the raw JSON", async () => {
    const body = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED" } });
    const { analyzer } = setup(async () => {
      throw apiError(429, body);
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.kind).toBe("quota");
    expect(error.message).toMatch(/Details: You exceeded your current quota\.$/);
  });

  it("keeps details short", async () => {
    const { analyzer } = setup(async () => {
      throw apiError(500, "x".repeat(5000));
    });
    const error = (await analyzer.analyze(base).catch((e: unknown) => e)) as AnalyzerError;
    expect(error.message.length).toBeLessThan(500);
  });
});

describe("GeminiAnalyzer.listModels", () => {
  it("lists Gemini models that can understand video", async () => {
    const { analyzer } = setup(async () => response({}), [
      { name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 1000, supportedActions: ["generateContent", "countTokens"] },
      { name: "models/embedding", supportedActions: ["embedContent"] },
      { name: "models/gemini-b", supportedActions: ["generateContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedActions: ["generateContent"] },
      { name: "models/gemini-3-pro-image", supportedActions: ["generateContent"] },
      { name: "models/nano-banana-pro-preview", supportedActions: ["generateContent"] },
      { name: "models/gemma-4-31b-it", supportedActions: ["generateContent"] },
      { supportedActions: ["generateContent"] },
    ]);
    expect(await analyzer.listModels()).toEqual([
      { name: "gemini-a", displayName: "Gemini A", inputTokenLimit: 1000 },
      { name: "gemini-b" },
    ]);
  });
});
