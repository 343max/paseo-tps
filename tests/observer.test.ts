import { describe, expect, it } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { type AgentReading, type AgentTurnSummary, type Clock, TpsObserver } from "../client/observer";

/**
 * The observer is wiring, and wiring is where "nothing happens at all" bugs live: an engine that never
 * starts looks identical to a UI that renders nothing. These tests drive the real subscriptions instead of
 * trusting the app.
 */

type SnapshotAgent = {
  id: string;
  workspaceId?: string | null;
  status: string;
  provider?: string | null;
  model?: string | null;
  lastUsage?: { outputTokens?: number } | null;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
};

function harness() {
  let current: SnapshotAgent | null = null;
  const timelineHandlers: ((message: { event: Record<string, unknown> }) => void)[] = [];
  const intervals: { callback: () => void; ms: number; nextAt: number }[] = [];
  let now = 1_000_000;

  const clock: Clock = {
    now: () => now,
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms, nextAt: now + ms });
      return callback;
    },
    clearInterval: (handle) => {
      const index = intervals.findIndex((interval) => interval.callback === handle);
      if (index >= 0) intervals.splice(index, 1);
    },
  };

  const client = {
    paseo: {
      agents: {
        // The observer does not own the agent-list observation: index.client.tsx does and feeds snapshots
        // in through observe(). Only the per-agent handle is the observer's business.
        ref: (_id: string) => ({
          timeline: {
            subscribe: (handler: (message: { event: Record<string, unknown> }) => void) => {
              timelineHandlers.push(handler);
              const release = () => {
                const index = timelineHandlers.indexOf(handler);
                if (index >= 0) timelineHandlers.splice(index, 1);
              };
              return Object.assign(release, { ready: Promise.resolve(), subscriptionId: "s1", release: async () => {} });
            },
          },
          refresh: async () => ({ agent: current }),
          current: () => current,
        }),
      },
    },
  } as unknown as PluginClientContext;

  const readings: AgentReading[] = [];
  const turns: AgentTurnSummary[] = [];

  return {
    client,
    clock,
    readings,
    turns,
    setCurrent: (agent: SnapshotAgent | null) => {
      current = agent;
    },
    /** What index.client.tsx does with a directory snapshot: hand each agent to the observer. */
    snapshots: (observer: TpsObserver, agents: SnapshotAgent[]) => {
      for (const agent of agents) {
        current = agent;
        observer.observe(agent);
      }
    },
    emitTimeline: (event: Record<string, unknown>) => {
      for (const handler of [...timelineHandlers]) handler({ event });
    },
    /** Advance the fake clock in small slices, running each timer when its own period is due. */
    tick: (ms: number) => {
      const step = 25;
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        now += step;
        for (const interval of [...intervals]) {
          if (now >= interval.nextAt) {
            interval.callback();
            interval.nextAt = now + interval.ms;
          }
        }
      }
    },
  };
}

const runningAgent = (overrides: Partial<SnapshotAgent> = {}): SnapshotAgent => ({
  id: "a1",
  workspaceId: "w1",
  status: "running",
  provider: "pi",
  model: "deepseek/deepseek-flash",
  lastUsage: { outputTokens: 1000 },
  activeTurn: { turnId: "t1", startedAt: new Date(1_000_000).toISOString() },
  ...overrides,
});

