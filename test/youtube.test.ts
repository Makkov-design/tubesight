import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/errors.js";
import {
  deepLink,
  formatClip,
  formatTimestamp,
  parseClip,
  parseTimestamp,
  parseVideoRef,
} from "../src/youtube.js";

const ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe("parseVideoRef", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `http://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}&feature=share`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`,
    `https://www.youtube.com/watch?list=PL123&v=${ID}&index=2`,
    `https://www.youtube.com/watch?v=${ID}&t=90s`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc&t=12`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `  https://youtu.be/${ID}  `,
    `www.youtube.com/watch?v=${ID}`,
    `youtu.be/${ID}`,
    ID,
  ])("normalizes %s", (input) => {
    expect(parseVideoRef(input)).toEqual({ videoId: ID, url: CANONICAL });
  });

  it.each([
    "",
    "not a url",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
    "https://evilyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ0",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/@channel",
    "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "file:///C:/videos/clip.mp4",
    "https://generativelanguage.googleapis.com/v1beta/files/abc",
    "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
  ])("rejects %j", (input) => {
    expect(() => parseVideoRef(input)).toThrow(InvalidInputError);
  });
});

describe("parseTimestamp", () => {
  it.each<[string | number, number]>([
    [0, 0],
    [90, 90],
    ["90", 90],
    ["90s", 90],
    ["1:30", 90],
    ["01:30", 90],
    ["120:00", 7200],
    ["1:02:03", 3723],
    ["10:00:00", 36000],
    [" 2:05 ", 125],
  ])("parses %j as %d seconds", (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected);
  });

  it.each(["", "abc", "-5", "1:60", "1:2", "1:02:60", "1.5", "1:2:3:4", "∞"])(
    "rejects %j",
    (input) => {
      expect(() => parseTimestamp(input)).toThrow(InvalidInputError);
    },
  );

  it("rejects negative and fractional numbers", () => {
    expect(() => parseTimestamp(-1)).toThrow(InvalidInputError);
    expect(() => parseTimestamp(1.5)).toThrow(InvalidInputError);
    expect(() => parseTimestamp(Number.NaN)).toThrow(InvalidInputError);
  });
});

describe("formatTimestamp", () => {
  it.each<[number, string]>([
    [0, "0:00"],
    [5, "0:05"],
    [90, "1:30"],
    [599, "9:59"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
    [7200, "2:00:00"],
  ])("formats %d as %s", (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });

  it("floors fractional seconds and clamps negatives", () => {
    expect(formatTimestamp(61.9)).toBe("1:01");
    expect(formatTimestamp(-3)).toBe("0:00");
  });
});

describe("parseClip", () => {
  it("returns undefined when no bounds are given", () => {
    expect(parseClip(undefined, undefined)).toBeUndefined();
  });

  it("parses one or both bounds", () => {
    expect(parseClip("1:00", undefined)).toEqual({ startSeconds: 60 });
    expect(parseClip(undefined, "2:00")).toEqual({ endSeconds: 120 });
    expect(parseClip("1:00", "2:00")).toEqual({ startSeconds: 60, endSeconds: 120 });
  });

  it("rejects an end that is not after the start", () => {
    expect(() => parseClip("2:00", "2:00")).toThrow(InvalidInputError);
    expect(() => parseClip("3:00", "2:00")).toThrow(InvalidInputError);
  });

  it("rejects an end of zero", () => {
    expect(() => parseClip(undefined, 0)).toThrow(InvalidInputError);
  });
});

describe("formatClip", () => {
  it("describes the range", () => {
    expect(formatClip(undefined)).toBe("full video");
    expect(formatClip({ startSeconds: 60 })).toBe("1:00 – end");
    expect(formatClip({ endSeconds: 120 })).toBe("0:00 – 2:00");
    expect(formatClip({ startSeconds: 60, endSeconds: 3723 })).toBe("1:00 – 1:02:03");
  });
});

describe("deepLink", () => {
  it("links to a moment in the video", () => {
    expect(deepLink(ID, 3723)).toBe(`${CANONICAL}&t=3723s`);
    expect(deepLink(ID, 12.7)).toBe(`${CANONICAL}&t=12s`);
  });
});
