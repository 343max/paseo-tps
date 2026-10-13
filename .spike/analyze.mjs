// Offline analysis of a spike run. usage: node analyze.mjs <runfile> [--json]
import { readFileSync } from "node:fs";

const path = process.argv[2];
const asJson = process.argv.includes("--json");
const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const at = (value) => (typeof value === "string" ? Date.parse(value) : null);

// absolute wall clock -> probe-relative ms
const startWall = rows.find((r) => r.wall)?.wall ?? null;
const rel = (abs) => (abs === null || startWall === null ? null : abs - startWall);

// ---------- turn structure ----------
const end = rows.find((r) => ["turn_completed", "turn_failed", "turn_canceled"].includes(r.ev));
const started = rows.find((r) => r.ev === "turn_started");
const activeStarts = rows.map((r) => at(r.activeTurn?.startedAt)).filter((v) => v !== null);
const turnStartAbs = activeStarts.length ? Math.min(...activeStarts) : null;
const turnStartRel = rel(turnStartAbs) ?? started?.t ?? null;
const turnEndRel = end?.t ?? rows[rows.length - 1].t;
const turnSeconds = turnStartRel !== null ? (turnEndRel - turnStartRel) / 1000 : NaN;

// ---------- deltas ----------
const deltas = rows.filter((r) => r.ev === "delta");
const dtimes = deltas.map((r) => r.t);
const gaps = dtimes.slice(1).map((t, i) => t - dtimes[i]);
const thinkChars = deltas.filter((r) => r.kind === "t").reduce((s, r) => s + r.chars, 0);
const answChars = deltas.filter((r) => r.kind === "a").reduce((s, r) => s + r.chars, 0);
const totalChars = thinkChars + answChars;
const firstDelta = dtimes[0];
const lastDelta = dtimes[dtimes.length - 1];
const streamSeconds = (lastDelta - firstDelta) / 1000;
const firstAnswer = deltas.find((r) => r.kind === "a")?.t;

// ---------- usage samples (everything a plugin can observe) ----------
const usageRows = rows.filter((r) => r.usage?.outputTokens !== undefined);
const samples = usageRows.map((r) => ({ t: r.t, tokens: r.usage.outputTokens, ev: r.ev }));
const pushes = samples.filter((s) => s.ev === "usage_push");
const baseline = samples.find((s) => turnStartRel === null || s.t >= turnStartRel) ?? samples[0];
const endTokens = end?.usage?.outputTokens ?? samples[samples.length - 1].tokens;
const trueTokens = Math.max(0, endTokens - baseline.tokens);
const trueTps = trueTokens / turnSeconds;
const charsPerToken = totalChars > 0 && trueTokens > 0 ? totalChars / trueTokens : NaN;

let negative = 0;
let sumPositive = 0;
for (let i = 1; i < samples.length; i++) {
  const d = samples[i].tokens - samples[i - 1].tokens;
  if (d < 0) negative++;
  else sumPositive += d;
}
const intervals = (list) => list.slice(1).map((s, i) => s.t - list[i].t);
const sampleIntervalP50 = pct(intervals(samples), 50);
const pushIntervalP50 = pct(intervals(pushes), 50);
const pushIntervalP90 = pct(intervals(pushes), 90);

// staleness of the newest token truth at any moment during the turn
const ages = [];
for (let t = firstDelta; t <= lastDelta; t += 250) {
  const prev = samples.filter((s) => s.t <= t);
  if (prev.length) ages.push(t - prev[prev.length - 1].t);
}

// ---------- estimators ----------
const cumCharsAt = (t) => deltas.filter((r) => r.t <= t).reduce((s, r) => s + r.chars, 0);
const tokenAt = (t, list) => {
  let value = null;
  for (const s of list) if (s.t <= t) value = s.tokens;
  return value;
};

// reference: tokens actually produced per second up to time t (step-interpolated truth)
const avgSoFarAt = (t) => {
  const tokens = tokenAt(t, samples);
  if (tokens === null || turnStartRel === null || t <= turnStartRel) return null;
  return (tokens - baseline.tokens) / ((t - turnStartRel) / 1000);
};

function series(windowSeconds, mode) {
  const step = 250;
  const out = [];
  // calibration state
  let cpt = 4.0;
  let busy = 0;
  let prev = null;
  let si = 0;
  const list = mode === "push" ? [...pushes, ...samples.filter((s) => s.ev === "turn_completed")] : samples;
  list.sort((a, b) => a.t - b.t);
  for (let t = Math.max(0, Math.floor(firstDelta / step) * step); t <= lastDelta; t += step) {
    while (si < list.length && list[si].t <= t) {
      const s = list[si];
      if (prev) {
        const dTokens = s.tokens - prev.tokens;
        const dChars = cumCharsAt(s.t) - cumCharsAt(prev.t);
        if (dTokens > 0 && dChars > 0) {
          cpt = 0.5 * cpt + 0.5 * (dChars / dTokens);
          busy += 1;
        }
      }
      prev = s;
      si += 1;
    }
    const factor = mode === "perfect" ? charsPerToken : cpt;
    const before = Math.max(firstDelta, t - windowSeconds * 1000);
    const charRate = before === t ? 0 : (cumCharsAt(t) - cumCharsAt(before)) / ((t - before) / 1000);
    out.push({ t, rate: charRate / factor, cpt, reference: avgSoFarAt(t) });
  }
  return out;
}

