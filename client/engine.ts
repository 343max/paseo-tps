/**
 * Pure tokens-per-second engine. No React, no Node, no Paseo imports: it takes timestamps and
 * numbers, and returns readings. The observer feeds it real events; the tests feed it recorded ones.
 *
 * Why it looks like this (measured, see .spike/ and the plan):
 *
 * - The provider's token counter is the only *measured* truth, but on a plain generation turn it does
 *   not move at all until the turn ends (pi reports session stats once per completed step). So the live
 *   number has to be extrapolated from streamed characters and then corrected.
 * - Characters are not tokens: a thinking-heavy turn ran at 2.2 chars/token, an answer-heavy turn at
 *   4.9. Hence a factor per kind, not one factor.
 * - Therefore: "rebase". Whenever the token truth advances we snap the estimate onto it and count
 *   characters forward from there. Between advances the estimate moves only with real streamed text,
 *   and at every advance it is exactly right, so it cannot drift or stay permanently high.
 *
 * Speed is measured per *generation* time, not per wall-clock turn time. A tool-heavy pi turn spent most
 * of its wall clock waiting for a shell command: 73 tok/s while streaming, 28 tok/s if you divide by the
 * turn's wall clock. So the generation clock runs only while the model is the thing being waited on:
 * between the first streamed delta of a step and a short grace period after the last one, and never while
 * a tool call is executing. While the clock is stopped the reading holds its most recent value instead of
 * decaying towards zero, and the turn average divides by generation time.
 */

export type DeltaKind = "thinking" | "answer";

export interface TokenFactors {
  /** Characters per token for streamed reasoning text. */
  thinking: number;
  /** Characters per token for streamed answer text. */
  answer: number;
}

/** Measured on pi/deepseek-flash: thinking ~2.2-3.4, answer ~5.0-5.2 chars/token. */
export const DEFAULT_FACTORS: TokenFactors = { thinking: 2.8, answer: 5.0 };

export const FACTOR_MIN = 1.5;
export const FACTOR_MAX = 8;

export const WINDOW_MIN_SECONDS = 2;
export const WINDOW_MAX_SECONDS = 15;

/**
 * Below this much observed generation there is not enough evidence for a live rate, so the last value is
 * held instead. Deliberately small: the recorded C3 turn generated its whole answer in 396 ms before a
 * shell command took over, and refusing to show a rate for that would be worse than showing it.
 */
export const MIN_LIVE_GENERATION_SECONDS = 0.25;
/** A rate is measured over at least this much generation time, however long it took in wall clock. */
const MIN_RATE_SPAN_SECONDS = 0.5;
/**
 * Below this the average is unknown: dividing by a sliver of generation time is not a rate, and falling
 * back to the wall clock would count tool waits as generation, which is the bug this engine exists to avoid.
 */
const MIN_AVERAGE_GENERATION_SECONDS = 0.05;

export type EngineState = "idle" | "streaming" | "thinking" | "quiet" | "waiting" | "complete";
/**
 * `unknown` is for a turn the observer watched end without receiving the outcome, typically because it
 * attached mid-turn or the stream dropped. The ledger records it as incomplete rather than guessing.
 */
export type TurnOutcome = "completed" | "failed" | "canceled" | "unknown";

export interface EngineOptions {
  /** Smoothing window for the live rate, measured in generation seconds. */
  windowSeconds?: number;
  factors?: Partial<TokenFactors>;
  /**
   * How long the model is still considered to be generating after its last streamed delta. Short gaps
   * inside a step count; longer pauses and tool waits do not.
   */
  quietStreamMs?: number;
  /** A pause this long with no deltas and no token news is reported as waiting rather than quiet. */
  waitingAfterMs?: number;
}

export interface TurnStartInput {
  now: number;
  /**
   * Provider's output-token counter at turn start. Session-cumulative on some providers.
   * `null` means the observer attached without knowing the value (for example it discovered a turn that
   * was already running); the first value seen then becomes the baseline instead of being counted.
   */
  tokens: number | null;
  turnId?: string | null;
  provider?: string;
  model?: string;
}

