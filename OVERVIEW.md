# Paseo TPS

Paseo TPS shows how fast a model is generating: a tokens-per-second pill in the composer next to Tasks and
Subagents, with a popover for the details.

Speed is measured per second of generation, not per second of wall clock. A turn that runs a shell command
spends most of its time waiting for that command, and averaging over wall clock reports a fast model as
slow, so the plugin keeps a separate clock that only advances while the model is the thing being waited on.
While it is stopped, the pill holds its most recent value. The popover shows both the generation-time and
wall-clock figures so the difference is visible.

Token counts come from the provider, but providers report them at step boundaries rather than per chunk, and
on a plain generation turn some report nothing until the turn ends. While generating, the rate is therefore
an estimate derived from streamed characters, marked with a `~`. The chars-per-token factor behind it is
learned per provider and model from finished turns, separately for reasoning text and answer text, because
the two differ by roughly a factor of two. The turn average shown when a turn ends is measured, not
estimated.

There is nothing to configure. The plugin keeps no history, writes no files, and makes no network requests.
Learned factors live in memory and reset when the plugin reloads; a few real turns are enough to move them.
Turns that produce only tool-call arguments and no streamed text have no observable generation window, so
their average is reported as unknown.

Verified against pi with deepseek. Other providers are expected to work but have not been tested.