const windows = [2, 3, 5, 10];
const summaries = windows.map((w) => {
  const build = (mode) => {
    const s = series(w, mode);
    const finite = s.filter((x) => Number.isFinite(x.rate));
    const errs = s.filter((x) => Number.isFinite(x.reference) && x.reference > 5 && Number.isFinite(x.rate));
    const absErr = errs.map((x) => (Math.abs(x.rate - x.reference) / x.reference) * 100);
    const diffs = finite.slice(1).map((x, i) => Math.abs(x.rate - finite[i].rate));
    const pick = (p) => {
      const idx = Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)));
      return s[idx];
    };
    return {
      final: finite[finite.length - 1].rate,
      meanAbsErrPct: mean(absErr),
      jitterP90: pct(diffs, 90),
      samples: [10, 25, 50, 75, 100].map((p) => `${p}%:${fmt(pick(p).rate, 0)}`).join(" "),
      calibrationUpdates: finite[finite.length - 1].cpt,
    };
  };
  return {
    window: w,
    perfect: build("perfect"),
    online: build("online"),
    push: build("push"),
  };
});

const report = {
  file: path,
  outcome: end?.ev ?? "incomplete (no turn end event)",
  turn: { turnStartRel, turnEndRel, turnSeconds, turnId: end?.turnId ?? null },
  stream: {
    deltaEvents: deltas.length,
    chars: totalChars,
    thinkingChars: thinkChars,
    answerChars: answChars,
    deltaRate: deltas.length / streamSeconds,
    gapP50: pct(gaps, 50),
    gapP90: pct(gaps, 90),
    gapMax: gaps.length ? Math.max(...gaps) : 0,
    streamSeconds,
    idleBeforeFirstDeltaMs: turnStartRel !== null ? firstDelta - turnStartRel : null,
    firstAnswerMs: firstAnswer !== undefined && turnStartRel !== null ? firstAnswer - turnStartRel : null,
  },
  usage: {
    samples: samples.length,
    pushed: pushes.length,
    pushedInTurn: pushes.filter((s) => turnStartRel !== null && s.t >= turnStartRel).length,
    sampleIntervalP50,
    pushIntervalP50,
    pushIntervalP90,
    baselineTokens: baseline.tokens,
    endTokens,
    trueTokens,
    sumPositiveDeltas: sumPositive,
    negativeDeltas: negative,
    stalenessP50: pct(ages, 50),
    stalenessP90: pct(ages, 90),
    stalenessMax: ages.length ? Math.max(...ages) : NaN,
  },
  truth: { trueTps, charsPerToken, charRate: totalChars / streamSeconds },
  sweep: summaries,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const r = report;
  console.log(`\n=== ${path}`);
  console.log(
    `turn: ${r.outcome} | daemon-declared start -> end = ${fmt(r.turn.turnSeconds, 1)}s | stream ${fmt(r.stream.streamSeconds, 1)}s`,
  );
  console.log(
    `stream: ${r.stream.deltaEvents} deltas (${fmt(r.stream.deltaRate, 1)}/s), gaps p50 ${r.stream.gapP50}ms p90 ${r.stream.gapP90}ms max ${r.stream.gapMax}ms`,
  );
  console.log(
    `chars: ${r.stream.chars} total (thinking ${r.stream.thinkingChars} / answer ${r.stream.answerChars}) | first delta ${r.stream.idleBeforeFirstDeltaMs}ms, first answer ${r.stream.firstAnswerMs}ms after turn start`,
  );
  console.log(
    `usage: ${r.usage.samples} samples, ${r.usage.pushed} pushed (${r.usage.pushedInTurn} during turn) | all-interval p50 ${r.usage.sampleIntervalP50}ms | push interval p50 ${r.usage.pushIntervalP50}ms p90 ${r.usage.pushIntervalP90}ms | negative deltas ${r.usage.negativeDeltas}`,
  );
  console.log(
    `tokens: ${r.usage.baselineTokens} -> ${r.usage.endTokens} | truth ${r.usage.trueTokens} | positive-sum ${r.usage.sumPositiveDeltas}`,
  );
  console.log(
    `token-truth staleness during turn: p50 ${r.usage.stalenessP50}ms p90 ${r.usage.stalenessP90}ms max ${r.usage.stalenessMax}ms`,
  );
  console.log(
    `TRUTH: ${fmt(r.truth.trueTps, 1)} tok/s average | ${fmt(r.truth.charsPerToken, 3)} chars/token | ${fmt(r.truth.charRate, 0)} chars/s`,
  );
  for (const s of r.sweep) {
    console.log(`window ${String(s.window).padStart(2)}s`);
    console.log(
      `   perfect-calib : final ${fmt(s.perfect.final, 1)} | mean err vs avg-so-far ${fmt(s.perfect.meanAbsErrPct, 1)}% | jitter p90 ${fmt(s.perfect.jitterP90, 1)}`,
    );
    console.log(
      `   online (all)  : final ${fmt(s.online.final, 1)} | mean err ${fmt(s.online.meanAbsErrPct, 1)}% | jitter p90 ${fmt(s.online.jitterP90, 1)} | cpt ${fmt(s.online.calibrationUpdates, 2)}`,
    );
    console.log(
      `   push-only     : final ${fmt(s.push.final, 1)} | mean err ${fmt(s.push.meanAbsErrPct, 1)}% | jitter p90 ${fmt(s.push.jitterP90, 1)} | cpt ${fmt(s.push.calibrationUpdates, 2)}`,
    );
    console.log(`   over time (online): ${s.online.samples}`);
  }
  console.log();
}
