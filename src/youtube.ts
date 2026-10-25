import { InvalidInputError } from "./errors.js";

export interface VideoRef {
  videoId: string;
  /** Canonical `https://www.youtube.com/watch?v=<id>` URL sent to the model. */
  url: string;
}

/** A part of the video, in whole seconds from the start of the full video. */
export interface Clip {
  startSeconds?: number;
  endSeconds?: number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const ID_PATH_PREFIXES = new Set(["shorts", "live", "embed", "v"]);

function invalidUrl(input: string): InvalidInputError {
  return new InvalidInputError(
    `Not a YouTube video URL: "${input.slice(0, 200)}". ` +
      "Use a link like https://www.youtube.com/watch?v=<id>, https://youtu.be/<id>, a Shorts link, or the 11-character video ID.",
  );
}

/**
 * Accepts any common YouTube video link (watch, youtu.be, shorts, live, embed, mobile, music)
 * or a bare video ID, and returns the video ID plus a canonical URL. Everything else is rejected,
 * so only YouTube videos are ever passed to the model.
 */
export function parseVideoRef(input: string): VideoRef {
  const trimmed = input.trim();
  if (VIDEO_ID.test(trimmed)) return toRef(trimmed);

  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw invalidUrl(input);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalidUrl(input);
  if (url.username || url.password) throw invalidUrl(input);

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined;

  if (host === "youtu.be") {
    if (segments.length === 1) id = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === "watch") {
      id = url.searchParams.get("v");
    } else if (segments.length === 2 && ID_PATH_PREFIXES.has(segments[0]!)) {
      id = segments[1];
    }
  }

  if (!id || !VIDEO_ID.test(id)) throw invalidUrl(input);
  return toRef(id);
}

function toRef(videoId: string): VideoRef {
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

const SECONDS = /^(\d+)s?$/;
const MIN_SEC = /^(\d+):([0-5]\d)$/;
const HOUR_MIN_SEC = /^(\d+):([0-5]\d):([0-5]\d)$/;

/** Parses `90`, `"90"`, `"90s"`, `"1:30"` or `"1:02:03"` into whole seconds. */
export function parseTimestamp(input: string | number): number {
  if (typeof input === "number") {
    if (Number.isInteger(input) && input >= 0) return input;
    throw badTimestamp(String(input));
  }
  const value = input.trim();
  let match = SECONDS.exec(value);
  if (match) return Number(match[1]);
  match = MIN_SEC.exec(value);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  match = HOUR_MIN_SEC.exec(value);
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  throw badTimestamp(input);
}

function badTimestamp(input: string): InvalidInputError {
  return new InvalidInputError(
    `Invalid timestamp "${input.slice(0, 50)}". Use seconds (90), MM:SS (1:30) or H:MM:SS (1:02:03).`,
  );
}

/** `M:SS` below one hour, `H:MM:SS` from one hour on. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function parseClip(
  start: string | number | undefined,
  end: string | number | undefined,
): Clip | undefined {
  if (start === undefined && end === undefined) return undefined;
  const clip: Clip = {};
  if (start !== undefined) clip.startSeconds = parseTimestamp(start);
  if (end !== undefined) clip.endSeconds = parseTimestamp(end);
  if (clip.endSeconds !== undefined && clip.endSeconds <= (clip.startSeconds ?? 0)) {
    throw new InvalidInputError("`end` must be later than `start`.");
  }
  return clip;
}

export function formatClip(clip: Clip | undefined): string {
  if (!clip) return "full video";
  const from = formatTimestamp(clip.startSeconds ?? 0);
  const to = clip.endSeconds === undefined ? "end" : formatTimestamp(clip.endSeconds);
  return `${from} – ${to}`;
}

export function deepLink(videoId: string, seconds: number): string {
  return `${toRef(videoId).url}&t=${Math.max(0, Math.floor(seconds))}s`;
}