export interface Reading {
  state: EngineState;
  /** Kind of the most recent delta, or null before the first one. */
  lastKind: DeltaKind | null;
  /**
   * Most recent live rate in tokens per generation second, or null before there is enough evidence.
   * While the clock is stopped (tool call, pause) this holds the last measured value.
   */
  rate: number | null;
  /** Character-derived rates per kind (a rebase cannot be attributed to a kind). */
  thinkingRate: number | null;
  answerRate: number | null;
  /** Rebase-corrected running estimate of tokens produced this turn. */
  estimatedTokens: number;
  /** Tokens the provider actually reported this turn. */
  measuredTokens: number;
  /** True when the provider has reported nothing, so only the estimate exists. */
  tokensEstimated: boolean;
  /** Wall-clock time since the turn started, including tool waits and pauses. */
  elapsedMs: number;
  /** Time the model was the thing being waited on. This is the denominator for every rate. */
  generationMs: number;
  /** Measured (or estimated) tokens over generation time. */
  averageRate: number | null;
  /** The same tokens over wall clock, for comparing "how fast is the model" with "what did it cost me". */
  wallClockAverageRate: number | null;
  charsPerSecond: number;
  outcome: TurnOutcome | null;
}

interface Delta {
  t: number;
  kind: DeltaKind;
  chars: number;
  /** Cumulative characters of each kind up to and including this delta. */
  cum: { thinking: number; answer: number };
  /** Generation milliseconds accumulated at this point, so a rate window can be walked back. */
  g: number;
}

interface TruthPoint {
  t: number;
  tokens: number;
  /** Per-kind character totals at the moment this truth became known. */
  charsAt: { thinking: number; answer: number };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function clampFactor(value: number): number {
  return clamp(value, FACTOR_MIN, FACTOR_MAX);
}

export function clampWindowSeconds(value: number): number {
  return clamp(value, WINDOW_MIN_SECONDS, WINDOW_MAX_SECONDS);
}

export class TpsEngine {
  private windowSeconds: number;
  private factors: TokenFactors;
  private quietStreamMs: number;
  private waitingAfterMs: number;

  private startedAt: number | null = null;
  private turnId: string | null = null;
  private provider: string | null = null;
  private model: string | null = null;
  private outcome: TurnOutcome | null = null;

  /** Last provider value we saw; a drop means the provider counter reset (per-request providers). */
  private lastSeenTokens = 0;
  /** False until the first token value arrives, when the observer could not read a baseline up front. */
  private baselineKnown = true;
  /** Monotone sum of positive provider deltas - the turn's measured tokens. */
  private measuredTokens = 0;

  private deltas: Delta[] = [];
  private totals = { thinking: 0, answer: 0 };
  private truth: TruthPoint[] = [];
  private lastDeltaAt: number | null = null;
  private lastTruthAt: number | null = null;

  /** Accumulated generation milliseconds, and the wall clock they were last advanced to. */
  private generationMs = 0;
  private clockTickAt: number | null = null;
  /** Tool calls currently executing; while any is running, the model is not being waited on. */
  private runningToolCalls = new Set<string>();
  /** When the current run of tool calls began, used to cut the generation clock at the tool boundary. */
  private toolWindowStart: number | null = null;
  /** Last rate measured from real generation, held while the clock is stopped. */
  private lastLiveRate: number | null = null;

  constructor(options: EngineOptions = {}) {
    this.windowSeconds = clampWindowSeconds(options.windowSeconds ?? 5);
    this.factors = {
      thinking: clampFactor(options.factors?.thinking ?? DEFAULT_FACTORS.thinking),
      answer: clampFactor(options.factors?.answer ?? DEFAULT_FACTORS.answer),
    };
    this.quietStreamMs = options.quietStreamMs ?? 2500;
    this.waitingAfterMs = options.waitingAfterMs ?? 6000;
  }

  startTurn(input: TurnStartInput): void {
    this.startedAt = input.now;
    this.turnId = input.turnId ?? null;
    this.provider = input.provider ?? null;
    this.model = input.model ?? null;
    this.outcome = null;
    this.baselineKnown = typeof input.tokens === "number";
    this.lastSeenTokens = input.tokens ?? 0;
    this.measuredTokens = 0;
    this.deltas = [];
    this.totals = { thinking: 0, answer: 0 };
    this.lastDeltaAt = null;
    this.lastTruthAt = null;
    this.truth = [{ t: input.now, tokens: 0, charsAt: { thinking: 0, answer: 0 } }];
    this.generationMs = 0;
    this.clockTickAt = input.now;
    this.runningToolCalls.clear();
    this.lastLiveRate = null;
  }

