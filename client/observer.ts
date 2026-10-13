/**
 * Watches agents and feeds one engine per agent. All the arithmetic lives in engine.ts; this module is
 * wiring: Paseo subscriptions in, readings out.
 *
 * Two signals per agent:
 *  - the agent timeline stream (character deltas, turn boundaries) - the fast, fine-grained one;
 *  - the agent's usage snapshot - the measured one. Pushes alone proved too irregular during the spike
 *    (p90 gap 9.5 s), so an active turn is also polled every POLL_INTERVAL_MS while it runs.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { type Reading, type TokenFactors, TpsEngine, type TurnOutcome } from "./engine";
import { FactorBook, isQualifying } from "./factors";

export const POLL_INTERVAL_MS = 3000;
export const SAMPLE_INTERVAL_MS = 250;

export interface AgentTurnSummary {
  agentId: string;
  workspaceId: string;
  provider: string | null;
  model: string | null;
  turnId: string | null;
  outcome: TurnOutcome | null;
  seconds: number;
  /** Time the model was the thing being waited on - the denominator for `tps`. */
  generationSeconds: number;
  tokens: number;
  tokensEstimated: boolean;
  tps: number | null;
  wallClockTps: number | null;
  thinkingChars: number;
  answerChars: number;
  factors: TokenFactors;
  /** How many qualifying turns the factors were learned from; 0 means they are still the seeds. */
  factorSamples: number;
}

export interface AgentReading {
  agentId: string;
  workspaceId: string;
  reading: Reading;
}

/** The slice of an agent snapshot this plugin needs; PaseoAgent satisfies it structurally. */
export interface AgentSnapshotLike {
  id: string;
  workspaceId?: string | null;
  status: string;
  provider?: string | null;
  model?: string | null;
  lastUsage?: { outputTokens?: number } | null;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
}

export interface ObserverOptions {
  onReading: (update: AgentReading) => void;
  onTurnEnd: (summary: AgentTurnSummary) => void;
  /** Overrides applied on top of the learned factors, for tests and for a future settings screen. */
  factors?: Partial<TokenFactors>;
  log?: (...args: unknown[]) => void;
}

interface WatchedAgent {
  agentId: string;
  workspaceId: string;
  engine: TpsEngine;
  /** Provider/model last seen, used to name the ledger record and to key learned factors. */
  provider: string | null;
  model: string | null;
  latestTokens: number | null;
  /** Live timeline subscription for the current turn, if any. */
  timeline: (() => void) | null;
  lastLabel: string | null;
}

/** Injectable clock so the sampler can be tested without timers. */
export interface Clock {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class TpsObserver {
  private agents = new Map<string, WatchedAgent>();
  private readonly log: (...args: unknown[]) => void;
  private config: { factors: Partial<TokenFactors> };
  /** Chars-per-token learned from finished turns, per provider+model. */
  private readonly factors = new FactorBook();
  private cleanup: Array<() => void> = [];
  private stopped = false;

  constructor(
    private readonly client: PluginClientContext,
    private readonly options: ObserverOptions,
    private readonly clock: Clock = realClock,
  ) {
    this.log = options.log ?? (() => {});
    this.config = { factors: options.factors ?? {} };
  }

  setFactors(factors: Partial<TokenFactors>): void {
    this.config.factors = factors;
    for (const agent of this.agents.values()) agent.engine.setFactors(factors);
  }

  /**
   * Feeds one agent snapshot in. The caller owns the agent-list observation, so a single subscription can
   * drive both the engines and the surfaces that render them.
   */
  observe(agent: AgentSnapshotLike): void {
    this.observeAgent(agent);
  }

  /** Drops an agent and releases its timeline subscription. */
  forget(agentId: string): void {
    const watched = this.agents.get(agentId);
    if (!watched) return;
    watched.timeline?.();
    this.agents.delete(agentId);
  }

  start(): () => void {
    this.stopped = false;

    const pollHandle = this.clock.setInterval(() => void this.pollUsage(), POLL_INTERVAL_MS);
    const sampleHandle = this.clock.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.cleanup.push(() => this.clock.clearInterval(pollHandle));
    this.cleanup.push(() => this.clock.clearInterval(sampleHandle));

    return () => {
      this.stopped = true;
      for (const run of this.cleanup) run();
      this.cleanup = [];
      for (const agent of this.agents.values()) agent.timeline?.();
      this.agents.clear();
    };
  }

