/** Pure presentation helpers. Kept separate from the engine so both are trivially testable. */
import type { Reading } from "./engine";

/** `118` -> `"118"`, `1240` -> `"1.2k"`, `12400` -> `"12k"` */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

export function formatRate(rate: number | null, options: { estimated?: boolean } = {}): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  const rounded = rate >= 100 ? Math.round(rate) : Math.round(rate * 10) / 10;
  return `${options.estimated ? "~" : ""}${rounded} tok/s`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  // sub-second generation is normal on a fast model with a long tool wait, so keep one decimal there
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/**
 * The composer pill label. Short by design: the pill sits next to Tasks and Subagents and has very little
 * room, so it is the rate and nothing else. Whether the tokens came from reasoning or from answer text is
 * a detail for the popover, not for the pill.
 *
 * A rate that is being held while a tool runs is shown as the plain value: the number is the most recent
 * measured generation speed, and the popover is where the paused state is spelled out.
 */
/**
 * The composer pill label. Short by design: the pill sits next to Tasks and Subagents and has very little
 * room, so it is the rate and nothing else. Whether the tokens came from reasoning or from answer text is
 * a detail for the popover, not for the pill.
 *
 * `~` means "this number is extrapolated". Every live value qualifies: the provider reports tokens at step
 * boundaries, so between reports the rate is characters divided by a chars-per-token factor, anchored on the
 * last measurement. Showing it without the marker after the first report was misleading, because only the
 * anchor is measured. The turn average is the one measured number - and it only escapes the marker when the
 * provider actually reported tokens for that turn.
 *
 * A rate held while a tool runs is the same estimate as before the tool started, so it keeps its marker.
 */
export function pillLabel(reading: Reading): string {
  if (reading.state === "idle") return "—";
  if (reading.state === "complete") {
    if (reading.averageRate === null) return "—";
    return `${formatRate(reading.averageRate, { estimated: reading.tokensEstimated })} avg`;
  }
  if (reading.rate === null) return "…";
  return formatRate(reading.rate, { estimated: true });
}

/**
 * One line for the transcript row: `⚡ 132 tok/s · 4.2k tokens · 31s`.
 *
 * The duration is generation time, so it matches the rate either side of it. When a turn spent real time
 * waiting on tools that is called out, because otherwise a fast turn looks slow for no visible reason.
 */
export function turnRowText(input: {
  tps: number | null;
  tokens: number;
  generationSeconds: number;
  seconds: number;
  tokensEstimated: boolean;
  outcome: "completed" | "failed" | "canceled" | "unknown" | null;
}): string {
  const rate = formatRate(input.tps, { estimated: input.tokensEstimated });
  const generation = formatDuration(input.generationSeconds * 1000);
  const waitingSeconds = input.seconds - input.generationSeconds;
  const waiting = waitingSeconds > Math.max(2, input.generationSeconds * 0.25) ? ` (+${formatDuration(waitingSeconds * 1000)} waiting)` : "";
  const suffix = input.outcome === "failed" || input.outcome === "canceled" || input.outcome === "unknown" ? ` · ${input.outcome}` : "";
  return `⚡ ${rate} · ${formatTokens(input.tokens)} tokens · ${generation}${waiting}${suffix}`;
}