  /** Streamed characters. `chars` is the length of this delta, not the accumulated message. */
  onDelta(input: { now: number; kind: DeltaKind; chars: number }): void {
    if (this.startedAt === null || this.outcome !== null || input.chars <= 0) return;
    this.advanceClock(input.now);
    this.totals[input.kind] += input.chars;
    this.deltas.push({
      t: input.now,
      kind: input.kind,
      chars: input.chars,
      cum: { ...this.totals },
      g: this.generationMs,
    });
    this.lastDeltaAt = input.now;
  }

  /**
   * Absolute provider output-token value. Increases are counted; a decrease is a provider counter
   * reset (claude reports per-request values), so the new value becomes the floor and nothing is
   * subtracted - that keeps the turn total a sum of positive movement.
   */
  onTokens(input: { now: number; tokens: number }): void {
    if (this.startedAt === null || this.outcome !== null) return;
    this.advanceClock(input.now);
    if (!this.baselineKnown) {
      // We attached without a baseline: the first value defines it, so an already-running turn is not
      // credited with every token its session has ever produced.
      this.baselineKnown = true;
      this.lastSeenTokens = input.tokens;
      return;
    }
    const previous = this.lastSeenTokens;
    if (input.tokens <= previous) {
      this.lastSeenTokens = input.tokens;
      return;
    }
    this.measuredTokens += input.tokens - previous;
    this.lastSeenTokens = input.tokens;
    this.lastTruthAt = input.now;
    this.truth.push({
      t: input.now,
      tokens: this.measuredTokens,
      charsAt: { ...this.totals },
    });
  }

  /**
   * A tool call starting or finishing. While one runs, the model is not being waited on, so generation
   * time stops accumulating: that is the difference between "how fast is the model" and "how long did the
   * shell take".
   */
  onToolCall(input: { now: number; callId?: string | null; status: string }): void {
    if (this.startedAt === null || this.outcome !== null) return;
    this.advanceClock(input.now);
    const id = input.callId ?? `anonymous-${input.status}`;
    if (input.status === "running") {
      if (this.runningToolCalls.size === 0) this.toolWindowStart = input.now;
      this.runningToolCalls.add(id);
    } else {
      this.runningToolCalls.delete(id);
      if (this.runningToolCalls.size === 0) this.toolWindowStart = null;
    }
  }

  endTurn(input: { now: number; outcome: TurnOutcome; tokens?: number }): void {
    if (this.startedAt === null) return;
    this.advanceClock(input.now);
    if (typeof input.tokens === "number") this.onTokens({ now: input.now, tokens: input.tokens });
    this.outcome = input.outcome;
  }

  /**
   * Accumulates generation time for the interval just gone. Safe to call repeatedly with the same now.
   *
   * The clock follows the stream: it starts at the first delta of a step and stops a grace period after the
   * last one. A tool call cuts it short at the moment the tool started - but only when that start came
   * *after* the most recent delta. That detail matters: the daemon emits the tool_call item before the rest
   * of the step's text arrives, so a blanket "a tool is running" pause swallowed deltas that were still
   * being generated (caught by the C3 recorded turn).
   */
  private advanceClock(now: number): void {
    const previous = this.clockTickAt;
    this.clockTickAt = now;
    if (previous === null || this.startedAt === null || this.outcome !== null) return;
    if (now <= previous) return;
    if (this.lastDeltaAt === null) return;
    const from = Math.max(previous, this.lastDeltaAt);
    let until = Math.min(now, this.lastDeltaAt + this.quietStreamMs);
    if (this.runningToolCalls.size > 0 && this.toolWindowStart !== null && this.toolWindowStart > this.lastDeltaAt) {
      until = Math.min(until, this.toolWindowStart);
    }
    if (until > from) this.generationMs += until - from;
  }

  setFactors(factors: Partial<TokenFactors>): void {
    if (factors.thinking !== undefined) this.factors.thinking = clampFactor(factors.thinking);
    if (factors.answer !== undefined) this.factors.answer = clampFactor(factors.answer);
  }

