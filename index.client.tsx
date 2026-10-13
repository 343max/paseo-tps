/**
 * Client entry: one observer for the whole plugin, one pill per agent.
 *
 * Surfaces read the same per-agent store, so they cannot disagree with each other. Everything that can be
 * computed without React lives in engine.ts (pure) and observer.ts (wiring), which keeps the components
 * thin and the arithmetic testable.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { pillLabel } from "./client/format";
import { type AgentSnapshotLike, TpsObserver, type AgentTurnSummary } from "./client/observer";
import { createTpsPill } from "./client/pill";
import { createReadingStore, type ReadingStore } from "./client/store";

interface AgentSurface {
  store: ReadingStore;
  remove: () => void;
  applyLabel: (label: string) => void;
}

export default function contribute(client: PluginClientContext) {
  const surfaces = new Map<string, AgentSurface>();
  const lifetime = new AbortController();

  const removeSurface = (agentId: string) => {
    const surface = surfaces.get(agentId);
    if (!surface) return;
    surface.remove();
    surfaces.delete(agentId);
  };

  const observer = new TpsObserver(client, {
    onReading: ({ agentId, workspaceId, reading }) => {
      const surface = surfaces.get(agentId);
      if (!surface) return;
      surface.store.set({ reading: { agentId, workspaceId, reading } });
      surface.applyLabel(pillLabel(reading));
    },
    onTurnEnd: (summary: AgentTurnSummary) => {
      const surface = surfaces.get(summary.agentId);
      surface?.store.set({ lastTurn: summary });
      // The per-turn ledger record and the transcript row are wired in the next steps; until then this
      // line is the evidence that a turn was captured, visible in `paseo plugin logs paseo-tps`.
      console.log(`tps: turn ${summary.turnId ?? "?"} ${summary.outcome}`, {
        tokens: summary.tokens,
        estimated: summary.tokensEstimated,
        generatingSeconds: Number(summary.generationSeconds.toFixed(2)),
        wallSeconds: Number(summary.seconds.toFixed(2)),
        tps: summary.tps === null ? null : Number(summary.tps.toFixed(1)),
        wallClockTps: summary.wallClockTps === null ? null : Number(summary.wallClockTps.toFixed(1)),
        thinkingChars: summary.thinkingChars,
        answerChars: summary.answerChars,
      });
    },
    log: (...args) => console.log(...args),
  });

  // Pills follow the agent list. An agent that has never been seen gets one on first sight, and it stays
  // while the agent exists so the last turn's average remains visible when the agent is idle.
  void client.paseo.agents
    .list({ filter: { includeArchived: false }, subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) track(agent);
          for (const agentId of [...surfaces.keys()]) {
            if (!entries.some(({ agent }) => agent.id === agentId)) {
              observer.forget(agentId);
              removeSurface(agentId);
            }
          }
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") track(update.agent);
          else {
            observer.forget(update.agentId);
            removeSurface(update.agentId);
          }
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("tps: agent list failed", error);
    });

  /** One code path feeds both the engine and the pill for an agent. */
  function track(agent: AgentSnapshotLike) {
    observer.observe(agent);
    ensureSurface(agent.id, agent.workspaceId ?? null);
  }

  function ensureSurface(agentId: string, workspaceId: string | null) {
    if (lifetime.signal.aborted || surfaces.has(agentId) || !workspaceId) return;
    const store = createReadingStore();
    try {
      const pill = createTpsPill(client, store, { workspaceId, agentId });
      surfaces.set(agentId, {
        store,
        remove: () => pill.registration.remove(),
        applyLabel: pill.applyLabel,
      });
    } catch (error) {
      // A duplicate registration means another surface already owns this agent; not worth failing over.
      console.error("tps: pill registration failed", agentId, error);
    }
  }

  const stopObserver = observer.start();

  return () => {
    lifetime.abort();
    stopObserver();
    for (const surface of surfaces.values()) surface.remove();
    surfaces.clear();
  };
}
