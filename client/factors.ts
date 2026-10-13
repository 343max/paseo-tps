/**
 * Learns how many characters this model emits per token, per kind.
 *
 * Why this exists: the live rate is characters divided by a chars-per-token factor, and the provider only
 * tells us the true token count at step boundaries. Seeded factors (thinking 2.8, answer 5.0) are a guess
 * that the spike showed can be ~2x off: on pi/deepseek-flash, answer-heavy turns ran at 4.31-4.91
 * chars/token while thinking-heavy turns ran at 2.21-2.39. Every finished turn is a free measurement -
 * the provider reported tokens, and we counted the characters - so the factors can be fitted from the
 * model's own history instead of assumed.
 *
 * Pure: no timers, no React, no I/O. The observer owns when to record and when to ask.
 */

import { clampFactor, DEFAULT_FACTORS, type TokenFactors } from "./engine";

export interface TurnObservation {
  thinkingChars: number;
  answerChars: number;
  /** Tokens the provider reported for this turn. Never an estimate - see `isQualifying`. */
  tokens: number;
}

/** How many turns of history one provider+model keeps. Old behaviour matters less than recent behaviour. */
export const HISTORY_LIMIT = 30;

/** Below this many turns the two-parameter fit is not trusted and a single ratio is used instead. */
const MIN_TURNS_FOR_SPLIT = 3;

/**
 * A turn only teaches us something when the characters it streamed actually represent its tokens.
 * Tool-heavy turns stream almost nothing while producing many tokens (measured: 0.16 chars/token), and
 * including them would drag every factor towards nonsense.
 */
export function isQualifying(observation: TurnObservation): boolean {
  const chars = observation.thinkingChars + observation.answerChars;
  if (observation.tokens <= 0 || chars < 200) return false;
  const ratio = chars / observation.tokens;
  return ratio >= 1.5 && ratio <= 12;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Fits thinking and answer factors by least squares over `tokens = thinking/api + answer/answerFactor`.
 * Returns null when there is not enough signal, so callers fall back rather than trust a wild fit.
 */
export function fitSplitFactors(observations: TurnObservation[]): TokenFactors | null {
  const usable = observations.filter(isQualifying);
  if (usable.length < MIN_TURNS_FOR_SPLIT) return null;

  const sum = (f: (o: TurnObservation) => number, g: (o: TurnObservation) => number) =>
    usable.reduce((total, o) => total + f(o) * g(o), 0);
  const weighted = (f: (o: TurnObservation) => number) => usable.reduce((total, o) => total + f(o) * o.tokens, 0);

  const a11 = sum((o) => o.thinkingChars, (o) => o.thinkingChars);
  const a12 = sum((o) => o.thinkingChars, (o) => o.answerChars);
  const a22 = sum((o) => o.answerChars, (o) => o.answerChars);
  const b1 = weighted((o) => o.thinkingChars);
  const b2 = weighted((o) => o.answerChars);
  const determinant = a11 * a22 - a12 * a12;
  // A degenerate system means every turn had the same shape; there is no split to learn.
  if (Math.abs(determinant) < 1e-9) return null;

  const thinkingInverse = (b1 * a22 - b2 * a12) / determinant;
  const answerInverse = (a11 * b2 - a12 * b1) / determinant;
  if (thinkingInverse <= 0 || answerInverse <= 0) return null;

  return { thinking: clampFactor(1 / thinkingInverse), answer: clampFactor(1 / answerInverse) };
}

/**
 * A single factor from the median of per-turn ratios. Kept for diagnostics and tests; production uses the
 * shrunk per-kind fit, because a flat factor cannot express the measured difference between thinking text
 * (2.2-3.4 chars/token) and answer text (5.0-5.2).
 */
export function fitMedianFactor(observations: TurnObservation[]): number | null {
  const ratios = observations.filter(isQualifying).map((o) => (o.thinkingChars + o.answerChars) / o.tokens);
  if (!ratios.length) return null;
  return clampFactor(median(ratios));
}

/**
 * How strongly a fit is pulled towards the seeds. With the same number of turns as this constant, the fit
 * gets half the weight. The spike's leave-one-out comparison showed why this is needed: at three turns the
 * raw split was worse than the seeds on the shape that was underrepresented in the sample (A2: 33% rate
 * error for the raw fit versus 24% for the seeds), because two unknowns cannot be identified from three
 * correlated turns. Shrinking means a thin history can only nudge the number, and a thick one can move it.
 */
const SHRINKAGE_TURNS = 4;

function blend(prior: number, fitted: number, weight: number): number {
  return clampFactor(prior * (1 - weight) + fitted * weight);
}

/**
 * Per-provider, per-model factor book. Keeps a bounded history and caches the fit, recomputing only when
 * new turns arrive, so reading it on every turn start stays cheap.
 */
export class FactorBook {
  private history = new Map<string, TurnObservation[]>();
  private cache = new Map<string, TokenFactors>();

  static key(provider: string | null | undefined, model: string | null | undefined): string {
    return `${provider ?? "unknown"}/${model ?? "unknown"}`;
  }

  /** Records a finished turn. Callers must only pass provider-reported token counts. */
  record(key: string, observation: TurnObservation): void {
    const entries = this.history.get(key) ?? [];
    entries.push(observation);
    if (entries.length > HISTORY_LIMIT) entries.splice(0, entries.length - HISTORY_LIMIT);
    this.history.set(key, entries);
    this.cache.delete(key);
  }

  /**
   * What the engine should use for the next turn of this model.
   *
   * Below three qualifying turns the seeds stand, because a split cannot be identified. From three turns up,
   * the fitted split is blended towards the seeds by `n / (n + 4)`: play it safe while the history is thin,
   * trust the model's own numbers as it grows. Falls back to the seeds entirely when the fit is degenerate
   * (every turn had the same shape, so there is no split to learn).
   */
  factorsFor(key: string): TokenFactors {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const entries = this.history.get(key) ?? [];
    const fitted = fitSplitFactors(entries);
    let factors: TokenFactors;
    if (fitted === null) {
      factors = { ...DEFAULT_FACTORS };
    } else {
      const samples = entries.filter(isQualifying).length;
      const weight = samples / (samples + SHRINKAGE_TURNS);
      factors = {
        thinking: blend(DEFAULT_FACTORS.thinking, fitted.thinking, weight),
        answer: blend(DEFAULT_FACTORS.answer, fitted.answer, weight),
      };
    }
    this.cache.set(key, factors);
    return factors;
  }

  /** How many usable turns back a factor, for the popover and for tests. */
  sampleCount(key: string): number {
    return (this.history.get(key) ?? []).filter(isQualifying).length;
  }

  /** True when the factors come from this model's own history rather than the seeds. */
  isLearned(key: string): boolean {
    return this.sampleCount(key) > 0;
  }
}