  /** Reads the current value for every agent being watched. Public so surfaces can pull on mount. */
  readAll(): AgentReading[] {
    const now = this.clock.now();
    return [...this.agents.values()].map((agent) => ({
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      reading: agent.engine.read(now),
    }));
  }

  private observeAgent(agent: AgentSnapshotLike): void {
    if (this.stopped) return;
    const workspaceId = agent.workspaceId ?? null;
    // A composer pill needs a workspace to live in; without one there is nothing to attach to.
    if (!workspaceId) return;
    const tokens = agent.lastUsage?.outputTokens;
    let watched = this.agents.get(agent.id);
    if (!watched) {
      watched = {
        agentId: agent.id,
        workspaceId,
        engine: new TpsEngine({ factors: this.config.factors }),
        provider: null,
        model: agent.model ?? null,
        latestTokens: typeof tokens === "number" ? tokens : null,
        timeline: null,
        lastLabel: null,
      };
      this.agents.set(agent.id, watched);
    } else {
      watched.workspaceId = workspaceId;
      watched.model = agent.model ?? watched.model;
    }
    if (typeof tokens === "number" && tokens !== watched.latestTokens) {
      watched.latestTokens = tokens;
      // The agent snapshot is the only place usage reaches a plugin: the timeline subscription does not
      // carry usage_updated events (verified during the spike, and enforced by the SDK types).
      watched.engine.onTokens({ now: this.clock.now(), tokens });
    }

    const now = this.clock.now();
    const activeTurnId = agent.activeTurn?.turnId ?? null;
    const engineTurnId = watched.engine.getIdentity().turnId;
    if (activeTurnId && activeTurnId !== engineTurnId) {
      // A turn is already running that this engine has not seen - the normal case right after the plugin
      // loads. Start it with an unknown baseline so the first provider value defines the baseline instead
      // of crediting the turn with every token the session ever produced.
      watched.engine.setFactors(this.factorsForTurn(agent.provider ?? watched.provider, watched.model));
      watched.engine.startTurn({
        now,
        // The value we already hold is the best baseline available: anything produced after this moment
        // counts, and only tokens from before we attached are lost. `null` means we have never seen a
        // value, in which case the first one observed becomes the baseline.
        tokens: watched.latestTokens,
        turnId: activeTurnId,
        provider: agent.provider ?? undefined,
        model: watched.model ?? undefined,
      });
      watched.provider = agent.provider ?? watched.provider;
    } else if (!activeTurnId && watched.engine.isActive()) {
      // The daemon says nothing is running and the engine agrees it has gone quiet, so the end of the turn
      // was never delivered to us. Close it instead of leaving the pill stuck on a stale rate forever.
      if (watched.engine.read(now).state === "waiting") {
        watched.engine.endTurn({ now, outcome: "unknown" });
        this.emitSummary(watched, now);
        this.options.onReading({
          agentId: watched.agentId,
          workspaceId: watched.workspaceId,
          reading: watched.engine.read(now),
        });
      }
    }

    // A running agent needs its stream; an idle one can drop it to keep the subscription count low.
    const running = agent.status === "running" || Boolean(agent.activeTurn);
    if (running) this.attachTimeline(watched);
    else if (watched.timeline && !watched.engine.isActive()) {
      watched.timeline();
      watched.timeline = null;
    }
  }

