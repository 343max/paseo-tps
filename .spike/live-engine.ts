/**
 * Live cross-check for a surface I cannot see from here.
 *
 * Runs the plugin's *own* engine (client/engine.ts) against a live agent and prints what the pill should
 * be showing, with wall-clock timestamps so it can be compared against the app at the same moment.
 *
 * Attaching mid-turn is the normal case for this tool, so it starts a turn with `tokens: null`, which is
 * the engine's "baseline unknown, first provider value defines it" path.
 *
 * usage: node --experimental-strip-types .spike/live-engine.ts <agentId> [seconds]
 */
import { createPaseoClient } from "@getpaseo/client";
import { TpsEngine } from "../client/engine.ts";
import { pillLabel } from "../client/format.ts";

const agentId = process.argv[2];
const seconds = Number(process.argv[3] ?? 40);
const engine = new TpsEngine();
const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const now = () => Date.now();
const handle = client.agents.ref(agentId);
const initial = await handle.refresh();
const agent = initial?.agent;

const stamp = () => new Date().toISOString().slice(11, 19);
let latestTokens: number | null = agent?.lastUsage?.outputTokens ?? null;

if (agent?.activeTurn) {
  engine.startTurn({
    now: now(),
    tokens: null, // attached mid-turn: let the first provider value become the baseline
    turnId: agent.activeTurn.turnId,
    provider: agent.provider,
    model: agent.model ?? undefined,
  });
  console.log(`${stamp()} attached mid-turn ${agent.activeTurn.turnId} tokens=${latestTokens}`);
} else {
  console.log(`${stamp()} agent is not running a turn yet; waiting for turn_started`);
}

const subscription = handle.timeline.subscribe((message) => {
  const event = message.event;
  if (!event) return;
  if (event.type === "turn_started") {
    engine.startTurn({ now: now(), tokens: latestTokens, turnId: event.turnId ?? null, provider: event.provider });
    console.log(`${stamp()} turn_started ${event.turnId ?? "?"}`);
  } else if (event.type === "timeline") {
    const item = event.item;
    if (item.type === "assistant_message") engine.onDelta({ now: now(), kind: "answer", chars: item.text.length });
    else if (item.type === "reasoning") engine.onDelta({ now: now(), kind: "thinking", chars: item.text.length });
    else if (item.type === "tool_call") {
      engine.onToolCall({ now: now(), callId: typeof item.callId === "string" ? item.callId : null, status: String(item.status ?? "running") });
    }
  } else if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") {
    const tokens = "usage" in event ? event.usage?.outputTokens : undefined;
    engine.endTurn({
      now: now(),
      outcome: event.type === "turn_completed" ? "completed" : event.type === "turn_failed" ? "failed" : "canceled",
      tokens,
    });
    const summary = engine.summarize(now());
    console.log(
      `${stamp()} turn ended tokens=${summary.tokens} estimated=${summary.tokensEstimated} seconds=${summary.seconds.toFixed(1)} tps=${summary.tps?.toFixed(1)}`,
    );
    subscription();
    void client.close().then(() => process.exit(0));
  }
});
await subscription.ready;

const poll = setInterval(async () => {
  try {
    await handle.refresh();
    const tokens = handle.current()?.lastUsage?.outputTokens;
    if (typeof tokens === "number") {
      latestTokens = tokens;
      engine.onTokens({ now: now(), tokens });
    }
  } catch (error) {
    console.log(`${stamp()} poll failed ${String(error)}`);
  }
}, 3000);

const sample = setInterval(() => {
  const reading = engine.read(now());
  console.log(
    `${stamp()} pill="${pillLabel(reading)}" state=${reading.state} rate=${reading.rate === null ? "null" : reading.rate.toFixed(1)} thinking=${reading.thinkingRate === null ? "null" : reading.thinkingRate.toFixed(1)} avg=${reading.averageRate === null ? "null" : reading.averageRate.toFixed(1)} est=${reading.estimatedTokens.toFixed(0)} measured=${reading.measuredTokens} chars/s=${reading.charsPerSecond.toFixed(0)} gen=${(reading.generationMs / 1000).toFixed(1)}s/${(reading.elapsedMs / 1000).toFixed(1)}s avg=${reading.averageRate === null ? "null" : reading.averageRate.toFixed(0)} wallAvg=${reading.wallClockAverageRate === null ? "null" : reading.wallClockAverageRate.toFixed(0)}`,
  );
}, 2000);

setTimeout(() => {
  clearInterval(sample);
  clearInterval(poll);
  subscription();
  void client.close().then(() => process.exit(0));
}, seconds * 1000);
