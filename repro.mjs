// Reproduces extra MODEL_STEP / MODEL_INFERENCE spans from @mastra/observability's
// ModelSpanTracker when the agent's output stream is processed later than the agent loop runs.
//
// Public API only: Mastra + Observability with a recording exporter, an Agent with one tool,
// and a local OpenAI-compatible chat completions stub (streaming SSE). No API keys.
//
// The lag comes from an async `onStepFinish` callback. Mastra awaits it inside the agent's
// output stream, so while it runs the stream records no further chunks (step-start,
// step-finish) in the tracker. The agent loop does not wait for it and starts the next
// model call.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { BaseExporter, Observability } from "@mastra/observability";
import { z } from "zod";

const ON_STEP_FINISH_DELAY_MS = Number(
  process.env.ON_STEP_FINISH_DELAY_MS ?? 50,
);

// ---------------------------------------------------------------- stub provider

/** Answers for the next model calls: 'tool-call', 'text' or 'error-500'. */
let answers = [];
let modelCalls = 0;

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function completionChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason ? { usage } : {}),
  };
}

function sse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    modelCalls++;
    const answer = answers.shift();
    if (answer === "tool-call") {
      sse(res, [
        completionChunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${modelCalls}`,
              type: "function",
              function: { name: "getWeather", arguments: '{"city":"Paris"}' },
            },
          ],
        }),
        completionChunk({}, "tool_calls"),
      ]);
    } else if (answer === "text") {
      sse(res, [
        completionChunk({
          role: "assistant",
          content: "It is sunny in Paris.",
        }),
        completionChunk({}, "stop"),
      ]);
    } else {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "stub internal error", type: "server_error" },
        }),
      );
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

// ---------------------------------------------------------------- recording exporter

class RecordingExporter extends BaseExporter {
  name = "recording";
  spans = [];
  async _exportTracingEvent(event) {
    if (event.type === "span_ended") this.spans.push(event.exportedSpan);
  }
  async shutdown() {}
}

const exporter = new RecordingExporter();

// ---------------------------------------------------------------- agent

const provider = createOpenAICompatible({
  name: "stub",
  baseURL,
  apiKey: "unused",
});

const getWeather = createTool({
  id: "getWeather",
  description: "Get the weather for a city",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ forecast: z.string() }),
  execute: async () => ({ forecast: "sunny" }),
});

const mastra = new Mastra({
  logger: false,
  agents: {
    weatherAgent: new Agent({
      id: "weatherAgent",
      name: "weatherAgent",
      instructions: "Answer weather questions using the tool.",
      model: provider.chatModel("stub-model"),
      tools: { getWeather },
    }),
  },
  observability: new Observability({
    configs: { default: { serviceName: "repro", exporters: [exporter] } },
  }),
});

// ---------------------------------------------------------------- one run

async function run(label, queuedAnswers, onStepFinishDelayMs) {
  answers = [...queuedAnswers];
  modelCalls = 0;
  exporter.spans.length = 0;

  const output = await mastra
    .getAgent("weatherAgent")
    .stream("What is the weather in Paris?", {
      maxSteps: 5,
      errorProcessors: [], // no automatic retry of the HTTP 500
      onStepFinish: async () => {
        if (onStepFinishDelayMs) await sleep(onStepFinishDelayMs);
      },
    });
  for await (const _chunk of output.fullStream) {
    // drain
  }
  await sleep(200); // let the span_ended events reach the exporter

  const spans = exporter.spans;
  const byId = new Map(spans.map((s) => [s.id, s]));
  const steps = spans.filter((s) => s.type === "model_step");
  const inferences = spans.filter((s) => s.type === "model_inference");

  console.log(
    `\n=== ${label}, onStepFinish delay ${onStepFinishDelayMs} ms ===`,
  );
  console.log(`model calls served by the stub: ${modelCalls}`);
  for (const s of [...steps, ...inferences].sort(
    (a, b) => a.startTime - b.startTime,
  )) {
    const parent = byId.get(s.parentSpanId);
    console.log(
      `  ${s.type.padEnd(15)} ${s.name.padEnd(12)} parent=${(parent?.name ?? "?").padEnd(17)} ` +
        `finishReason=${s.attributes?.finishReason ?? "-"}` +
        (s.type === "model_inference" && s.attributes?.responseModel
          ? ` responseModel=${s.attributes.responseModel}`
          : ""),
    );
  }

  const problems = [];
  if (inferences.length > modelCalls)
    problems.push(
      `${inferences.length} MODEL_INFERENCE spans for ${modelCalls} model calls`,
    );
  if (steps.length > modelCalls)
    problems.push(
      `${steps.length} MODEL_STEP spans for ${modelCalls} model calls`,
    );
  for (const step of steps) {
    const children = inferences.filter(
      (i) => i.parentSpanId === step.id,
    ).length;
    if (children > 1)
      problems.push(
        `${children} model calls under one MODEL_STEP ("${step.name}")`,
      );
  }
  console.log(
    problems.length ? `  -> WRONG: ${problems.join("; ")}` : "  -> ok",
  );
  return problems.length > 0;
}

// ---------------------------------------------------------------- scenarios

const scenarios = [
  [
    "A: tool call, tool call, text (3 model calls)",
    ["tool-call", "tool-call", "text"],
  ],
  ["B: tool call, then HTTP 500 (2 model calls)", ["tool-call", "error-500"]],
];

let reproduced = false;
for (const [label, queued] of scenarios) {
  for (const delay of [0, ON_STEP_FINISH_DELAY_MS]) {
    reproduced = (await run(label, queued, delay)) || reproduced;
  }
}

server.close();
console.log(reproduced ? "\nBUG REPRODUCED" : "\nnot reproduced");
process.exit(reproduced ? 1 : 0);
