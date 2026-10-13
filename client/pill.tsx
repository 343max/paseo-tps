/**
 * The composer pill: the live number next to Tasks and Subagents, plus a popover with the details.
 *
 * The pill is per agent, so registration follows the agent list. The label is pushed only when the
 * formatted string changes - the sampler runs four times a second and Paseo re-renders on every update.
 */
import type { PluginButton, PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { formatRate, formatTokens, pillLabel } from "./format";
import type { AgentTurnSummary } from "./observer";
import { type ReadingStore, useSurfaceState } from "./store";

const ROW = { flexDirection: "row" as const, gap: 8, justifyContent: "space-between" as const };

function Detail({ label, value, theme }: { label: string; value: string; theme: PluginButtonContentProps["theme"] }) {
  return (
    <View style={ROW}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{label}</Text>
      <Text style={{ color: theme.colors.foreground }}>{value}</Text>
    </View>
  );
}

function LastTurn({ summary, theme }: { summary: AgentTurnSummary; theme: PluginButtonContentProps["theme"] }) {
  const outcome = summary.outcome === "completed" ? "" : ` · ${summary.outcome}`;
  return (
    <Text style={{ color: theme.colors.foregroundMuted }}>
      last turn: {formatRate(summary.tps, { estimated: summary.tokensEstimated })} · {formatTokens(summary.tokens)}{" "}
      tokens · {summary.seconds.toFixed(1)}s{outcome}
    </Text>
  );
}

/** Body of the popover anchored to the pill. Reads the same store the label does. */
export function TpsPopover({ theme, layout, store }: PluginButtonContentProps & { store: ReadingStore }) {
  const state = useSurfaceState(store);
  const reading = state.reading?.reading ?? null;
  const styles = useMemo(
    () => ({
      body: { gap: layout.compact ? 6 : 10, minWidth: 220 },
      title: { color: theme.colors.foreground, fontSize: 16 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  const thinking = reading?.thinkingRate ?? null;
  const answer = reading?.answerRate ?? null;

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Generation speed</Text>
      <Detail label="now" value={formatRate(reading?.rate ?? null, { estimated: reading?.tokensEstimated ?? false })} theme={theme} />
      <Detail label="average" value={formatRate(reading?.averageRate ?? null, { estimated: reading?.tokensEstimated ?? false })} theme={theme} />
      <Detail label="thinking" value={formatRate(thinking)} theme={theme} />
      <Detail label="answer" value={formatRate(answer)} theme={theme} />
      <Detail label="this turn" value={`${formatTokens(reading?.estimatedTokens ?? 0)} tokens`} theme={theme} />
      <Detail
        label="generating"
        value={reading ? `${(reading.generationMs / 1000).toFixed(1)}s of ${(reading.elapsedMs / 1000).toFixed(1)}s` : "—"}
        theme={theme}
      />
      <Detail label="state" value={reading?.state ?? "idle"} theme={theme} />
      <Detail
        label="factor"
        value={
          state.lastTurn
            ? `${state.lastTurn.factors.thinking.toFixed(1)}/${state.lastTurn.factors.answer.toFixed(1)} chars/tok · ${state.lastTurn.factorSamples} turns learned`
            : "seeds"
        }
        theme={theme}
      />
      {state.lastTurn ? <LastTurn summary={state.lastTurn} theme={theme} /> : null}
      <Text style={styles.muted}>
        {reading?.tokensEstimated
          ? "Estimated from streamed characters until the provider reports tokens."
          : "Token counts reported by the provider."}
      </Text>
    </View>
  );
}

export function createTpsPill(
  client: PluginClientContext,
  store: ReadingStore,
  target: { workspaceId: string; agentId: string },
): { registration: ReturnType<PluginClientContext["addComposerPill"]>; applyLabel: (label: string) => void } {
  const button: PluginButton = {
    title: "Generation speed",
    icon: "Gauge",
    label: "—",
    behavior: { kind: "popover", Content: (props) => <TpsPopover {...props} store={store} /> },
  };
  const registration = client.addComposerPill({
    id: "tps",
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    button,
  });
  let current = button.label;
  return {
    registration,
    applyLabel: (label: string) => {
      if (label === current) return;
      current = label;
      registration.update({ label });
    },
  };
}

export { pillLabel };
