#!/usr/bin/env bash
# usage: run-trial.sh <name> <agentId> "<prompt>" [maxSeconds]
set -uo pipefail
name="$1"; agent="$2"; prompt="$3"; max="${4:-200}"
cd /tmp/tpsprobe
out="/tmp/tpsprobe/runs/${name}.jsonl"
nohup node spike.mjs "$agent" "$max" "$out" --poll > "/tmp/tpsprobe/runs/${name}-log.txt" 2>&1 &
spike_pid=$!
sleep 3
echo "[trial] $name -> sending prompt"
paseo send "$agent" "$prompt" 2>&1 | tail -2
wait "$spike_pid"
echo "[trial] $name done"
node analyze.mjs "$out"
