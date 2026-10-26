import {
  GoogleGenAI,
  MediaResolution,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Model,
  type Part,
} from "@google/genai";
import type { Config } from "./config.js";
import { AnalyzerError } from "./errors.js";
import type { Logger } from "./logger.js";
import { SYSTEM_INSTRUCTION } from "./prompts.js";
import type { Clip, VideoRef } from "./youtube.js";

export type Detail = "default" | "low";

export interface AnalyzeRequest {
  video: VideoRef;
  clip?: Clip;
  prompt: string;
  detail: Detail;
  /** When set, the model must answer with JSON matching this JSON Schema. */
  responseJsonSchema?: object;
  /** Throws if the answer is unusable; such answers are never cached. */
  validate?: (result: AnalyzeResult) => void;
}

export interface Usage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AnalyzeResult {
  text: string;
  model: string;
  usage: Usage;
  /** True when the output stopped at the model's token limit. */
  truncated: boolean;
  /** True when the result came from the local cache instead of a new Gemini call. */
  cached?: boolean;
}

export interface ModelInfo {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
}

export interface VideoAnalyzer {
  readonly model: string;
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
  listModels(): Promise<ModelInfo[]>;
}

/** The part of the `@google/genai` client this module uses; lets tests pass a fake. */
export interface GenAiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    list(): Promise<AsyncIterable<Model>>;
  };
}

const BLOCKING_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

/** Gemini variants that generate speech or images, or embed text, rather than understand video. */
const NOT_VIDEO_MODELS = /tts|image|embedding|banana|native-audio|live|robotics|computer-use|customtools/i;

export class GeminiAnalyzer implements VideoAnalyzer {
  readonly model: string;
  private readonly client: GenAiClient;
  private readonly timeoutMs: number;
  private readonly secrets: string[];
  private readonly logger: Logger;