  private attachTimeline(watched: WatchedAgent): void {
    if (watched.timeline) return;
    const handle = this.client.paseo.agents.ref(watched.agentId);
    const subscription = handle.timeline.subscribe((message) => {
      if (this.stopped) return;
      const event = message.event;
      if (!event) return;
      switch (event.type) {
        case "turn_started":
          watched.provider = event.provider;
          watched.engine.setFactors(this.factorsForTurn(event.provider, watched.model));
          watched.engine.startTurn({
            now: this.clock.now(),
            // No known baseline yet is fine: the first provider value establishes it.
            tokens: watched.latestTokens,
            turnId: event.turnId ?? null,
            provider: event.provider,
            model: watched.model ?? undefined,
          });
          return;
        case "timeline": {
          const item = event.item;
          if (item.type === "assistant_message") {
            watched.engine.onDelta({ now: this.clock.now(), kind: "answer", chars: item.text.length });
          } else if (item.type === "reasoning") {
            watched.engine.onDelta({ now: this.clock.now(), kind: "thinking", chars: item.text.length });
          } else if (item.type === "tool_call") {
            // Tool execution is not model generation: the clock pauses for as long as it runs.
            watched.engine.onToolCall({
              now: this.clock.now(),
              callId: typeof item.callId === "string" ? item.callId : null,
              status: String(item.status ?? "running"),
            });
          }
          return;
        }
        case "turn_completed":
        case "turn_failed":
        case "turn_canceled": {
          const now = this.clock.now();
          const tokens = "usage" in event ? event.usage?.outputTokens : undefined;
          if (typeof tokens === "number") watched.latestTokens = tokens;
          const outcome: TurnOutcome =
            event.type === "turn_completed" ? "completed" : event.type === "turn_failed" ? "failed" : "canceled";
          watched.engine.endTurn({ now, outcome, tokens });
          this.emitSummary(watched, now);
          // One last reading so the pill shows this turn's average instead of freezing on the last live value.
          this.options.onReading({ agentId: watched.agentId, workspaceId: watched.workspaceId, reading: watched.engine.read(now) });
          // Keep the reading around so the pill can show this turn's average while idle.
          const released = watched.timeline;
          watched.timeline = null;
          released?.();
          return;
        }
        default:
          return;
      }
    });
    watched.timeline = () => subscription();
  }

  /**
   * Pushes the measured token value from the agent snapshot. Called on a timer while a turn runs because
   * the daemon's pushes arrive irregularly (measured p90 gap: 9.5 s).
   */
  private async pollUsage(): Promise<void> {
    if (this.stopped) return;
    for (const agent of this.agents.values()) {
      if (!agent.engine.isActive()) continue;
      try {
        const handle = this.client.paseo.agents.ref(agent.agentId);
        await handle.refresh();
        const tokens = handle.current()?.lastUsage?.outputTokens;
        if (typeof tokens === "number") {
          agent.latestTokens = tokens;
          agent.engine.onTokens({ now: this.clock.now(), tokens });
        }
      } catch (error) {
        this.log("tps: usage poll failed", agent.agentId, error);
      }
    }
  }

  private sample(): void {
    if (this.stopped) return;
    for (const update of this.readAll()) {
      if (this.agents.get(update.agentId)?.engine.isActive() ?? false) this.options.onReading(update);
    }
  }

  private factorsForTurn(provider: string | null, model: string | null): TokenFactors {
    const key = FactorBook.key(provider, model);
    const learned = this.factors.factorsFor(key);
    return { ...learned, ...this.config.factors };
  }

  /**
   * A finished turn is a free measurement of the model's chars-per-token, but only when it is honest to use
   * it: the provider must have reported tokens (not an estimate), the turn must have completed rather than
   * been interrupted mid-stream, and the streamed characters must actually represent those tokens.
   */
  private learnFromTurn(summary: {
    provider: string | null;
    model: string | null;
    outcome: TurnOutcome | null;
    tokensEstimated: boolean;
    tokens: number;
    thinkingChars: number;
    answerChars: number;
  }): void {
    if (summary.outcome !== "completed") return;
    if (summary.tokensEstimated) return;
    const observation = {
      thinkingChars: summary.thinkingChars,
      answerChars: summary.answerChars,
      tokens: summary.tokens,
    };
    if (!isQualifying(observation)) return;
    const key = FactorBook.key(summary.provider, summary.model);
    this.factors.record(key, observation);
    this.log("tps: learned chars/token", key, observation, this.factors.factorsFor(key));
  }

  /** Exposed for tests and for a future settings screen that wants to show the learned values. */
  factorsFor(provider: string | null, model: string | null): TokenFactors {
    return this.factors.factorsFor(FactorBook.key(provider, model));
  }

  private emitSummary(watched: WatchedAgent, now: number): void {
    const summary = watched.engine.summarize(now);
    this.learnFromTurn(summary);
    this.options.onTurnEnd({
      agentId: watched.agentId,
      workspaceId: watched.workspaceId,
      provider: summary.provider,
      model: summary.model,
      turnId: summary.turnId,
      outcome: summary.outcome,
      seconds: summary.seconds,
      generationSeconds: summary.generationSeconds,
      tokens: summary.tokens,
      tokensEstimated: summary.tokensEstimated,
      tps: summary.tps,
      wallClockTps: summary.wallClockTps,
      thinkingChars: summary.thinkingChars,
      answerChars: summary.answerChars,
      factors: summary.factors,
      factorSamples: this.factors.sampleCount(FactorBook.key(summary.provider, summary.model)),
    });
  }
}