describe("TpsObserver", () => {
  it("starts a turn that is already running when it attaches (regression: pill stayed at a dash)", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();

    // The plugin loads while a turn is mid-flight: no turn_started event will ever arrive for it.
    h.snapshots(observer, [runningAgent()]);

    // Characters arrive, and the sampler should now publish a reading with a real rate.
    for (let i = 0; i < 20; i += 1) {
      h.tick(100);
      h.emitTimeline({ type: "timeline", item: { type: "reasoning", text: "x".repeat(100) }, provider: "pi", turnId: "t1" });
    }
    h.tick(250);

    const last = h.readings[h.readings.length - 1];
    expect(last).toBeDefined();
    expect(last.agentId).toBe("a1");
    expect(last.reading.rate).toBeGreaterThan(0);
    expect(last.reading.thinkingRate).toBeGreaterThan(0);
    expect(last.reading.state).toBe("thinking");
    stop();
  });

  it("measures tokens from the snapshot when the provider reports mid-turn", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    h.snapshots(observer, [runningAgent()]);
    h.tick(1000);
    h.emitTimeline({ type: "timeline", item: { type: "assistant_message", text: "y".repeat(200) }, provider: "pi", turnId: "t1" });

    // provider counter advances while the turn runs
    h.setCurrent(runningAgent({ lastUsage: { outputTokens: 1300 } }));
    h.snapshots(observer, [runningAgent({ lastUsage: { outputTokens: 1300 } })]);
    h.tick(250);

    const last = h.readings[h.readings.length - 1];
    expect(last.reading.measuredTokens).toBe(300);
    expect(last.reading.tokensEstimated).toBe(false);
    stop();
  });

  it("reports the turn summary and a final average when the turn completes", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    h.snapshots(observer, [runningAgent()]);
    for (let i = 0; i < 10; i += 1) {
      h.tick(100);
      h.emitTimeline({ type: "timeline", item: { type: "assistant_message", text: "z".repeat(50) }, provider: "pi", turnId: "t1" });
    }
    h.emitTimeline({ type: "turn_completed", provider: "pi", turnId: "t1", usage: { outputTokens: 1450 } });

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].agentId).toBe("a1");
    expect(h.turns[0].outcome).toBe("completed");
    expect(h.turns[0].tokens).toBe(450); // 1450 - 1000 baseline
    expect(h.turns[0].tps).toBeGreaterThan(0);
    expect(h.turns[0].model).toBe("deepseek/deepseek-flash");

    // the pill must end up on the final average, not frozen on the last live value
    const last = h.readings[h.readings.length - 1];
    expect(last.reading.state).toBe("complete");
    expect(last.reading.rate).toBeCloseTo(h.turns[0].tps as number, 5);
    stop();
  });

  it("closes a turn the daemon says is over when its end event never arrived", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    h.snapshots(observer, [runningAgent()]);
    h.emitTimeline({ type: "timeline", item: { type: "thinking", text: "ignored" }, provider: "pi", turnId: "t1" });
    h.emitTimeline({ type: "timeline", item: { type: "reasoning", text: "q".repeat(100) }, provider: "pi", turnId: "t1" });

    // long silence, then a snapshot with no active turn and no turn_completed ever delivered
    h.tick(8000);
    h.snapshots(observer, [runningAgent({ status: "idle", activeTurn: null })]);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].outcome).toBe("unknown");
    stop();
  });

  it("ignores agents without a workspace, since a composer pill needs one", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    h.snapshots(observer, [runningAgent({ id: "loose", workspaceId: null })]);
    h.tick(250);
    expect(h.readings).toHaveLength(0);
    stop();
  });

  it("learns chars-per-token from completed turns and only then applies it", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    const model = "deepseek/deepseek-flash";

    // three completed turns of different shapes, each at roughly 3 chars per token so all of them qualify
    const shapes: [number, number, number][] = [
      [250, 0, 1083],
      [100, 200, 1183],
      [50, 350, 1316],
    ];
    for (let index = 0; index < shapes.length; index += 1) {
      const [thinking, answer, totalTokens] = shapes[index];
      // the daemon's snapshot carries the latest usage, so the next turn's baseline is the previous total
      const baseline = index === 0 ? 1000 : shapes[index - 1][2];
      h.snapshots(observer, [
        runningAgent({ activeTurn: { turnId: `t${index + 1}`, startedAt: null }, lastUsage: { outputTokens: baseline } }),
      ]);
      h.tick(50);
      for (let i = 0; i < Math.ceil(thinking / 50); i += 1) {
        h.tick(50);
        h.emitTimeline({ type: "timeline", item: { type: "reasoning", text: "t".repeat(Math.min(50, thinking - i * 50)) }, provider: "pi", turnId: `t${index + 1}` });
      }
      for (let i = 0; i < Math.ceil(answer / 50); i += 1) {
        h.tick(50);
        h.emitTimeline({ type: "timeline", item: { type: "assistant_message", text: "a".repeat(Math.min(50, answer - i * 50)) }, provider: "pi", turnId: `t${index + 1}` });
      }
      h.emitTimeline({ type: "turn_completed", provider: "pi", turnId: `t${index + 1}`, usage: { outputTokens: totalTokens } });
    }

    expect(h.turns).toHaveLength(3);
    expect(h.turns[2].factorSamples).toBe(3);
    // three turns of differing shape identify a split, so the factors move off the seeds
    const factors = observer.factorsFor("pi", model);
    expect(factors).not.toEqual({ thinking: 2.8, answer: 5.0 });
    expect(factors.thinking).toBeGreaterThanOrEqual(1.5);
    expect(factors.answer).toBeLessThanOrEqual(8);
    stop();
  });

  it("does not learn from a tool-heavy turn whose characters do not represent its tokens", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    h.snapshots(observer, [runningAgent({ activeTurn: { turnId: "t1", startedAt: null } })]);
    h.tick(50);
    h.emitTimeline({ type: "timeline", item: { type: "assistant_message", text: "x".repeat(14) }, provider: "pi", turnId: "t1" });
    h.emitTimeline({ type: "turn_completed", provider: "pi", turnId: "t1", usage: { outputTokens: 1089 } });

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].factorSamples).toBe(0);
    expect(observer.factorsFor("pi", "deepseek/deepseek-flash")).toEqual({ thinking: 2.8, answer: 5.0 });
    stop();
  });

  it("stops cleanly", async () => {
    const h = harness();
    const observer = new TpsObserver(h.client, { onReading: (r) => h.readings.push(r), onTurnEnd: (t) => h.turns.push(t) }, h.clock);
    const stop = observer.start();
    await Promise.resolve();
    h.snapshots(observer, [runningAgent()]);
    stop();
    const before = h.readings.length;
    h.emitTimeline({ type: "timeline", item: { type: "reasoning", text: "x".repeat(100) }, provider: "pi", turnId: "t1" });
    h.tick(250);
    expect(h.readings.length).toBe(before);
  });
});