  constructor(options: {
    client: GenAiClient;
    model: string;
    timeoutMs: number;
    logger: Logger;
    /** Strings removed from every error message (the API key). */
    secrets?: string[];
  }) {
    this.client = options.client;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.secrets = options.secrets ?? [];
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const videoPart: Part = { fileData: { fileUri: request.video.url } };
    if (request.clip) {
      videoPart.videoMetadata = {
        ...(request.clip.startSeconds !== undefined && { startOffset: `${request.clip.startSeconds}s` }),
        ...(request.clip.endSeconds !== undefined && { endOffset: `${request.clip.endSeconds}s` }),
      };
    }

    const config: GenerateContentConfig = {
      systemInstruction: SYSTEM_INSTRUCTION,
      // One deadline for the whole call: the SDK stops retrying once this signal fires.
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    };
    if (request.detail === "low") config.mediaResolution = MediaResolution.MEDIA_RESOLUTION_LOW;
    if (request.responseJsonSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = request.responseJsonSchema;
    }

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [videoPart, { text: request.prompt }] }],
        config,
      });
    } catch (error) {
      throw this.toAnalyzerError(error);
    }

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new AnalyzerError("blocked", `Gemini refused to process this request (${blockReason}).`);
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    const text = response.text ?? "";
    if (finishReason && BLOCKING_FINISH_REASONS.has(finishReason)) {
      throw new AnalyzerError("blocked", `Gemini stopped the answer because of its content filters (${finishReason}).`);
    }
    if (!text.trim()) {
      throw new AnalyzerError(
        "empty_response",
        finishReason === "MAX_TOKENS"
          ? "Gemini ran out of output tokens before answering. Analyze a shorter part with `start`/`end`."
          : `Gemini returned an empty answer${finishReason ? ` (${finishReason})` : ""}. Try again or rephrase the request.`,
      );
    }

    const usage = response.usageMetadata;
    return {
      text,
      model: response.modelVersion ?? this.model,
      truncated: finishReason === "MAX_TOKENS",
      usage: {
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        totalTokens: usage?.totalTokenCount,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    try {
      for await (const model of await this.client.models.list()) {
        if (!model.name || !model.supportedActions?.includes("generateContent")) continue;
        if (!/^(models\/)?gemini-/.test(model.name) || NOT_VIDEO_MODELS.test(model.name)) continue;
        models.push({
          name: model.name.replace(/^models\//, ""),
          ...(model.displayName && { displayName: model.displayName }),
          ...(model.inputTokenLimit && { inputTokenLimit: model.inputTokenLimit }),
        });
      }
    } catch (error) {
      throw this.toAnalyzerError(error);
    }
    return models;
  }

  /** Maps any SDK or network failure to an actionable message that never contains the key. */
  toAnalyzerError(error: unknown): AnalyzerError {
    if (error instanceof AnalyzerError) return error;
    const raw = error instanceof Error ? error.message : String(error);
    const detail = this.redact(apiMessage(raw)).replace(/\s+/g, " ").trim().slice(0, 300);
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
    const name = error instanceof Error ? error.name : "";
    this.logger.debug("gemini call failed", { status, name, detail });

    const withDetail = (message: string) => `${message} Details: ${detail}`;

    if (status === undefined) {
      if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(raw)) {
        return new AnalyzerError(
          "timeout",
          `Gemini did not answer within ${Math.round(this.timeoutMs / 1000)} s. Analyze a shorter part with \`start\`/\`end\`, use \`detail: "low"\`, or raise YTLENS_TIMEOUT_MS.`,
        );
      }
      if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(raw)) {
        return new AnalyzerError("unavailable", withDetail("Could not reach the Gemini API (network error)."));
      }
      return new AnalyzerError("unknown", withDetail("Gemini request failed."));
    }

    if (status === 401 || status === 403 || (status === 400 && /api[ _]?key/i.test(raw))) {
      return new AnalyzerError(
        "auth",
        withDetail("Gemini rejected the API key. Check GEMINI_API_KEY and that the key may use the Gemini API."),
        status,
      );
    }
    if (status === 429) {
      return new AnalyzerError(
        "quota",
        withDetail(
          "Gemini quota or rate limit reached. Wait a minute and retry; for long videos use `detail: \"low\"` or a shorter `start`/`end` range.",
        ),
        status,
      );
    }
    if (status === 404) {
      return new AnalyzerError(
        "model_not_found",
        withDetail(`Model "${this.model}" is not available. Run list_supported_models and set GEMINI_MODEL_NAME.`),
        status,
      );
    }
    if (status === 408 || status === 504) {
      return new AnalyzerError("timeout", withDetail("Gemini timed out while processing the video."), status);
    }
    if (status >= 500) {
      return new AnalyzerError("unavailable", withDetail("Gemini is temporarily unavailable. Try again shortly."), status);
    }
    if (/video|youtube|file_?uri|fetch|private|unavailable|token/i.test(raw)) {
      return new AnalyzerError(
        "video_unavailable",
        withDetail(
          "Gemini could not process this video. It may be private, age-restricted, region-locked, removed, or too long; " +
            'try `detail: "low"` or a shorter `start`/`end` range.',
        ),
        status,
      );
    }
    return new AnalyzerError("invalid_request", withDetail("Gemini rejected the request."), status);
  }

  private redact(text: string): string {
    return this.secrets.reduce(
      (acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc),
      text.replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]"),
    );
  }
}

/** The SDK puts the raw error body into the message; pull out Google's human-readable text when present. */
function apiMessage(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return raw;
  try {
    const body = JSON.parse(raw.slice(start)) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : raw;
  } catch {
    return raw;
  }
}

export function createGeminiAnalyzer(config: Config, logger: Logger): GeminiAnalyzer {
  const client = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      timeout: config.timeoutMs,
      retryOptions: { attempts: config.maxRetries + 1 },
    },
  });
  return new GeminiAnalyzer({
    client,
    model: config.model,
    timeoutMs: config.timeoutMs,
    logger,
    secrets: [config.apiKey],
  });
}
