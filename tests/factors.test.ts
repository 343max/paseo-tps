import { describe, expect, it } from "vitest";
import { DEFAULT_FACTORS, TpsEngine, type Reading, type TokenFactors } from "../client/engine";
import { FactorBook, fitMedianFactor, fitSplitFactors, isQualifying, type TurnObservation } from "../client/factors";
import { RECORDED_RUNS } from "./fixtures/runs";

const observationOf = (name: keyof typeof RECORDED_RUNS): TurnObservation => {
  const run = RECORDED_RUNS[name];
  return {
    thinkingChars: run.deltas.filter((d) => d[1] === "thinking").reduce((s, d) => s + d[2], 0),
    answerChars: run.deltas.filter((d) => d[1] === "answer").reduce((s, d) => s + d[2], 0),
    tokens: run.finalTokens - run.baselineTokens,
  };
};

/** Replays a run and reports the median relative error of its live rates against the turn's own average. */
function liveRateError(name: keyof typeof RECORDED_RUNS, factors: Partial<TokenFactors>): number {
  const run = RECORDED_RUNS[name];
  const engine = new TpsEngine({ factors });
  engine.startTurn({ now: 0, tokens: run.baselineTokens, provider: "pi", model: "deepseek/deepseek-flash" });
  const events: { t: number; delta?: [number, string, number]; tool?: [number, string, string]; sample?: [number, number] }[] = [
    ...run.deltas.map((d) => ({ t: d[0], delta: d as [number, string, number] })),
    ...run.tools.map((tool) => ({ t: tool[0], tool: tool as [number, string, string] })),
    ...run.samples.map((s) => ({ t: s[0], sample: s as [number, number] })),
  ].sort((a, b) => a.t - b.t);
  const rates: { t: number; reading: Reading }[] = [];
  let index = 0;
  for (let t = 0; t <= run.turnEndMs; t += 250) {
    while (index < events.length && events[index].t <= t) {
      const event = events[index];
      if (event.delta) engine.onDelta({ now: event.t, kind: event.delta[1] as "thinking" | "answer", chars: event.delta[2] });
      else if (event.tool) engine.onToolCall({ now: event.t, callId: event.tool[1], status: event.tool[2] });
      else if (event.sample) engine.onTokens({ now: event.t, tokens: event.sample[1] });
      index += 1;
    }
    rates.push({ t, reading: engine.read(t) });
  }
  engine.endTurn({ now: run.turnEndMs, outcome: "completed", tokens: run.finalTokens });
  const truth = engine.summarize(run.turnEndMs).tps;
  if (truth === null) return Number.NaN;
  const errs = rates
    .filter(({ t, reading }) => t > run.turnEndMs / 3 && reading.rate !== null && reading.state !== "complete")
    .map(({ reading }) => Math.abs((reading.rate as number) - truth) / truth);
  const sorted = [...errs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe("qualification", () => {
  it("ignores turns whose characters do not represent their tokens", () => {
    // tool-heavy: almost no text, plenty of tokens (measured 0.16 chars/token)
    expect(isQualifying({ thinkingChars: 0, answerChars: 14, tokens: 89 })).toBe(false);
    expect(isQualifying({ thinkingChars: 0, answerChars: 148, tokens: 198 })).toBe(false);
    // too little text to say anything, even though the ratio looks plausible
    expect(isQualifying({ thinkingChars: 50, answerChars: 50, tokens: 40 })).toBe(false);
    // no tokens reported
    expect(isQualifying({ thinkingChars: 500, answerChars: 500, tokens: 0 })).toBe(false);
    // answer-heavy and thinking-heavy turns both qualify
    expect(isQualifying(observationOf("A2_longtext"))).toBe(true);
    expect(isQualifying(observationOf("D_thinklong"))).toBe(true);
  });
});

describe("fitting", () => {
  it("recovers the measured per-kind ratios from real turns", () => {
    const fitted = fitSplitFactors([
      observationOf("A2_longtext"),
      observationOf("B_thinking"),
      observationOf("D_thinklong"),
    ]);
    expect(fitted).not.toBeNull();
    // the spike measured thinking 2.2-3.4 and answer 5.0-5.2 on this model
    expect(fitted?.thinking).toBeGreaterThan(2.0);
    expect(fitted?.thinking).toBeLessThan(2.6);
    expect(fitted?.answer).toBeGreaterThan(4.4);
    expect(fitted?.answer).toBeLessThan(5.8);
    // and the split is bigger than the seeds' split, which is the whole point
    expect((fitted?.answer as number) / (fitted?.thinking as number)).toBeGreaterThan(
      DEFAULT_FACTORS.answer / DEFAULT_FACTORS.thinking,
    );
  });

  it("needs at least three turns before trusting a split", () => {
    expect(fitSplitFactors([observationOf("A2_longtext")])).toBeNull();
    expect(fitSplitFactors([observationOf("A2_longtext"), observationOf("D_thinklong")])).toBeNull();
  });

  it("refuses a degenerate fit when every turn has the same shape", () => {
    const same = { thinkingChars: 900, answerChars: 100, tokens: 200 };
    expect(fitSplitFactors([same, same, same])).toBeNull();
    // and the median fallback still produces a usable single factor
    expect(fitMedianFactor([same, same, same])).toBeCloseTo(5, 1);
  });

  it("falls back to the median ratio when there is history but no split", () => {
    expect(fitMedianFactor([])).toBeNull();
    expect(fitMedianFactor([{ thinkingChars: 0, answerChars: 400, tokens: 100 }])).toBeCloseTo(4, 5);
  });
});

describe("FactorBook", () => {
  it("returns the seeds until it has learned something", () => {
    const book = new FactorBook();
    const key = FactorBook.key("pi", "deepseek/deepseek-flash");
    expect(book.factorsFor(key)).toEqual(DEFAULT_FACTORS);
    expect(book.isLearned(key)).toBe(false);
    expect(book.sampleCount(key)).toBe(0);
  });

  it("keeps the seeds until a split can be identified, then moves towards it", () => {
    const book = new FactorBook();
    const key = FactorBook.key("pi", "m");
    book.record(key, observationOf("D_thinklong"));
    expect(book.factorsFor(key)).toEqual(DEFAULT_FACTORS); // one turn cannot identify two unknowns
    book.record(key, observationOf("B_thinking"));
    expect(book.factorsFor(key)).toEqual(DEFAULT_FACTORS);

    book.record(key, observationOf("A2_longtext"));
    expect(book.sampleCount(key)).toBe(3);
    const shrunk = book.factorsFor(key);
    // moved towards the fitted split, but only part of the way at three turns
    expect(shrunk.thinking).toBeLessThan(DEFAULT_FACTORS.thinking);
    expect(shrunk.thinking).toBeGreaterThan(2.2);
    expect(shrunk.answer).toBeGreaterThan(DEFAULT_FACTORS.answer - 0.5);
  });

  it("trusts the model more as its history grows", () => {
    const book = new FactorBook();
    const key = FactorBook.key("pi", "m");
    const shapes = [observationOf("D_thinklong"), observationOf("B_thinking"), observationOf("A2_longtext")];
    shapes.forEach((shape) => book.record(key, shape));
    const thin = book.factorsFor(key).thinking;
    for (let i = 0; i < 20; i += 1) book.record(key, shapes[i % shapes.length]);
    const thick = book.factorsFor(key).thinking;
    const fitted = fitSplitFactors(new Array(23).fill(shapes).flat()) as TokenFactors;
    expect(Math.abs(thick - fitted.thinking)).toBeLessThan(Math.abs(thin - fitted.thinking));
  });

  it("never records a turn that would poison the fit", () => {
    const book = new FactorBook();
    const key = FactorBook.key("pi", "m");
    book.record(key, observationOf("C2_toolstall")); // 0.16 chars/token
    book.record(key, observationOf("E2_multistep")); // 0.75 chars/token
    expect(book.sampleCount(key)).toBe(0);
    expect(book.factorsFor(key)).toEqual(DEFAULT_FACTORS);
  });

  it("keeps history bounded and refreshes the cached fit", () => {
    const book = new FactorBook();
    const key = FactorBook.key("pi", "m");
    const first = book.factorsFor(key);
    // two alternating shapes, so a split is identifiable
    for (let i = 0; i < 40; i += 1) {
      book.record(
        key,
        i % 2 === 0
          ? { thinkingChars: 700, answerChars: 100, tokens: 200 }
          : { thinkingChars: 100, answerChars: 900, tokens: 200 },
      );
    }
    expect(book.sampleCount(key)).toBe(30);
    const second = book.factorsFor(key);
    expect(first).toEqual(DEFAULT_FACTORS);
    expect(second).not.toEqual(DEFAULT_FACTORS);
    // bounded history means the newest turns win: 30 samples keep 15 of each shape, and the factor is the
    // seeds blended with that fitted split
    const kept = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? { thinkingChars: 700, answerChars: 100, tokens: 200 }
        : { thinkingChars: 100, answerChars: 900, tokens: 200 },
    );
    const fitted = fitSplitFactors(kept) as TokenFactors;
    const weight = 30 / 34;
    expect(second.thinking).toBeCloseTo(DEFAULT_FACTORS.thinking * (1 - weight) + fitted.thinking * weight, 5);
    expect(second.answer).toBeCloseTo(DEFAULT_FACTORS.answer * (1 - weight) + fitted.answer * weight, 5);
  });

  it("keys factors per provider and model", () => {
    const book = new FactorBook();
    const fast = FactorBook.key("pi", "fast");
    [
      observationOf("D_thinklong"),
      observationOf("B_thinking"),
      observationOf("A2_longtext"),
    ].forEach((shape) => book.record(fast, shape));
    expect(book.factorsFor(fast)).not.toEqual(DEFAULT_FACTORS);
    // a different model, and a different provider with the same model name, both stay on the seeds
    expect(book.factorsFor(FactorBook.key("pi", "other"))).toEqual(DEFAULT_FACTORS);
    expect(book.factorsFor(FactorBook.key("codex", "fast"))).toEqual(DEFAULT_FACTORS);
  });
});

describe("learned factors improve the live number", () => {
  it("beats the seeds on a thinking-heavy turn", () => {
    const fitted = fitSplitFactors([
      observationOf("A2_longtext"),
      observationOf("B_thinking"),
      observationOf("D_thinklong"),
    ]);
    expect(fitted).not.toBeNull();
    const seeded = liveRateError("D_thinklong", DEFAULT_FACTORS);
    const learned = liveRateError("D_thinklong", fitted as TokenFactors);
    expect(learned).toBeLessThan(seeded);
    expect(learned).toBeLessThan(0.2);
  });

  it("trades a little accuracy on the shape the seeds suit for a lot on the one they do not", () => {
    // the seeds (2.8 / 5.0) were tuned on answer-heavy runs, so they are good there and bad on a
    // thinking-heavy turn. Learning rebalances that, and the trade should be clearly worth making.
    const fitted = fitSplitFactors([
      observationOf("A2_longtext"),
      observationOf("B_thinking"),
      observationOf("D_thinklong"),
    ]) as TokenFactors;
    const answerHeavySeeded = liveRateError("A2_longtext", DEFAULT_FACTORS);
    const answerHeavyLearned = liveRateError("A2_longtext", fitted);
    const thinkingHeavySeeded = liveRateError("D_thinklong", DEFAULT_FACTORS);
    const thinkingHeavyLearned = liveRateError("D_thinklong", fitted);

    // measured on the recorded turns: answer-heavy regresses from 4.7% to 7.8% median error, while
    // thinking-heavy improves from 21.6% to 6.1% (and the short thinking-heavy turn from 30% to 12%)
    expect(answerHeavyLearned - answerHeavySeeded).toBeLessThan(0.05); // small cost
    expect(thinkingHeavySeeded - thinkingHeavyLearned).toBeGreaterThan(0.1); // clear gain
    expect(thinkingHeavyLearned).toBeLessThan(0.2);
  });
});
