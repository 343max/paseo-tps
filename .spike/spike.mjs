// Phase 1 spike: record everything a plugin can see for one agent, raw, for offline analysis.
// usage: node spike.mjs <agentId> <maxSeconds> [outPath] [--poll]
// Records JSONL: turn boundaries, stream deltas, usage pushes, optional 3s refresh polls.
import { createPaseoClient } from "@getpaseo/client";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const agentId = process.argv[2];
const maxSeconds = Number(process.argv[3] ?? 180);
const outPath =
  process.argv[4] ??
  `/tmp/tpsprobe/runs/${new Date().toISOString().replace(/[:.]/g, "-")}-${agentId.slice(0, 8)}.jsonl`;
const poll = process.argv.includes("--poll");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, "");

const t0 = Date.now();
const rec = (o) => appendFileSync(outPath, `${JSON.stringify({ t: Date.now() - t0, wall: Date.now(), ...o })}\n`);

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const handle = client.agents.ref(agentId);
const before = await handle.refresh();
rec({
  ev: "start",
  outPath,
  poll,
  status: before?.agent.status ?? null,
  activeTurn: before?.agent.activeTurn ?? null,
  lastUsage: before?.agent.lastUsage ?? null,
});

let turnEnded = false;
let deltaCount = 0;
let chars = 0;
let thinkingChars = 0;
let answerChars = 0;
let lastDeltas = [];

// --- the live stream a plugin client can subscribe to ---
const sub = handle.timeline.subscribe((message) => {
  const e = message.event;
  if (!e) return;
  switch (e.type) {
    case "timeline": {
      const item = e.item;
      if (item.type === "assistant_message" || item.type === "reasoning") {
        const n = item.text.length;
        if (item.type === "reasoning") thinkingChars += n;
        else answerChars += n;
        chars += n;
        deltaCount += 1;
        const now = Date.now() - t0;
        lastDeltas.push(now);
        if (lastDeltas.length > 400) lastDeltas.shift();
        rec({
          ev: "delta",
          kind: item.type === "reasoning" ? "t" : "a",
          chars: n,
          total: chars,
          turnId: e.turnId ?? null,
          messageId: item.messageId ?? null,
        });
      } else {
        rec({
          ev: "item",
          kind: item.type,
          status: item.status ?? null,
          callId: typeof item.callId === "string" ? item.callId : null,
          turnId: e.turnId ?? null,
          inputSize: typeof item.input === "string" ? item.input.length : 0,
        });
      }
      return;
    }
    case "turn_started":
      rec({ ev: "turn_started", turnId: e.turnId ?? null, provider: e.provider });
      return;
    case "turn_completed":
      turnEnded = true;
      rec({ ev: "turn_completed", turnId: e.turnId ?? null, usage: e.usage ?? null });
      return;
    case "turn_failed":
      turnEnded = true;
      rec({ ev: "turn_failed", turnId: e.turnId ?? null, error: e.error, code: e.code ?? null });
      return;
    case "turn_canceled":
      turnEnded = true;
      rec({ ev: "turn_canceled", turnId: e.turnId ?? null, reason: e.reason });
      return;
    case "usage_updated":
      rec({ ev: "usage_stream", turnId: e.turnId ?? null, usage: e.usage });
      return;
    default:
      rec({ ev: "stream", kind: e.type });
  }
});
await sub.ready;
rec({ ev: "ready", subscriptionId: sub.subscriptionId });

// --- what a plugin gets pushed without asking: agent snapshot upserts ---
const { subscription } = await client.agents.list({
  filter: { includeArchived: false },
  subscribe: {},
  signal: AbortSignal.timeout(maxSeconds * 1000 + 15_000),
});
subscription.subscribe({
  snapshot: ({ entries }) => {
    const entry = entries.find(({ agent }) => agent.id === agentId);
    if (entry) rec({ ev: "snapshot", usage: entry.agent.lastUsage ?? null, status: entry.agent.status, activeTurn: entry.agent.activeTurn ?? null });
  },
  update: (message) => {
    if (message.type !== "agent_update") return;
    const u = message.payload;
    if (u.kind === "upsert" && u.agent.id === agentId) {
      rec({ ev: "usage_push", usage: u.agent.lastUsage ?? null, status: u.agent.status, activeTurn: u.agent.activeTurn ?? null });
    }
  },
});

let pollTimer;
if (poll) {
  pollTimer = setInterval(async () => {
    try {
      await handle.refresh();
      const a = handle.current();
      rec({ ev: "usage_poll", usage: a?.lastUsage ?? null, status: a?.status ?? null, activeTurn: a?.activeTurn ?? null });
    } catch (error) {
      rec({ ev: "poll_error", error: String(error) });
    }
  }, 3000);
}

const statusTimer = setInterval(() => {
  const recent = lastDeltas.filter((t) => t > Date.now() - t0 - 3000).length;
  console.log(
    `[spike] t=${Math.round((Date.now() - t0) / 1000)}s deltas=${deltaCount} chars=${chars} (think ${thinkingChars}/ans ${answerChars}) d/s=${recent / 3} ended=${turnEnded}`,
  );
}, 5000);

const deadline = Date.now() + maxSeconds * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  if (turnEnded) {
    // give the final usage push a moment to land, then finish
    await new Promise((r) => setTimeout(r, 4000));
    break;
  }
}

clearInterval(statusTimer);
if (pollTimer) clearInterval(pollTimer);
const after = await handle.refresh();
rec({
  ev: "end",
  deltas: deltaCount,
  chars,
  thinkingChars,
  answerChars,
  status: after?.agent.status ?? null,
  lastUsage: after?.agent.lastUsage ?? null,
});
sub();
await client.close();
console.log(`[spike] wrote ${outPath}`);
process.exit(0);
