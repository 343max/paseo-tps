// Compares candidate engine formulas on the recorded runs, using leave-one-out calibration
// to simulate a persisted per-(provider,model) chars-per-token history.
// usage: node engine-compare.mjs runs/*.jsonl
import { readFileSync } from "node:fs";

const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

function load(file) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const wall = rows.find((r) => r.wall)?.wall ?? null;
  const startedAts = rows.map((r) => (r.activeTurn?.startedAt ? Date.parse(r.activeTurn.startedAt) : null)).filter((v) => v !== null);
  const turnStartRel = startedAts.length ? Math.min(...startedAts) - wall : rows.find((r) => r.ev === "turn_started")?.t ?? null;
  const end = rows.find((r) => ["turn_completed", "turn_failed", "turn_canceled"].includes(r.ev));
  const deltas = rows.filter((r) => r.ev === "delta").map((r) => ({ t: r.t, kind: r.kind, chars: r.chars }));
  const samples = rows
    .filter((r) => r.usage?.outputTokens !== undefined)
    .map((r) => ({ t: r.t, tokens: r.usage.outputTokens, ev: r.ev }))
    .sort((a, b) => a.t - b.t);
  const pushes = samples.filter((s) => s.ev === "usage_push");
  const baseline = samples.find((s) => turnStartRel === null || s.t >= turnStartRel) ?? samples[0];
  const endTokens = end?.usage?.outputTokens ?? samples[samples.length - 1].tokens;
  const trueTokens = Math.max(0, endTokens - baseline.tokens);
  const thinkingChars = deltas.filter((d) => d.kind === "t").reduce((s, d) => s + d.chars, 0);
  const answerChars = deltas.filter((d) => d.kind === "a").reduce((s, d) => s + d.chars, 0);
  const turnSeconds = turnStartRel !== null && end ? (end.t - turnStartRel) / 1000 : NaN;
  return {
    file,
    name: file.split("/").pop().replace(".jsonl", ""),
    turnStartRel,
    turnEnd: end?.t ?? null,
    turnSeconds,
    deltas,
    samples,
    pushes,
    baseline,
    trueTokens,
    thinkingChars,
    answerChars,
    chars: thinkingChars + answerChars,
    trueTps: trueTokens / turnSeconds,
  };
}

const runs = process.argv.slice(2).map(load).filter((r) => r.turnStartRel !== null && Number.isFinite(r.turnSeconds) && r.trueTokens > 0);
const usable = runs;
// calibration only trusts turns where the stream actually represents the tokens:
// tool-heavy turns emit few characters but many tokens and would poison the ratio.
const clean = (r) => r.chars >= 200 && r.chars / r.trueTokens >= 1.5 && r.chars / r.trueTokens <= 12;
const cleanRuns = usable.filter(clean);

// ---- calibration models ----
const aggregate = (set) => {
  const s = set.filter(clean);
  if (!s.length) return null;
  const c = s.reduce((a, r) => a + r.chars, 0);
  const t = s.reduce((a, r) => a + r.trueTokens, 0);
  return c / t;
};
const medianFactor = (set) => {
  const s = set.filter(clean).map((r) => r.chars / r.trueTokens).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.floor(s.length / 2)];
};
// two-unknown least squares: tokens = thinkingChars/x + answerChars/y  (x,y = per-kind chars/token)
const twoParam = (set) => {
  // unknowns u = 1/x, v = 1/y ; normal equations
  const use = set.filter(clean);
  if (use.length < 3) return null;
  const S = (f, g) => use.reduce((s, r) => s + f(r) * g(r), 0);
  const T = (f) => use.reduce((s, r) => s + f(r) * r.trueTokens, 0);
  const a11 = S((r) => r.thinkingChars, (r) => r.thinkingChars);
  const a12 = S((r) => r.thinkingChars, (r) => r.answerChars);
  const a22 = S((r) => r.answerChars, (r) => r.answerChars);
  const b1 = T((r) => r.thinkingChars);
  const b2 = T((r) => r.answerChars);
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return null;
  const u = (b1 * a22 - b2 * a12) / det;
  const v = (a11 * b2 - a12 * b1) / det;
  if (u <= 0 || v <= 0) return null;
  return { thinking: 1 / u, answer: 1 / v };
};