  setWindowSeconds(value: number): void {
    this.windowSeconds = clampWindowSeconds(value);
  }

  getFactors(): TokenFactors {
    return { ...this.factors };
  }

  getIdentity(): { turnId: string | null; provider: string | null; model: string | null } {
    return { turnId: this.turnId, provider: this.provider, model: this.model };
  }

  isActive(): boolean {
    return this.startedAt !== null && this.outcome === null;
  }

  /** Cumulative characters of a kind up to `now` (binary search: deltas are time-ordered). */
  private charsAtKind(now: number, kind: DeltaKind): number {
    let low = 0;
    let high = this.deltas.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.deltas[mid].t <= now) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found < 0 ? 0 : this.deltas[found].cum[kind];
  }

  private truthAt(now: number): TruthPoint {
    // Before startTurn there is no truth at all, and `read()` is still allowed to answer.
    if (this.truth.length === 0) return { t: now, tokens: 0, charsAt: { thinking: 0, answer: 0 } };
    let low = 0;
    let high = this.truth.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.truth[mid].t <= now) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return this.truth[found] ?? { t: now, tokens: 0, charsAt: { thinking: 0, answer: 0 } };
  }

  /** Rebase-corrected estimate of tokens produced up to `now`. */
  estimatedTokensAt(now: number): number {
    const truth = this.truthAt(now);
    const chars = { thinking: this.charsAtKind(now, "thinking"), answer: this.charsAtKind(now, "answer") };
    const thinking = (chars.thinking - truth.charsAt.thinking) / this.factors.thinking;
    const answer = (chars.answer - truth.charsAt.answer) / this.factors.answer;
    return truth.tokens + Math.max(0, thinking) + Math.max(0, answer);
  }

  private resolvedTokens(now: number): { tokens: number; estimated: boolean } {
    if (this.measuredTokens > 0) return { tokens: this.measuredTokens, estimated: false };
    return { tokens: this.estimatedTokensAt(now), estimated: true };
  }

  /**
   * The wall-clock moment that is `windowSeconds` of *generation* time before `now`, used as the start of
   * the rate window. Walking the delta list keeps tool waits and long pauses out of the denominator.
   */
  private rateWindowStart(): { t: number; g: number } | null {
    if (this.startedAt === null || this.lastDeltaAt === null) return null;
    const target = this.generationMs - this.windowSeconds * 1000;
    let base = { t: this.startedAt, g: 0 };
    for (const delta of this.deltas) {
      if (delta.g <= target) base = { t: delta.t, g: delta.g };
      else break;
    }
    return base;
  }

  /**
   * Tokens over generation time, with a wall-clock fallback for turns where there is too little observed
   * generation to divide by (a token-only turn, for example): some honest number beats none.
   */
  /**
   * Tokens over generation time, and nothing else. A turn where the model never emitted anything we could
   * see (a step that produced only tool-call arguments, for instance) has no generation time to divide by,
   * so the average is unknown rather than a wall-clock number that decays while a shell command runs. The
   * wall-clock figure is still reported separately as `wallClockAverageRate` for anyone who wants it.
   */
  private averageRateFor(now: number, tokens: number): number | null {
    void now;
    const generationSeconds = this.generationMs / 1000;
    if (generationSeconds < MIN_AVERAGE_GENERATION_SECONDS) return null;
    return tokens / generationSeconds;
  }

  read(now: number): Reading {
    this.advanceClock(now);
    const elapsedMs = this.startedAt === null ? 0 : now - this.startedAt;
    const resolved = this.resolvedTokens(now);
    const generationSeconds = this.generationMs / 1000;
    const averageRate = this.averageRateFor(now, resolved.tokens);
    const wallClockAverageRate = elapsedMs > 250 ? resolved.tokens / (elapsedMs / 1000) : null;

    const base: Reading = {
      state: "idle",
      lastKind: null,
      rate: null,
      thinkingRate: null,
      answerRate: null,
      estimatedTokens: 0,
      measuredTokens: this.measuredTokens,
      tokensEstimated: false,
      elapsedMs,
      generationMs: this.generationMs,
      averageRate: null,
      wallClockAverageRate: null,
      charsPerSecond: 0,
      outcome: this.outcome,
    };
    if (this.startedAt === null) return base;

    const lastKind = this.deltas.length ? this.deltas[this.deltas.length - 1].kind : null;
    const reading: Reading = {
      ...base,
      estimatedTokens: resolved.tokens,
      tokensEstimated: resolved.estimated,
      averageRate,
      wallClockAverageRate,
      lastKind,
    };

    if (this.outcome !== null) {
      // Finished: the generation-time average is the number that matters, and it is exact when the
      // provider reported its tokens.
      return { ...reading, state: "complete", rate: averageRate };
    }

    const sinceDelta = this.lastDeltaAt === null ? null : now - this.lastDeltaAt;
    const streamQuiet = sinceDelta === null || sinceDelta > this.quietStreamMs;
    const toolRunning = this.runningToolCalls.size > 0;
    const waiting = toolRunning || (sinceDelta !== null && sinceDelta > this.waitingAfterMs);

    if (this.lastDeltaAt === null) {
      // Nothing has streamed yet. Fresh token movement means the model is producing something, and the
      // turn average is then the only defensible number; otherwise we simply do not know yet.
      const freshTokens = this.lastTruthAt !== null && now - this.lastTruthAt <= this.waitingAfterMs;
      return { ...reading, state: "quiet", rate: freshTokens ? averageRate : this.lastLiveRate };
    }

    if (waiting) {
      // Waiting on a tool, or on a model that has gone silent: hold the most recent value. Reporting a
      // decayed rate here is what made a 73 tok/s model look like 28 tok/s.
      return { ...reading, state: "waiting", rate: this.lastLiveRate };
    }

    if (streamQuiet) {
      return { ...reading, state: "quiet", rate: this.lastLiveRate };
    }

    // Actively generating: measure over the last window of generation time.
    const window = this.rateWindowStart();
    if (!window || generationSeconds < MIN_LIVE_GENERATION_SECONDS) {
      return { ...reading, state: lastKind === "thinking" ? "thinking" : "streaming", rate: this.lastLiveRate };
    }
    const spanSeconds = Math.max(MIN_RATE_SPAN_SECONDS, (this.generationMs - window.g) / 1000);
    const rate = (this.estimatedTokensAt(now) - this.estimatedTokensAt(window.t)) / spanSeconds;
    const thinkingChars = this.charsAtKind(now, "thinking") - this.charsAtKind(window.t, "thinking");
    const answerChars = this.charsAtKind(now, "answer") - this.charsAtKind(window.t, "answer");
    const charsPerSecond = (thinkingChars + answerChars) / spanSeconds;
    this.lastLiveRate = Number.isFinite(rate) && rate > 0 ? rate : this.lastLiveRate;
    return {
      ...reading,
      state: lastKind === "thinking" ? "thinking" : "streaming",
      rate: this.lastLiveRate,
      thinkingRate: thinkingChars / this.factors.thinking / spanSeconds,
      answerRate: answerChars / this.factors.answer / spanSeconds,
      charsPerSecond,
    };
  }

  /** The turn as the ledger and the timeline row need it. */
  summarize(now: number): {
    turnId: string | null;
    provider: string | null;
    model: string | null;
    outcome: TurnOutcome | null;
    seconds: number;
    generationSeconds: number;
    tokens: number;
    tokensEstimated: boolean;
    tps: number | null;
    wallClockTps: number | null;
    thinkingChars: number;
    answerChars: number;
    charsPerSecond: number;
    factors: TokenFactors;
  } {
    this.advanceClock(now);
    const seconds = this.startedAt === null ? 0 : (now - this.startedAt) / 1000;
    const generationSeconds = this.generationMs / 1000;
    const resolved = this.resolvedTokens(now);
    const tps = this.averageRateFor(now, resolved.tokens);
    return {
      turnId: this.turnId,
      provider: this.provider,
      model: this.model,
      outcome: this.outcome,
      seconds,
      generationSeconds,
      tokens: Math.round(resolved.tokens),
      tokensEstimated: resolved.estimated,
      tps,
      wallClockTps: seconds > 0 ? resolved.tokens / seconds : null,
      thinkingChars: this.totals.thinking,
      answerChars: this.totals.answer,
      charsPerSecond: generationSeconds > 0 ? (this.totals.thinking + this.totals.answer) / generationSeconds : 0,
      factors: this.getFactors(),
    };
  }
}
