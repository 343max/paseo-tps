import { describe, expect, it } from "vitest";
import { DEFAULT_FACTORS, TpsEngine, type Reading, type TokenFactors } from "../client/engine";
import { RECORDED_RUNS } from "./fixtures/runs";

/**
 * Replays a recorded turn through the engine exactly as the observer would feed it: deltas, tool calls and
 * provider token samples, interleaved by time.
 */
function replay(
  name: keyof typeof RECORDED_RUNS,
  options: { factors?: Partial<TokenFactors>; windowSeconds?: number; tickMs?: number } = {},
) {
  const run = RECORDED_RUNS[name];
  const tickMs = options.tickMs ?? 250;
  const engine = new TpsEngine({ factors: options.factors, windowSeconds: options.windowSeconds });
  engine.startTurn({ now: 0, tokens: run.baselineTokens, provider: "pi", model: "deepseek/deepseek-flash" });

  const events: { t: number; delta?: [number, string, number]; tool?: [number, string, string]; sample?: [number, number] }[] = [
    ...run.deltas.map((d) => ({ t: d[0], delta: d as [number, string, number] })),
    ...run.tools.map((tool) => ({ t: tool[0], tool: tool as [number, string, string] })),
    ...run.samples.map((s) => ({ t: s[0], sample: s as [number, number] })),
  ].sort((a, b) => a.t - b.t);

  const readings: { t: number; reading: Reading }[] = [];
  let index = 0;
  const applyUpTo = (t: number) => {
    while (index < events.length && events[index].t <= t) {
      const event = events[index];
      if (event.delta) {
        engine.onDelta({ now: event.t, kind: event.delta[1] as "thinking" | "answer", chars: event.delta[2] });
      } else if (event.tool) {
        engine.onToolCall({ now: event.t, callId: event.tool[1], status: event.tool[2] });
      } else if (event.sample) {
        engine.onTokens({ now: event.t, tokens: event.sample[1] });
      }
      index += 1;
    }
  };
  for (let t = 0; t <= run.turnEndMs; t += tickMs) {
    applyUpTo(t);
    readings.push({ t, reading: engine.read(t) });
  }
  // ticks rarely land exactly on the turn end, so flush the tail and take the final reading there
  applyUpTo(run.turnEndMs);
  readings.push({ t: run.turnEndMs, reading: engine.read(run.turnEndMs) });

  engine.endTurn({ now: run.turnEndMs, outcome: "completed", tokens: run.finalTokens });
  readings.push({ t: run.turnEndMs, reading: engine.read(run.turnEndMs) });

  const summary = engine.summarize(run.turnEndMs);
  const truthTokens = run.finalTokens - run.baselineTokens;
  return { engine, readings, run, summary, truthTokens };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

describe("engine basis", () => {
  it("reports nothing before a turn starts", () => {
    const reading = new TpsEngine().read(1000);
    expect(reading.state).toBe("idle");
    expect(reading.rate).toBeNull();
    expect(reading.estimatedTokens).toBe(0);
    expect(reading.generationMs).toBe(0);
  });

  it("turns characters into a rate with the configured factor", () => {
    const engine = new TpsEngine({ factors: { answer: 5 }, windowSeconds: 5 });
    engine.startTurn({ now: 0, tokens: 1000 });
    // 50 deltas of 50 chars, one per 100 ms: 2500 chars, and generation time runs from the first delta
    for (let i = 1; i <= 50; i += 1) engine.onDelta({ now: i * 100, kind: "answer", chars: 50 });
    const reading = engine.read(5000);
    expect(reading.state).toBe("streaming");
    // generation is 4.9 s, not the 5 s of wall clock: the wait for the first token is not generation
    expect(reading.rate).toBeCloseTo(500 / 4.9, 5);
    expect(reading.thinkingRate).toBeCloseTo(0, 5);
  });

  it("applies a different factor per kind", () => {
    const thinking = new TpsEngine({ factors: { thinking: 2, answer: 5 } });
    const answer = new TpsEngine({ factors: { thinking: 2, answer: 5 } });
    for (const engine of [thinking, answer]) engine.startTurn({ now: 0, tokens: 0 });
    for (let i = 0; i < 10; i += 1) {
      thinking.onDelta({ now: i * 100, kind: "thinking", chars: 100 });
      answer.onDelta({ now: i * 100, kind: "answer", chars: 100 });
    }
    expect(thinking.estimatedTokensAt(1000)).toBeCloseTo(500, 0); // 1000 chars ÷ 2
    expect(answer.estimatedTokensAt(1000)).toBeCloseTo(200, 0); // 1000 chars ÷ 5
  });

  it("snaps the estimate onto the provider truth when it advances (rebase)", () => {
    const engine = new TpsEngine({ factors: { answer: 4 } });
    engine.startTurn({ now: 0, tokens: 1000 });
    for (let i = 0; i < 40; i += 1) engine.onDelta({ now: i * 100, kind: "answer", chars: 100 });
    expect(engine.estimatedTokensAt(4000)).toBeCloseTo(1000, 0);
    engine.onTokens({ now: 4000, tokens: 1600 }); // provider says 600 tokens so far
    expect(engine.estimatedTokensAt(4000)).toBeCloseTo(600, 0); // snapped down, not stuck high
    engine.onDelta({ now: 4100, kind: "answer", chars: 80 });
    expect(engine.estimatedTokensAt(4100)).toBeCloseTo(620, 0);
  });

  it("counts a provider counter reset as no negative movement", () => {
    const engine = new TpsEngine();
    engine.startTurn({ now: 0, tokens: 500 });
    engine.onTokens({ now: 1000, tokens: 700 }); // +200
    engine.onTokens({ now: 2000, tokens: 610 }); // claude-style per-request reset -> ignored
    engine.onTokens({ now: 3000, tokens: 900 }); // +290 from the new floor
    expect(engine.read(3000).measuredTokens).toBe(490);
    expect(engine.summarize(3000).tokens).toBe(490);
  });

  it("stops counting generation time while a tool call runs", () => {
    const engine = new TpsEngine({ quietStreamMs: 2500 });
    engine.startTurn({ now: 0, tokens: 0 });
    // 1 s of streaming
    for (let i = 1; i <= 10; i += 1) engine.onDelta({ now: i * 100, kind: "answer", chars: 100 });
    // then a tool runs for 10 s, with the model silent
    engine.onToolCall({ now: 1100, callId: "c1", status: "running" });
    const duringTool = engine.read(11_000);
    expect(duringTool.generationMs).toBeLessThan(2000); // the tool wait is not generation
    expect(duringTool.state).toBe("waiting");
    // the rate is held, not decayed to zero
    const beforeTool = engine.read(1100).rate;
    expect(duringTool.rate).toBe(beforeTool);
    expect(duringTool.wallClockAverageRate === null || duringTool.averageRate === null || duringTool.averageRate >= duringTool.wallClockAverageRate).toBe(true);

    // tool finishes; generation resumes only when text does
    engine.onToolCall({ now: 11_100, callId: "c1", status: "completed" });
    const afterTool = engine.read(12_000);
    expect(afterTool.generationMs).toBe(duringTool.generationMs);
    for (let i = 1; i <= 10; i += 1) engine.onDelta({ now: 12_000 + i * 100, kind: "answer", chars: 100 });
    expect(engine.read(13_100).generationMs).toBeGreaterThan(afterTool.generationMs);
  });

  it("ignores a repeated running status for the same tool call", () => {
    const engine = new TpsEngine();
    engine.startTurn({ now: 0, tokens: 0 });
    engine.onDelta({ now: 100, kind: "answer", chars: 100 });
    engine.onToolCall({ now: 200, callId: "c1", status: "running" });
    engine.onToolCall({ now: 300, callId: "c1", status: "running" }); // same call, repeated update
    engine.onToolCall({ now: 400, callId: "c1", status: "completed" }); // one completion, not two
    expect(engine.read(1000).state).not.toBe("waiting");
  });

  it("does not invent a rate when the stream goes quiet, it holds the last one", () => {
    const engine = new TpsEngine({ quietStreamMs: 2000, waitingAfterMs: 6000 });
    engine.startTurn({ now: 0, tokens: 0 });
    for (let i = 1; i <= 30; i += 1) engine.onDelta({ now: i * 100, kind: "answer", chars: 100 });
    const live = engine.read(3000);
    expect(live.state).toBe("streaming");
    const liveRate = live.rate;
    expect(liveRate).toBeGreaterThan(0);

    const quiet = engine.read(6000); // 3 s of silence: paused, but the value stands
    expect(quiet.state).toBe("quiet");
    expect(quiet.rate).toBe(liveRate);

    const waiting = engine.read(12_000);
    expect(waiting.state).toBe("waiting");
    expect(waiting.rate).toBe(liveRate); // deliberately not 0: the shell is not the model
  });

  it("reports no average when the model never streamed anything, keeping wall clock separate", () => {
    const engine = new TpsEngine({ quietStreamMs: 2000, waitingAfterMs: 6000 });
    engine.startTurn({ now: 0, tokens: 0 });
    engine.onTokens({ now: 5000, tokens: 60 }); // a step that only produced tool-call arguments
    const reading = engine.read(5200);
    expect(reading.state).toBe("quiet");
    // no characters means no generation time to divide by: unknown beats a wall-clock number that keeps
    // decaying while a shell command runs
    expect(reading.generationMs).toBe(0);
    expect(reading.averageRate).toBeNull();
    expect(reading.rate).toBeNull();
    expect(reading.wallClockAverageRate).toBeCloseTo(60 / 5.2, 2);
    expect(reading.tokensEstimated).toBe(false);
  });

  it("reports the turn average over generation time once the turn completes", () => {
    const engine = new TpsEngine({ factors: { answer: 4 } });
    engine.startTurn({ now: 0, tokens: 0 });
    for (let i = 1; i <= 20; i += 1) engine.onDelta({ now: i * 100, kind: "answer", chars: 40 });
    engine.endTurn({ now: 10_000, outcome: "completed", tokens: 180 });
    const reading = engine.read(10_000);
    expect(reading.state).toBe("complete");
    expect(reading.measuredTokens).toBe(180);
    // 1s of deltas plus the 2.5s grace, not the 10s wall clock of a turn that then waited on a tool
    expect(reading.generationMs).toBeCloseTo(4400, 0);
    expect(reading.rate).toBeCloseTo(180 / 4.4, 5);
    expect(reading.wallClockAverageRate).toBeCloseTo(18, 5);
  });

  it("flags an estimate when the provider never reported", () => {
    const engine = new TpsEngine({ factors: { answer: 4 } });
    engine.startTurn({ now: 0, tokens: 0 });
    for (let i = 1; i <= 20; i += 1) engine.onDelta({ now: i * 100, kind: "answer", chars: 40 });
    engine.endTurn({ now: 2000, outcome: "canceled" });
    const summary = engine.summarize(2000);
    expect(summary.tokensEstimated).toBe(true);
    expect(summary.outcome).toBe("canceled");
    expect(summary.tokens).toBe(200); // 800 chars ÷ 4
    expect(summary.charsPerSecond).toBeCloseTo(800 / 1.9, 0); // per generation second
  });

  it("clamps windows and factors to sane ranges", () => {
    const engine = new TpsEngine({ windowSeconds: 90, factors: { thinking: 0.1, answer: 99 } });
    expect(engine.getFactors()).toEqual({ thinking: 1.5, answer: 8 });
    engine.setWindowSeconds(1);
    engine.startTurn({ now: 0, tokens: 0 });
    // 30 deltas of 50 chars every 50 ms, up to t=1500. With the clamped 2 s window the rate is measured
    // over 2 s of generation time ending at t=2500, which covers 20 of them -> 1000/8/2 = 62.5
    for (let i = 1; i <= 30; i += 1) engine.onDelta({ now: i * 50, kind: "answer", chars: 50 });
    expect(engine.read(2500).rate).toBeCloseTo(62.5, 5);
  });

  it("ignores deltas and token news after the turn ends", () => {
    const engine = new TpsEngine();
    engine.startTurn({ now: 0, tokens: 0 });
    engine.endTurn({ now: 1000, outcome: "completed", tokens: 10 });
    engine.onDelta({ now: 1100, kind: "answer", chars: 500 });
    engine.onTokens({ now: 1200, tokens: 99 });
    expect(engine.summarize(1200).tokens).toBe(10);
    expect(engine.summarize(1200).answerChars).toBe(0);
  });

  it("is deterministic: the same input twice gives the same reading", () => {
    const first = replay("A2_longtext");
    const second = replay("A2_longtext");
    expect(second.readings).toEqual(first.readings);
  });
});

describe("replay of recorded pi/deepseek turns", () => {
  it("answer-heavy turn: seed factors land within a few percent", () => {
    const { readings, summary } = replay("A2_longtext", { factors: DEFAULT_FACTORS });
    const truth = summary.tps as number;
    expect(summary.tokens).toBeGreaterThan(1822 * 0.9);
    expect(summary.tokens).toBeLessThan(1822 * 1.1);
    const errs = readings
      .filter((r) => r.reading.state === "streaming" && r.reading.rate !== null)
      .map((r) => Math.abs((r.reading.rate as number) - truth) / truth);
    expect(errs.length).toBeGreaterThan(10);
    expect(median(errs)).toBeLessThan(0.25);
  });

  it("thinking-heavy turn: a learned thinking factor beats the seed", () => {
    const rateError = (factors: Partial<TokenFactors>) => {
      const { readings, summary } = replay("D_thinklong", { factors });
      const truth = summary.tps as number;
      const errs = readings
        .filter(({ t, reading }) => t > RECORDED_RUNS.D_thinklong.turnEndMs / 2 && reading.rate !== null && reading.state !== "complete")
        .map(({ reading }) => Math.abs((reading.rate as number) - truth) / truth);
      expect(errs.length).toBeGreaterThan(2);
      return median(errs);
    };
    // documents the measured shape dependence: one global seed cannot serve a thinking-heavy turn
    const seeded = rateError(DEFAULT_FACTORS);
    const learned = rateError({ thinking: 2.21, answer: 5.0 });
    expect(seeded).toBeGreaterThan(0.2);
    expect(learned).toBeLessThan(seeded);
  });

  it("tool-heavy turn: generation time is a small part of a tool-dominated turn", () => {
    const { summary } = replay("C2_toolstall");
    expect(summary.seconds).toBeGreaterThan(10);
    expect(summary.generationSeconds).toBeLessThan(summary.seconds * 0.5);
  });

  it("text, then a long shell wait: the rate is held through the wait, not decayed", () => {
    // the reported bug: "the tps is dropping while the process is just waiting for the shell"
    const { readings, run, summary } = replay("C3_textthenstall");
    const waiting = readings.filter((r) => r.reading.state === "waiting");
    expect(waiting.length).toBeGreaterThan(0);
    const held = waiting.map((r) => r.reading.rate).filter((r): r is number => r !== null);
    expect(held.length).toBeGreaterThan(0);
    for (const rate of held) expect(rate).toBeGreaterThan(0);

    // the rate does not fall during the wait: every waiting reading equals the last live one
    const firstWaiting = waiting[0].reading.rate;
    for (const sample of waiting) expect(sample.reading.rate).toBe(firstWaiting);
    // while the wall clock kept running: the tool call was 8 of the turn's seconds
    expect(summary.seconds - summary.generationSeconds).toBeGreaterThan(6);
    void run;
  });

  it("the shell wait is excluded from the turn average", () => {
    const { summary } = replay("C3_textthenstall");
    // averaging over wall clock made a 28 tok/s model read as 6 tok/s: that is the bug
    expect(summary.tps as number).toBeGreaterThan((summary.wallClockTps as number) * 2);
  });

  it("rebase keeps the estimate at or above the measured truth at every update", () => {
    const { engine, run } = replay("E2_multistep");
    for (const [t, tokens] of run.samples) {
      if (t > run.turnEndMs) continue;
      const truth = Math.max(0, tokens - run.baselineTokens);
      expect(engine.estimatedTokensAt(Math.min(t, run.turnEndMs))).toBeGreaterThanOrEqual(truth - 1);
    }
  });

  it("a finished recorded turn converges on the measured tokens", () => {
    for (const name of Object.keys(RECORDED_RUNS) as (keyof typeof RECORDED_RUNS)[]) {
      const { engine, run } = replay(name);
      const summary = engine.summarize(run.turnEndMs);
      expect(summary.tokensEstimated).toBe(false);
      expect(summary.tokens).toBe(run.finalTokens - run.baselineTokens);
    }
  });

  it("keeps thinking and answer characters apart", () => {
    const { engine, run } = replay("A2_longtext");
    const summary = engine.summarize(run.turnEndMs);
    const thinking = run.deltas.filter((d) => d[1] === "thinking").reduce((s, d) => s + d[2], 0);
    const answer = run.deltas.filter((d) => d[1] === "answer").reduce((s, d) => s + d[2], 0);
    expect(summary.thinkingChars).toBe(thinking);
    expect(summary.answerChars).toBe(answer);
  });
});
