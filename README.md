# Mastra ModelSpanTracker race: extra MODEL_STEP / MODEL_INFERENCE spans

Minimal reproduction for a race in `@mastra/observability`'s `ModelSpanTracker`. When the agent's
output stream records chunks later than the agent loop runs, a run gets more `MODEL_INFERENCE` (and
`MODEL_STEP`) spans than it made model calls, and a model call is recorded under the previous step.

```sh
npm install
npm run repro   # exit 1 = BUG REPRODUCED
```

No API keys and no network: the model is a local OpenAI-compatible chat completions stub (streaming
SSE) on `127.0.0.1`, used through `@ai-sdk/openai-compatible`. The script uses only Mastra's public
API and does not patch Mastra.

## What the script does

`repro.mjs` sets up:

- `new Mastra({ observability })` with an `Observability` config whose only exporter records every
  ended span;
- an `Agent` with one tool (`getWeather`);
- a stub provider that answers the queued responses in order: a tool call, text with `stop`, or an
  HTTP 500.

It runs two scenarios, each twice: once with an `onStepFinish` callback that returns at once, and
once with an `onStepFinish` that waits 50 ms.

- **A**: tool call, tool call, text (3 model calls).
- **B**: tool call, then HTTP 500 on the second call (2 model calls). The default error processors
  are turned off (`errorProcessors: []`) so the 500 is not retried.

It prints the `MODEL_STEP` and `MODEL_INFERENCE` spans of each run (name, parent, `finishReason`,
`responseModel`) and exits 1 if a run has more of either than the stub served model calls, or if a
`MODEL_STEP` has more than one `MODEL_INFERENCE` child.

## Why a slow `onStepFinish`

The tracker gets one run's step and inference lifecycle from two sources that are not ordered with
each other:

1. the agent loop, which calls `startStep()` and `startInference()` before each model call and ends
   the inference on the provider's `finish` chunk;
2. the agent's output stream, which records `step-start` and `step-finish` chunks through
   `wrapStream()` → `recordChunk()`, and can open or close steps and inferences itself.

The loop does not wait for the output stream. `MastraModelOutput` awaits `onStepFinish` inside its
stream transform, so while the callback runs no later chunk is recorded, but the loop goes on to the
next model call. Any other delay in the output stream has the same effect (we first saw it as rare
failures on a slow CI runner, without any callback). A slow reader of `output.fullStream` does not
reproduce it, because `MastraModelOutput` reads the stream eagerly.

The callback delay only makes the timing deterministic. With `ON_STEP_FINISH_DELAY_MS=1` the run is
usually correct; from about 5 ms it fails every time on our machine.

## Versions

`package.json` pins the latest published releases. Results with other versions (each run several
times, same result every time):

| `@mastra/core` | `@mastra/observability` | A               | B               |
| -------------- | ----------------------- | --------------- | --------------- |
| 1.79.0         | 1.21.0                  | ok              | ok              |
| 1.79.0         | 1.22.0                  | ok              | ok              |
| 1.80.0         | 1.21.0                  | ok              | ok              |
| 1.80.0         | 1.22.0                  | ok              | ok              |
| 1.81.0         | 1.21.0                  | ok              | **extra spans** |
| 1.81.0         | 1.22.0                  | ok              | **extra spans** |
| 1.81.0         | 1.23.0                  | **extra spans** | **extra spans** |
| 1.82.0         | 1.23.1                  | **extra spans** | **extra spans** |
| 1.83.0         | 1.24.0                  | **extra spans** | **extra spans** |

To try another pair:

```sh
npm install --save-exact @mastra/core@1.82.0 @mastra/observability@1.23.1
npm run repro
```

Tested with Node 26.12.1 and npm 12.2.1 on macOS.
