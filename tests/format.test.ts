import { describe, expect, it } from "vitest";
import type { Reading } from "../client/engine";
import { formatDuration, formatRate, formatTokens, pillLabel, turnRowText } from "../client/format";

const reading = (overrides: Partial<Reading>): Reading => ({
  state: "streaming",
  lastKind: "answer",
  rate: null,
  thinkingRate: null,
  answerRate: null,
  estimatedTokens: 0,
  measuredTokens: 0,
  tokensEstimated: false,
  elapsedMs: 0,
  generationMs: 0,
  averageRate: null,
  wallClockAverageRate: null,
  charsPerSecond: 0,
  outcome: null,
  ...overrides,
});

describe("formatTokens", () => {
  it("keeps small numbers exact and abbreviates large ones", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1240)).toBe("1.2k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
});

describe("formatRate", () => {
  it("rounds by magnitude and marks estimates", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(118.4)).toBe("118 tok/s");
    expect(formatRate(9.55)).toBe("9.6 tok/s");
    expect(formatRate(118.4, { estimated: true })).toBe("~118 tok/s");
  });
});

describe("formatDuration", () => {
  it("reads as seconds under a minute and minutes above", () => {
    expect(formatDuration(396)).toBe("0.4s");
    expect(formatDuration(3_200)).toBe("3.2s");
    expect(formatDuration(31_000)).toBe("31s");
    expect(formatDuration(64_000)).toBe("1m 04s");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("pillLabel", () => {
  it("shows a dash before any data and the average when the turn is done", () => {
    expect(pillLabel(reading({ state: "idle" }))).toBe("—");
    expect(pillLabel(reading({ state: "complete", averageRate: 132.4 }))).toBe("132 tok/s avg");
  });

  it("marks every live value as an estimate, because between reports it is extrapolated", () => {
    // even with measured tokens in hand, the live rate is characters since the last report divided by a
    // factor: only the anchor is measured
    expect(pillLabel(reading({ state: "streaming", rate: 118, tokensEstimated: false }))).toBe("~118 tok/s");
    expect(pillLabel(reading({ state: "streaming", rate: 118, tokensEstimated: true }))).toBe("~118 tok/s");
    expect(pillLabel(reading({ state: "thinking", rate: 95 }))).toBe("~95 tok/s");
    expect(pillLabel(reading({ state: "waiting", rate: 73.4 }))).toBe("~73.4 tok/s");
  });

  it("marks the turn average only when the provider never reported tokens for it", () => {
    expect(pillLabel(reading({ state: "complete", averageRate: 132, tokensEstimated: false }))).toBe("132 tok/s avg");
    expect(pillLabel(reading({ state: "complete", averageRate: 132, tokensEstimated: true }))).toBe("~132 tok/s avg");
  });

  it("shows the rate and nothing else while the model reasons", () => {
    // a "thinking" prefix was tried and rejected: the pill is short and the number is the point
    expect(pillLabel(reading({ state: "thinking", rate: 95, thinkingRate: 95.2 }))).toBe("~95 tok/s");
  });

  it("holds the most recent value while a tool runs instead of decaying", () => {
    // the whole point of the pause rule: a 73 tok/s model must not read as 28 tok/s because a shell
    // command is running
    expect(pillLabel(reading({ state: "waiting", rate: 73.4 }))).toBe("~73.4 tok/s");
    expect(pillLabel(reading({ state: "quiet", rate: 73.4 }))).toBe("~73.4 tok/s");
  });

  it("shows nothing yet when there is no value to hold", () => {
    expect(pillLabel(reading({ state: "waiting", rate: null }))).toBe("…");
    expect(pillLabel(reading({ state: "quiet", rate: null }))).toBe("…");
  });
});

describe("turnRowText", () => {
  it("renders a compact transcript line from generation time", () => {
    expect(
      turnRowText({
        tps: 132.2,
        tokens: 4231,
        generationSeconds: 31,
        seconds: 31,
        tokensEstimated: false,
        outcome: "completed",
      }),
    ).toBe("⚡ 132 tok/s · 4.2k tokens · 31s");
  });

  it("calls out time spent waiting on tools instead of hiding it in the rate", () => {
    expect(
      turnRowText({
        tps: 101,
        tokens: 4231,
        generationSeconds: 31,
        seconds: 62,
        tokensEstimated: false,
        outcome: "completed",
      }),
    ).toBe("⚡ 101 tok/s · 4.2k tokens · 31s (+31s waiting)");
  });

  it("appends the outcome for abnormal endings and marks estimates", () => {
    expect(
      turnRowText({
        tps: 12,
        tokens: 300,
        generationSeconds: 4,
        seconds: 4,
        tokensEstimated: true,
        outcome: "canceled",
      }),
    ).toBe("⚡ ~12 tok/s · 300 tokens · 4.0s · canceled");
    expect(
      turnRowText({
        tps: 12,
        tokens: 300,
        generationSeconds: 4,
        seconds: 4,
        tokensEstimated: false,
        outcome: "unknown",
      }),
    ).toBe("⚡ 12 tok/s · 300 tokens · 4.0s · unknown");
  });
});