// ---- engine variants ----
// V1: token truth with char fallback via max (original plan)
// V2: rebase - snap to truth when it advances, extrapolate with chars in between
function series(run, { mode, factor, windowSeconds = 5 }) {
  const { deltas, samples, baseline, turnStartRel, turnEnd } = run;
  if (!deltas.length) return [];
  const firstDelta = deltas[0].t;
  const lastDelta = deltas[deltas.length - 1].t;
  const cumChars = (t) => deltas.filter((d) => d.t <= t).reduce((s, d) => s + d.chars, 0);
  const truthAt = (t) => {
    let value = baseline.tokens;
    for (const s of samples) if (s.t <= t) value = s.tokens;
    return value - baseline.tokens;
  };
  const trueAverage = run.trueTokens / run.turnSeconds;

  // est state: rebase only when the truth actually advances, so char progress is never discarded
  let truthNow = 0;
  let charsAtRebase = 0;
  let si = 0;
  const estTokens = (t) => {
    // advance rebases through samples up to t
    while (si < samples.length && samples[si].t <= t) {
      const truth = samples[si].tokens - baseline.tokens;
      if (truth > truthNow) {
        truthNow = truth;
        charsAtRebase = cumChars(samples[si].t);
      }
      si += 1;
    }
    const chars = cumChars(t);
    if (mode === "char-only") return chars / factor;
    if (mode === "max") return Math.max(truthNow, chars / factor);
    return truthNow + Math.max(0, chars - charsAtRebase) / factor;
  };

  const step = 250;
  const endT = turnEnd ?? lastDelta;
  const points = [];
  for (let t = firstDelta; t < endT; t += step) points.push(t);
  points.push(endT);
  const out = [];
  for (const t of points) {
    // a window that starts before the stream began is measured over the span that exists
    const before = Math.max(firstDelta, t - windowSeconds * 1000);
    const dt = (t - before) / 1000;
    if (dt <= 0) {
      out.push({ t, rate: estTokens(t) / Math.max(0.25, (t - (turnStartRel ?? firstDelta)) / 1000), est: estTokens(t), reference: trueAverage });
      continue;
    }
    const rate = (estTokens(t) - estTokens(before)) / dt;
    out.push({ t, rate, est: estTokens(t), reference: trueAverage });
  }
  return out;
}

function evaluate(set, opts) {
  return set.map((run) => {
    const others = usable.filter((r) => r !== run);
    const agg = aggregate(others) ?? 4.3;
    const med = medianFactor(others) ?? agg;
    const tp = twoParam(others);
    const twoParamBlend = tp ? (tp.thinking * run.thinkingChars + tp.answer * run.answerChars) / Math.max(1, run.chars) : null;
    const chosen =
      opts.factor === "aggregate" ? agg
      : opts.factor === "median" ? med
      : opts.factor === "twoParam" ? twoParamBlend
      : opts.factor === "perfect" ? run.chars / run.trueTokens
      : opts.factor;
    const factor = chosen ?? 4.0;
    const s = series(run, { mode: opts.mode, factor, windowSeconds: opts.window ?? 5 });
    if (!s.length) return null;
    const absErr = s.map((x) => (Math.abs(x.rate - x.reference) / x.reference) * 100);
    const estFinal = s[s.length - 1].est;
    const diffs = s.slice(1).map((x, i) => Math.abs(x.rate - s[i].rate));
    const pick = (p) => s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))].rate;
    return {
      name: run.name,
      trueTokens: run.trueTokens,
      trueTps: run.trueTps,
      cptUsed: factor,
      cptTruth: run.chars / run.trueTokens,
      estFinalTokens: estFinal,
      finalTokenErrPct: ((estFinal - run.trueTokens) / run.trueTokens) * 100,
      meanRateErrPct: mean(absErr),
      jitterP90: pct(diffs, 90),
      deciles: [10, 25, 50, 75, 100].map((p) => fmt(pick(p), 0)).join("/"),
    };
  }).filter(Boolean);
}

const scenarios = [
  { label: "V2 rebase, seed 4.3 (no history)", mode: "rebase", factor: 4.3 },
  { label: "V2 rebase, leave-one-out median", mode: "rebase", factor: "median" },
  { label: "V2 rebase, leave-one-out two-param", mode: "rebase", factor: "twoParam" },
  { label: "V2 rebase, perfect factor (ceiling)", mode: "rebase", factor: "perfect" },
  { label: "V1 max(), leave-one-out median", mode: "max", factor: "median" },
];

console.log("\nruns used:", usable.map((r) => `${r.name}(${fmt(r.trueTokens, 0)}tok/${fmt(r.turnSeconds, 1)}s/${fmt(r.chars / r.trueTokens, 2)}cpt${clean(r) ? "" : " TOOL-HEAVY"})`).join("  "));
console.log(`clean runs for calibration: ${cleanRuns.length} | median ratio ${fmt(medianFactor(usable), 3)} | aggregate ${fmt(aggregate(usable), 3)}`);
const tp = twoParam(usable);
console.log(`two-param fit over all runs: thinking ${tp ? fmt(tp.thinking, 2) : "n/a"} chars/token, answer ${tp ? fmt(tp.answer, 2) : "n/a"} chars/token\n`);

for (const sc of scenarios) {
  console.log(`--- ${sc.label}`);
  for (const row of evaluate(usable, sc)) {
    console.log(
      `  ${row.name.padEnd(16)} tokens est ${fmt(row.estFinalTokens, 0)}/${fmt(row.trueTokens, 0)} (${fmt(row.finalTokenErrPct, 1)}% err) | rate err ${fmt(row.meanRateErrPct, 1)}% (${row.rateErrSamples} pts) | jitter ${fmt(row.jitterP90, 1)} | rate@10/25/50/75/100%: ${row.deciles} (truth ${fmt(row.trueTps, 0)})`,
    );
  }
}
