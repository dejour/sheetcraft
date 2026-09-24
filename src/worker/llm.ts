import { readGenerationLines } from "./generationStream";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessageLike, MessageContent, ToolCall } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { planScoreEdit } from "../shared";
import type { PlanScoreEditInput, PlannerHistoryMessage, Pitch, Score, ScoreOperation } from "../shared";

export type LlmBindings = {
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
};

function llmConfig(env: LlmBindings) {
  const baseUrl = (env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY,
    model: env.LLM_MODEL ?? env.DEEPSEEK_MODEL ?? "deepseek-flash",
    isDeepSeek: baseUrl.includes("deepseek")
  };
}

function chatModel(
  env: LlmBindings,
  options: {
    temperature: number;
    maxTokens: number;
  }
) {
  const config = llmConfig(env);
  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    maxRetries: 0,
    streamUsage: false,
    useResponsesApi: false,
    ...(config.isDeepSeek
      ? {
          modelKwargs: {
            thinking: { type: "disabled" }
          }
        }
      : {}),
    configuration: {
      baseURL: config.baseUrl
    }
  });
}

function langChainMessages(
  systemPrompt: string,
  history: PlannerHistoryMessage[] | undefined,
  userContent: string
): BaseMessageLike[] {
  return [
    { role: "system", content: systemPrompt },
    ...historyMessages(history),
    {
      role: "user",
      content: userContent
    }
  ];
}

function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
}

type PlannerMode = "edit" | "generate";

export type GenerationStructurePlan = {
  title?: string;
  key?: { fifths: number };
  timeSignature?: { beats: number; beatType: number };
  measures: Array<{
    measure: number;
    section: string;
    chord: string;
    requiredBass: string;
    requiredChordTones: string[];
    role: string;
  }>;
};

export type StreamScoreOperationChunk = {
  done: boolean;
  assistantText?: string;
  operation?: ScoreOperation;
};

export function hasLlmPlanner(env: LlmBindings): boolean {
  return Boolean(llmConfig(env).apiKey);
}

export async function planGenerationStructureWithModel(env: LlmBindings, input: PlanScoreEditInput): Promise<GenerationStructurePlan> {
  if (!hasLlmPlanner(env)) throw new Error("The LLM API key is not configured.");
  const content = await callGenerationPlanModel(env, input);
  return parseGenerationPlanContent(content);
}

export async function planScoreEditWithModel(
  env: LlmBindings,
  input: PlanScoreEditInput,
  score: Score,
  mode: PlannerMode = "edit"
): Promise<{ operations: ScoreOperation[]; assistantText: string }> {
  if (!hasLlmPlanner(env)) return planScoreEdit(input);

  try {
    return await callPlannerModel(env, input, score, mode);
  } catch (error) {
    const fallback = await planScoreEdit(input);
    return {
      operations: fallback.operations,
      assistantText: `Model planning failed, so I used the local planner. ${errorMessage(error)} ${fallback.assistantText}`
    };
  }
}

export async function classifyComposerIntent(
  env: LlmBindings,
  message: string,
  context?: { scoreTitle?: string; measureCount?: number }
): Promise<"generate" | "edit"> {
  if (!hasLlmPlanner(env)) return "edit";

  try {
    const content = await withRetry(() => callIntentClassificationModel(env, message, context));
    const parsed = parsePlannerJson(content);
    return parsed.intent === "generate" ? "generate" : "edit";
  } catch {
    return "edit";
  }
}

export async function streamScoreOperationsWithModel(
  env: LlmBindings,
  input: PlanScoreEditInput,
  onChunk: (chunk: StreamScoreOperationChunk) => void,
  score?: Score,
  mode: PlannerMode = "generate"
): Promise<{ operations: ScoreOperation[]; assistantText: string }> {
  if (!hasLlmPlanner(env)) return planScoreEdit(input);

  const operations: ScoreOperation[] = [];
  let assistantText = "Your sheet is ready.";
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await callOperationStreamModel(env, input, score, mode, (chunk) => {
        if (chunk.operation) operations.push(chunk.operation);
        if (chunk.assistantText?.trim()) assistantText = chunk.assistantText.trim();
        onChunk(chunk);
      });
      break;
    } catch (error) {
      if (operations.length === 0 && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      throw error;
    }
  }

  return { operations, assistantText };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(run: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetryableLlmError(error) || attempt >= maxAttempts) throw error;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function isRetryableLlmError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const status = (error as Error & { status?: number }).status;
  if (status !== undefined) return status === 429 || status >= 500;
  return (error as Error & { retryable?: boolean }).retryable !== false;
}

async function callPlannerModel(
  env: LlmBindings,
  input: PlanScoreEditInput,
  score: Score,
  mode: PlannerMode
): Promise<{ operations: ScoreOperation[]; assistantText: string }> {
  return withRetry(async () => {
    const model = chatModel(env, {
      temperature: 0.2,
      maxTokens: 6000
    });
    const response = await model
      .bindTools(scoreOperationTools(mode, false), { tool_choice: "required" })
      .invoke(
        langChainMessages(
          plannerSystemPrompt(mode),
          input.history,
          JSON.stringify({
            mode,
            userMessage: input.message,
            selection: input.selection ?? null,
            context: input.context ?? null,
            score: compactScoreForPrompt(score, input)
          })
        )
      );
    const operations = parseToolCallOperations(response.tool_calls).slice(0, 12);
    if (operations.length === 0) throw new Error("The model returned no score operation tool calls.");
    return {
      operations,
      assistantText: messageText(response.content).trim() || "I prepared the score operations."
    };
  });
}

async function callGenerationPlanModel(env: LlmBindings, input: PlanScoreEditInput): Promise<string> {
  return withRetry(async () => {
    const model = chatModel(env, {
      temperature: 0.1,
      maxTokens: 5000
    });
    const response = await model.invoke(
      langChainMessages(
        generationStructureSystemPrompt(),
        input.history,
        JSON.stringify({
          userMessage: input.message,
          context: input.context ?? null
        })
      ),
      { response_format: { type: "json_object" } }
    );
    const content = messageText(response.content);
    if (!content) throw new Error("The model returned an empty structure plan.");
    return content;
  });
}

async function callIntentClassificationModel(
  env: LlmBindings,
  message: string,
  context?: { scoreTitle?: string; measureCount?: number }
): Promise<string> {
  const model = chatModel(env, {
    temperature: 0,
    maxTokens: 100
  });
  const response = await model.invoke(
    langChainMessages(intentClassificationSystemPrompt(context), undefined, message),
    { response_format: { type: "json_object" } }
  );
  const content = messageText(response.content);
  if (!content) throw new Error("The model returned an empty intent classification.");
  return content;
}

async function callOperationStreamModel(
  env: LlmBindings,
  input: PlanScoreEditInput,
  score: Score | undefined,
  mode: PlannerMode,
  onChunk: (chunk: StreamScoreOperationChunk) => void
): Promise<void> {
  if (mode === "generate") {
    const schemas = SCORE_OPERATION_TOOLS.filter(tool =>
      ["create_score", "replace_measures"].includes(tool.function.name)
    ).map(tool => ({ ...tool.function.parameters, properties: { ...(tool.function.parameters.properties as Record<string, JsonSchema>), type: { const: tool.function.name } }, required: ["type", ...(tool.function.parameters.required as string[] ?? [])] }));
    const prompt = operationStreamSystemPrompt(mode)
      .replace("Use the provided score operation tools to generate the score. Call exactly one tool at a time.",
        "Generate the entire piece in this single response as newline-delimited JSON. Each line must be one complete operation object with a type field and its arguments. Do not use markdown fences or tool calls. Put params and fromMeasure/toMeasure directly beside type, never inside an arguments wrapper.")
      .replace("After every required measure has been emitted, stop calling tools and reply with a short final message.",
        'After the final measure, emit {"done":true} on its own line and end the response. Do not add further measures.')
      .replace("- Do not emit MusicXML or write score operation JSON in normal text; use the tools.",
        "- Output only the JSON lines described above. Operation argument schemas: " + JSON.stringify(schemas));
    const model = chatModel(env, { temperature: 0.2, maxTokens: operationStreamMaxTokens(input.message) });
    const stream = await model.stream(langChainMessages(prompt, input.history,
      JSON.stringify({ userMessage: input.message, context: input.context ?? null })));
    async function* textChunks() {
      for await (const chunk of stream) {
        const finish = chunk.response_metadata?.finish_reason;
        if (finish && finish !== "stop") throw new Error(`Model generation ended with ${finish}.`);
        yield messageText(chunk.content);
      }
    }
    let measureCount = 0;
    await readGenerationLines(textChunks(), value => {
      if (!isRecord(value) || !isScoreOperation(value)) throw new Error("Invalid streamed score operation.");
      const operation = value as ScoreOperation;
      if (operation.type !== (measureCount === 0 ? "create_score" : "replace_measures")) {
        throw new Error("Unexpected operation in generated score.");
      }
      onChunk({ done: false, operation, assistantText: progressTextForOperation(operation) });
      measureCount += 1;
    });
    if (!measureCount) throw new Error("The model returned no measures.");
    onChunk({ done: true, assistantText: "Your sheet is ready." });
    return;
  }
  const messages = langChainMessages(
    operationStreamSystemPrompt(mode),
    input.history,
    JSON.stringify({
      mode,
      userMessage: input.message,
      selection: input.selection ?? null,
      context: input.context ?? null,
      score: score ? compactScoreForPrompt(score, input) : null
    })
  );
  const maxToolCalls = 24;

  for (let toolCallCount = 0; toolCallCount < maxToolCalls; toolCallCount += 1) {
    const model = chatModel(env, {
      temperature: 0.2,
      maxTokens: operationStreamMaxTokens(input.message)
    });
    const response = await model
      .bindTools(scoreOperationTools(mode, true, toolCallCount), {
        tool_choice: "auto",
        ...(llmConfig(env).isDeepSeek ? {} : { parallel_tool_calls: false })
      })
      .invoke(messages);
    const content = messageText(response.content);
    if (!response.tool_calls?.length) {
      onChunk({
        done: true,
        assistantText: content.trim() || "The score edit is complete."
      });
      return;
    }

    const toolCall = response.tool_calls[0];
    const operation = parseToolCallOperation(toolCall);
    if (!operation) throw new Error(`The model returned an invalid ${toolCall.name ?? "score operation"} tool call.`);

    onChunk({
      done: false,
      assistantText: content.trim() || progressTextForOperation(operation),
      operation
    });

    const toolCallId = toolCall.id || `score_operation_${toolCallCount + 1}`;
    messages.push(
      new AIMessage({
        content: response.content,
        tool_calls: [{ ...toolCall, id: toolCallId }]
      })
    );
    messages.push(
      new ToolMessage({
        tool_call_id: toolCallId,
        content: JSON.stringify({ ok: true })
      })
    );
  }

  onChunk({ done: true, assistantText: "Stopped after reaching the score operation limit." });
}

function operationStreamMaxTokens(message: string): number {
  const strictCount = message.match(/Generate exactly\s+(\d+)\s+measures/i)?.[1];
  if (!strictCount) return 22000;
  const measureCount = Number(strictCount);
  if (!Number.isFinite(measureCount)) return 6000;
  return Math.min(Math.max(12000, measureCount * 700), 22000);
}

type JsonSchema = Record<string, unknown>;

type ScoreOperationTool = {
  type: "function";
  function: {
    name: ScoreOperation["type"];
    description: string;
    parameters: JsonSchema;
  };
};

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

const pitchSchema = objectSchema(
  {
    step: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G"] },
    alter: { type: "number", enum: [-1, 1] },
    octave: { type: "number" }
  },
  ["step", "octave"]
);

const phraseMarkSchema: JsonSchema = { type: ["string", "null"], enum: ["start", "stop", "continue", null] };
const beamMarkSchema: JsonSchema = { type: ["string", "null"], enum: ["begin", "continue", "end", "none", null] };
const timeSignatureSchema = objectSchema({ beats: { type: "number" }, beatType: { type: "number" } }, ["beats", "beatType"]);
const keySchema = objectSchema({ fifths: { type: "number" } }, ["fifths"]);
const bassSchema = objectSchema(
  {
    step: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G"] },
    alter: { type: "number", enum: [-1, 1] }
  },
  ["step"]
);
const harmonySchema = objectSchema(
  {
    startBeat: { type: "number" },
    root: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G"] },
    alter: { type: "number", enum: [-1, 1] },
    kind: { type: "string" },
    text: { type: ["string", "null"] },
    bass: bassSchema
  },
  ["startBeat"]
);
const tempoSchema = objectSchema(
  {
    startBeat: { type: "number" },
    bpm: { type: ["number", "null"] },
    beatUnit: { type: "string", enum: ["quarter", "eighth", "half"] }
  },
  ["startBeat"]
);
const dynamicSchema = objectSchema(
  {
    startBeat: { type: "number" },
    mark: { type: ["string", "null"], enum: ["pp", "p", "mp", "mf", "f", "ff", null] },
    staff: { type: "number" }
  },
  ["startBeat"]
);
const noteInputSchema = objectSchema(
  {
    startBeat: { type: "number" },
    durationBeats: { type: "number", exclusiveMinimum: 0 },
    pitches: { type: "array", items: pitchSchema },
    staff: { type: "number" },
    voice: { type: "number" },
    tie: phraseMarkSchema,
    slur: phraseMarkSchema,
    beam: beamMarkSchema
  },
  ["startBeat", "durationBeats"]
);
const measureInputSchema = objectSchema(
  {
    number: { type: "number" },
    divisions: { type: "number" },
    timeSignature: timeSignatureSchema,
    durationBeats: { type: "number", exclusiveMinimum: 0 },
    implicit: { type: "boolean" },
    key: keySchema,
    harmonies: { type: "array", items: harmonySchema },
    tempos: { type: "array", items: tempoSchema },
    dynamics: { type: "array", items: dynamicSchema },
    events: { type: "array", items: noteInputSchema }
  },
  ["events"]
);
const rangeSchema = objectSchema(
  {
    fromMeasure: { type: "number" },
    toMeasure: { type: "number" }
  },
  ["fromMeasure", "toMeasure"]
);
const notePlacementProperties: Record<string, JsonSchema> = {
  startBeat: { type: "number" },
  durationBeats: { type: "number", exclusiveMinimum: 0 },
  staff: { type: "number" },
  voice: { type: "number" },
  tie: phraseMarkSchema,
  slur: phraseMarkSchema,
  beam: beamMarkSchema
};

const SCORE_OPERATION_TOOLS: ScoreOperationTool[] = [
  {
    type: "function",
    function: {
      name: "create_score",
      description: "Create a new score. Use this only when generating a score from scratch.",
      parameters: objectSchema(
        {
          params: objectSchema(
            {
              title: { type: "string" },
              partName: { type: "string" },
              measures: { type: "array", items: measureInputSchema },
              key: keySchema,
              timeSignature: timeSignatureSchema,
              divisions: { type: "number" }
            },
            ["measures"]
          )
        },
        ["params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "replace_measures",
      description: "Replace or append complete measures while preserving measures outside the range.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          range: rangeSchema,
          params: objectSchema({ measures: { type: "array", items: measureInputSchema } }, ["measures"])
        },
        ["range", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "copy_measure",
      description: "Copy one existing measure to another measure number.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          fromMeasure: { type: "number" },
          toMeasure: { type: "number" }
        },
        ["fromMeasure", "toMeasure"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "clear_staff_in_measure",
      description: "Remove every event from one staff in a measure while preserving the other staff.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          staff: { type: "number", enum: [1, 2] }
        },
        ["measureNumber", "staff"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "insert_note",
      description: "Insert one pitched note at an exact beat in a measure.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          params: objectSchema({ ...notePlacementProperties, pitch: pitchSchema }, ["startBeat", "durationBeats", "pitch"])
        },
        ["measureNumber", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "insert_rest",
      description: "Insert a rest at an exact beat in a measure.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          params: objectSchema(notePlacementProperties, ["startBeat", "durationBeats"])
        },
        ["measureNumber", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "insert_chord",
      description: "Insert multiple simultaneous pitches at an exact beat in a measure.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          params: objectSchema(
            { ...notePlacementProperties, pitches: { type: "array", items: pitchSchema, minItems: 1 } },
            ["startBeat", "durationBeats", "pitches"]
          )
        },
        ["measureNumber", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "set_harmony",
      description: "Add, update, or remove a harmony or chord symbol at a beat.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          params: harmonySchema
        },
        ["measureNumber", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "set_tempo",
      description: "Add, update, or remove a tempo marking at a beat.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          params: tempoSchema
        },
        ["measureNumber", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "set_dynamic",
      description: "Add, update, or remove a dynamic marking at a beat.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          measureNumber: { type: "number" },
          params: dynamicSchema
        },
        ["measureNumber", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "rewrite_phrase",
      description: "Rewrite a measure range using a high-level musical transformation.",
      parameters: objectSchema(
        {
          partId: { type: "string" },
          range: rangeSchema,
          params: objectSchema(
            {
              strategy: { type: "string", enum: ["simpler", "more_motion", "block_chords", "arpeggio"] },
              preserveContour: { type: "boolean" }
            },
            ["strategy"]
          )
        },
        ["range", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "transpose",
      description: "Transpose the score to a target key.",
      parameters: objectSchema({ params: objectSchema({ targetKey: { type: "string" } }, ["targetKey"]) }, ["params"])
    }
  },
  {
    type: "function",
    function: {
      name: "simplify_left_hand",
      description: "Simplify the left-hand texture over a measure range.",
      parameters: objectSchema(
        {
          range: rangeSchema,
          params: objectSchema(
            {
              strategy: { type: "string", enum: ["root_notes", "root_and_fifth", "block_chords"] },
              maxJumpSemitones: { type: "number" },
              rhythmDensity: { type: "string", enum: ["low", "medium", "high"] },
              preserveRightHand: { type: "boolean" }
            },
            ["strategy"]
          )
        },
        ["range", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Update the pitch, timing, voice, tie, slur, or beam of an existing note by id.",
      parameters: objectSchema(
        {
          noteId: { type: "string" },
          params: objectSchema({
            pitch: pitchSchema,
            pitches: { type: "array", items: pitchSchema },
            startBeat: { type: "number" },
            durationBeats: { type: "number", exclusiveMinimum: 0 },
            reflowFollowing: { type: "boolean" },
            voice: { type: "number" },
            splitPitch: pitchSchema,
            tie: phraseMarkSchema,
            slur: phraseMarkSchema,
            beam: beamMarkSchema
          })
        },
        ["noteId", "params"]
      )
    }
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Delete one existing note or rest by id.",
      parameters: objectSchema({ noteId: { type: "string" } }, ["noteId"])
    }
  }
];

const STREAM_EDIT_TOOL_NAMES = new Set<ScoreOperation["type"]>([
  "replace_measures",
  "copy_measure",
  "clear_staff_in_measure",
  "insert_note",
  "insert_rest",
  "insert_chord",
  "set_harmony",
  "set_tempo",
  "set_dynamic",
  "update_note",
  "delete_note"
]);

function scoreOperationTools(mode: PlannerMode, streaming: boolean, operationIndex = 0): ScoreOperationTool[] {
  if (mode === "generate") {
    const names = new Set<ScoreOperation["type"]>([streaming && operationIndex > 0 ? "replace_measures" : "create_score"]);
    return SCORE_OPERATION_TOOLS.filter((tool) => names.has(tool.function.name));
  }
  if (streaming) return SCORE_OPERATION_TOOLS.filter((tool) => STREAM_EDIT_TOOL_NAMES.has(tool.function.name));
  return SCORE_OPERATION_TOOLS.filter((tool) => tool.function.name !== "create_score");
}

function parseToolCallOperations(toolCalls: ToolCall[] | undefined): ScoreOperation[] {
  return (toolCalls ?? []).map(parseToolCallOperation).filter((operation): operation is ScoreOperation => Boolean(operation));
}

function parseToolCallOperation(toolCall: ToolCall): ScoreOperation | undefined {
  const name = toolCall.name;
  if (!name || !SCORE_OPERATION_TOOLS.some((tool) => tool.function.name === name)) return undefined;
  const args: unknown = toolCall.args;
  if (!isRecord(args)) return undefined;

  const operation = { type: name, ...args };
  return isScoreOperation(operation) ? operation : undefined;
}

function progressTextForOperation(operation: ScoreOperation): string {
  if (operation.type === "create_score") return "Starting on the first measure...";
  if (operation.type === "replace_measures") {
    const from = operation.range.fromMeasure;
    const to = operation.range.toMeasure;
    return from === to ? `Reworking measure ${from}...` : `Reworking measures ${from}–${to}...`;
  }
  if (operation.type === "insert_note") return "Dropping in a note...";
  if (operation.type === "insert_rest") return "Leaving a little space...";
  if (operation.type === "insert_chord") return "Building the chord...";
  if (operation.type === "rewrite_phrase") return "Reshaping the phrase...";
  if (operation.type === "simplify_left_hand") return "Thinning out the left hand...";
  if (operation.type === "transpose") return "Moving it to the new key...";
  if (operation.type === "update_note") return "Adjusting the note...";
  if (operation.type === "delete_note") return "Taking that note out...";
  return "Working through the next change...";
}

function intentClassificationSystemPrompt(context?: { scoreTitle?: string; measureCount?: number }): string {
  const title = context?.scoreTitle?.trim();
  const measureCount = context?.measureCount;
  const projectContext =
    title || measureCount !== undefined
      ? `The user currently has an open score project${title ? ` titled "${title}"` : ""}${measureCount !== undefined ? ` with ${measureCount} measures` : ""}.`
      : "The user currently has an open score project.";

  return `You are the intent classifier for an AI-native sheet music app.

${projectContext}

Classify the user's message as one of two intents:
- "generate": the user wants to create a brand-new piece of music from scratch that replaces the current project and is unrelated to the open score.
- "edit": the user wants to modify, extend, or adjust the current score. This includes requests like "regenerate measure 3", "change the left hand", or "add four measures".

Return only one strict JSON object. Do not output Markdown.

Required JSON shape:
{"intent":"generate"}
or
{"intent":"edit"}

When unsure, return {"intent":"edit"}.`;
}

function generationStructureSystemPrompt(): string {
  return `You are the structure planner for an AI-native sheet music app.

Return only one strict JSON object. Do not output Markdown.

Required JSON shape:
{"title":"short title","key":{"fifths":number},"timeSignature":{"beats":number,"beatType":number},"measures":[{"measure":1,"section":"Intro","chord":"F","requiredBass":"F","requiredChordTones":["F","A","C"],"role":"intro"}]}

Rules:
- Convert the user's natural-language request into a concrete measure-by-measure plan.
- Preserve explicit section order and chord symbols from the user message.
- Each explicit chord in a progression should usually become one measure unless the user says a different duration.
- Treat slash chords like F/C or Am/E as one chord with requiredBass equal to the slash bass.
- Keep altered spellings readable with b/#, for example Bb, F#, Cadd11, Bbsus2.
- Infer requiredChordTones from each chord symbol, including thirds, sevenths, sus/add tones, and slash basses where relevant.
- Do not generate notes, lyrics, or MusicXML.
- Do not reproduce a copyrighted melody. The later score should only use the requested harmony/form and an original melody.
- If the user asks to copy a real song, plan the harmonic/form outline only and keep the role/style generic.
- Prefer 4/4 unless the prompt clearly asks otherwise.
- If the prompt has a clear key, set key.fifths accordingly; otherwise use 0.
- Keep the plan at 48 measures or fewer.`;
}

function operationStreamSystemPrompt(mode: PlannerMode): string {
  if (mode === "edit") {
    return `You are the streaming edit operation planner for an AI-native sheet music app.

Use the provided score operation tools to edit the score. Call exactly one tool at a time.
After every required edit has been emitted, stop calling tools and reply with a short final message.

Rules:
- Edit the existing score incrementally with structured ScoreOperation JSON.
- Preserve the existing score unless the user asks to rewrite or replace it.
- Emit one visible operation at a time.
- If the request touches multiple measures, emit one replace_measures operation per measure, in score order.
- To copy an existing measure to another measure, emit copy_measure. Example: "增加第五节，把第一节复制过来" => {"type":"copy_measure","fromMeasure":1,"toMeasure":5}. Do not rewrite copied notes yourself.
- To add, insert, append, or create a new original measure/bar/小节/节/節 in edit mode, emit replace_measures for the new measure number. For "add one measure" with no location, use score.locationHints.lastMeasureNumber + 1.
- If the request touches multiple notes, emit one update_note/delete_note/insert_* operation per note or beat position.
- For delete/remove/clear requests that target all content from a specific staff/clef in a measure, emit clear_staff_in_measure. F clef, bass clef, left hand, and common typo "f clep" mean staff 2. G clef, treble clef, and right hand mean staff 1. Preserve all events on other staves.
- For delete/remove/clear requests that target individual existing notes, emit delete_note operations using exact existing event ids. Do not invent delete_measure, clear_staff, remove_notes, replace_measures, rewrite_phrase, simplify_left_hand, or transpose for deletion.
- For requests like "add the same note/chord after this", "same after it", "后面加一个相同的 note", or "后面加一样的和弦", copy the selected event's pitches, durationBeats, staff, and voice. Use insert_note for one pitch and insert_chord for multiple pitches. Set startBeat to selected.startBeat + selected.durationBeats. Omit beam unless the user explicitly asks for beaming.
- If the user asks to change a measure/bar/小节/节/節 to a chord or harmony such as "measure 2 to D minor seven", "第二小节改成 Dm7", or "第二节改成 Dm7", rewrite that measure's notes so they fit the requested harmony and include the corresponding harmony marker. Do not only set the chord symbol unless the user explicitly says chord symbol, harmony label, 和弦标记, or 只改和弦.
- If the user follows up after a harmony-only edit with "not just that, change the notes too" or similar, rewrite the same referenced measure's notes to fit the previously requested harmony.
- Do not use replace_measures for localized edits such as "after this note", "后面", "这个音", "these two notes", or a small rhythmic correction. Use update_note, delete_note, insert_note, insert_chord, and insert_rest so unaffected notes remain unchanged.
- Only use replace_measures when the user explicitly asks to rewrite/replace the whole measure. If you must use replace_measures, copy every unaffected existing event exactly, including startBeat, durationBeats, pitches, staff, voice, tie, slur, and beam.
- For clef/staff-specific requests, edit only that staff: G clef/treble/right hand is staff 1, F clef/bass/left hand is staff 2. Preserve the other staff exactly.
- If a staff needs a sustained note such as a whole note while other notes also happen in the same measure, use multiple voices on the same staff instead of placing every note sequentially in one voice.
- In multi-voice writing, use explicit rest events when a voice is silent at the start or between notes and the silence should be visible in notation.
- Do not use aggregate operations such as simplify_left_hand, rewrite_phrase, or transpose in streaming edit mode; expand the edit into per-measure or per-note operations.
- For a truly single-note or single-measure request, one operation is fine.
- If selection.noteIds or context.selectedNotes are present, treat those notes as the primary edit targets unless the user explicitly says otherwise.
- For beam, tie, or slur changes, emit one update_note per affected note using the exact id from selection.noteIds or context.selectedNotes. Never use replace_measures for notation-only edits.
- When changing beam, set params.beam to "begin", "continue", "end", or "none". Use null to restore automatic beaming.
- Do not emit MusicXML or write score operation JSON in normal text; use the tools.
- For an ambiguous dynamic edit like "change to mf", emit exactly one set_dynamic operation. Use no staff for a global score dynamic, or staff 1 if the request refers to the upper/treble staff. Do not duplicate the same dynamic on both staff 1 and staff 2 unless the user explicitly asks for both.
- Events may use "tie" or "slur" with "start", "stop", or "continue". Use tie only to extend the same pitch; use slur for legato phrasing. Events may use beam "begin", "continue", "end", or "none"; omit beam for automatic beaming.
- Locate edits from score.locationHints, score.measureIndex, measure numbers, staff, voice, startBeat, pitch, and note ids. "Last/final/最后/结尾" means score.locationHints.lastMeasureNumber.
- Beats are quarter-note beats. Keep every event inside its measure.
- Choose rhythm, contour, texture, register, staff, and voices freely based on the user's request.`;
  }

  return `You are the streaming operation planner for an AI-native sheet music app.

Use the provided score operation tools to generate the score. Call exactly one tool at a time.
After every required measure has been emitted, stop calling tools and reply with a short final message.

Rules:
- Generate the score incrementally, one measure per operation.
- The first operation must be create_score and must include exactly measure 1.
- Each later musical operation must be replace_measures for exactly one new measure.
- If the user message contains STRICT_GENERATION_PLAN or STRICT_CHORD_PLAN, it is mandatory: generate exactly those measures in order and make each measure match its listed section, chord, requiredBass, and requiredChordTones.
- Do not emit MusicXML or write score operation JSON in normal text; use the tools.
- For an ambiguous dynamic request like "mf", use exactly one dynamic marker. Do not duplicate it on both piano staves unless the user explicitly asks for both.
- Events may use "tie" or "slur" with "start", "stop", or "continue". Use tie only to extend the same pitch; use slur for legato phrasing. Events may use beam "begin", "continue", "end", or "none"; omit beam for automatic beaming.
- Locate edits from score.locationHints, score.measureIndex, measure numbers, staff, voice, startBeat, pitch, and note ids. "Last/final/最后/结尾" means score.locationHints.lastMeasureNumber.
- Beats are quarter-note beats. Measure length is timeSignature.beats * (4 / timeSignature.beatType).
- In 4/4, measure length is 4. In 12/8, measure length is 6; eighth-note motion uses durationBeats 0.5 and startBeat positions such as 0, 0.5, 1, ... 5.5.
- Every event startBeat must be >= 0 and less than the measure length.
- Every event must fit inside the measure: startBeat + durationBeats <= measure length.
- For pickup/anacrusis measures, set measure {"implicit":true,"durationBeats":number}; then events only need to fit inside that shorter duration.
- Prefer 2 to 8 coherent measures unless the user asks for a different length.
- Choose rhythm, contour, texture, register, staff, and voices freely based on the user's request.
- Use ties when a sustained note must cross a barline or beat grouping; use slurs for connected melodic phrases.
- For piano pop or ballad requests, write idiomatic grand-staff piano: staff 1 should carry a vocal-like melody and staff 2 should support with broken chords, bass motion, or chord tones unless the user asks otherwise.
- Use natural phrase rhythm with varied durations: eighth notes, quarter notes, dotted-quarter-like values, syncopated entries, breath rests, and occasional longer notes at phrase endings.
- Avoid defaulting to mostly half notes or whole notes; long notes should feel intentional, not like a placeholder.`;
}

function plannerSystemPrompt(mode: PlannerMode): string {
  return `You are the operation planner for an AI-native sheet music app.

Use the provided score operation tools for every score change.

Rules:
- Never edit or emit MusicXML.
- Do not write score operation JSON in normal text; call the tools.
- Events may use "tie" or "slur" with "start", "stop", or "continue". Use tie only to extend the same pitch; use slur for legato phrasing. Events may use beam "begin", "continue", "end", or "none"; omit beam for automatic beaming.
- Locate edits from score.locationHints, score.measureIndex, measure numbers, staff, voice, startBeat, pitch, and note ids. "Last/final/最后/结尾" means score.locationHints.lastMeasureNumber.
- If selection.noteIds or context.selectedNotes are present, treat those notes as the primary edit targets unless the user explicitly says otherwise.
- To copy an existing measure to another measure, emit copy_measure. Do not rewrite copied notes yourself.
- For delete/remove/clear requests that target all content from a specific staff/clef in a measure, emit clear_staff_in_measure. F clef, bass clef, left hand, staff 2, and common typo "f clep" mean staff 2. G clef, treble clef, right hand, and staff 1 mean staff 1.
- For delete/remove/clear requests that target individual existing notes, emit delete_note operations using exact existing event ids.
- For requests like "add the same note/chord after this", "same after it", "后面加一个相同的 note", or "后面加一样的和弦", copy the selected event's pitches, durationBeats, staff, and voice. Use insert_note for one pitch and insert_chord for multiple pitches. Set startBeat to selected.startBeat + selected.durationBeats. Omit beam unless the user explicitly asks for beaming.
- For beam, tie, or slur changes, emit update_note using the exact note id from selection.noteIds or context.selectedNotes. Never use replace_measures for notation-only edits.
- Beats are quarter-note beats. In 4/4, measure length is 4.
- Keep notes inside their measure unless the user explicitly asks otherwise.
- For generation mode, prefer one create_score operation with 2 to 8 coherent measures.
- If the user provides chord symbols or asks to show chord names, include harmonies on the relevant measures, usually at startBeat 0.
- If the user asks for BPM/tempo or dynamics such as mf, include tempos and dynamics on the relevant measures, usually at startBeat 0.
- For edit mode, preserve the existing score unless the user asks to rewrite or replace it.

Current mode: ${mode}.`;
}

function historyMessages(history: PlannerHistoryMessage[] | undefined) {
  return (history ?? []).slice(-8).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function compactScoreForPrompt(score: Score, input?: PlanScoreEditInput) {
  const primaryPart = score.parts[0];
  const measureNumbers = primaryPart?.measures.map((measure) => measure.number) ?? [];
  const focusMeasures = focusMeasureNumbers(score, input);
  const selectedIds = new Set([
    ...(input?.selection?.noteIds ?? []),
    ...(input?.context?.selectedNotes?.map((note) => note.id) ?? [])
  ]);
  const totalEventCount = score.parts.reduce(
    (partTotal, part) => partTotal + part.measures.reduce((measureTotal, measure) => measureTotal + measure.events.length, 0),
    0
  );
  const includeAllDetails = totalEventCount <= 700;
  const maxDetailedEvents = 900;
  let detailedEventCount = 0;

  return {
    id: score.id,
    title: score.title,
    locationHints: {
      firstMeasureNumber: measureNumbers[0] ?? null,
      lastMeasureNumber: measureNumbers.at(-1) ?? null,
      requestedMeasureNumbers: [...focusMeasures].sort((a, b) => a - b)
    },
    measureIndex: primaryPart?.measures.map((measure) => ({
      number: measure.number,
      divisions: measure.divisions,
      timeSignature: measure.timeSignature,
      key: measure.key,
      harmonies: measure.harmonies,
      tempos: measure.tempos,
      dynamics: measure.dynamics,
      eventCount: measure.events.length,
      staffCounts: staffCounts(measure.events),
      firstEvents: measure.events.slice(0, 3).map(eventForPrompt)
    })) ?? [],
    parts: score.parts.slice(0, 2).map((part) => ({
      id: part.id,
      name: part.name,
      measures: part.measures
        .filter((measure) => includeAllDetails || shouldIncludeDetailedMeasure(measure.number, focusMeasures, measureNumbers))
        .map((measure) => ({
          number: measure.number,
          divisions: measure.divisions,
          timeSignature: measure.timeSignature,
          key: measure.key,
          harmonies: measure.harmonies,
          tempos: measure.tempos,
          dynamics: measure.dynamics,
          events: measure.events
            .filter((event) => {
              if (selectedIds.has(event.id)) return true;
              if (detailedEventCount >= maxDetailedEvents) return false;
              detailedEventCount += 1;
              return true;
            })
            .map(eventForPrompt)
        }))
    })),
    truncated: score.parts.length > 2 || (!includeAllDetails && totalEventCount > detailedEventCount) || detailedEventCount >= maxDetailedEvents
  };
}

function eventForPrompt(event: Score["parts"][number]["measures"][number]["events"][number]) {
  return {
    id: event.id,
    measureNumber: event.measureNumber,
    startBeat: event.startBeat,
    durationBeats: event.durationBeats,
    pitches: event.pitches,
    staff: event.staff,
    voice: event.voice,
    tie: event.tie,
    slur: event.slur,
    beam: event.beam
  };
}

function staffCounts(events: Score["parts"][number]["measures"][number]["events"]) {
  return events.reduce<Record<string, number>>((counts, event) => {
    const staff = String(event.staff ?? 1);
    counts[staff] = (counts[staff] ?? 0) + 1;
    return counts;
  }, {});
}

function focusMeasureNumbers(score: Score, input?: PlanScoreEditInput): Set<number> {
  const focus = new Set<number>();
  const measures = score.parts[0]?.measures ?? [];
  const measureNumbers = measures.map((measure) => measure.number);
  const measureNumberSet = new Set(measureNumbers);
  const message = input?.message ?? "";

  for (const measureNumber of explicitMeasureNumbers(message)) {
    if (measureNumberSet.has(measureNumber)) focus.add(measureNumber);
  }

  if (/(last|final|ending|end|最后|末尾|结尾)/i.test(message)) {
    const lastMeasureNumber = measureNumbers.at(-1);
    if (lastMeasureNumber !== undefined) focus.add(lastMeasureNumber);
  }

  const selection = input?.selection;
  if (selection?.noteIds?.length) {
    const selectedIds = new Set(selection.noteIds);
    for (const measure of measures) {
      if (measure.events.some((event) => selectedIds.has(event.id))) focus.add(measure.number);
    }
  }
  if (selection?.fromMeasure !== undefined && selection.toMeasure !== undefined && selection.toMeasure - selection.fromMeasure <= 16) {
    for (let measureNumber = selection.fromMeasure; measureNumber <= selection.toMeasure; measureNumber += 1) {
      if (measureNumberSet.has(measureNumber)) focus.add(measureNumber);
    }
  }

  return focus;
}

function explicitMeasureNumbers(message: string): number[] {
  const numbers = new Set<number>();
  const patterns = [
    /(?:measure|bar|m\.?)\s*(\d+)/gi,
    /第?\s*([一二三四五六七八九十\d]+)\s*(?:小?节|節)/g
  ];

  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const number = parseMeasureNumber(match[1]);
      if (Number.isInteger(number) && number > 0) numbers.add(number);
    }
  }

  return [...numbers];
}

function parseMeasureNumber(value: string): number {
  const digitNumber = Number(value);
  if (Number.isInteger(digitNumber)) return digitNumber;

  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  if (value === "十") return 10;

  const tenIndex = value.indexOf("十");
  if (tenIndex === -1) return digits[value] ?? Number.NaN;

  const tensText = value.slice(0, tenIndex);
  const onesText = value.slice(tenIndex + 1);
  const tens = tensText ? digits[tensText] : 1;
  const ones = onesText ? digits[onesText] : 0;
  if (!tens || ones === undefined) return Number.NaN;
  return tens * 10 + ones;
}

function shouldIncludeDetailedMeasure(measureNumber: number, focusMeasures: Set<number>, allMeasureNumbers: number[]): boolean {
  if (focusMeasures.has(measureNumber)) return true;
  for (const focusMeasure of focusMeasures) {
    if (Math.abs(measureNumber - focusMeasure) <= 1) return true;
  }
  const firstMeasures = allMeasureNumbers.slice(0, 8);
  const lastMeasures = allMeasureNumbers.slice(-8);
  return firstMeasures.includes(measureNumber) || lastMeasures.includes(measureNumber);
}

function parsePlannerJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed) as Record<string, unknown>;
}

function parseGenerationPlanContent(content: string): GenerationStructurePlan {
  const parsed = parsePlannerJson(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.measures)) {
    throw new Error("The model returned a structure plan without measures.");
  }

  const measures = parsed.measures.slice(0, 48).map((rawMeasure, index) => {
    if (!isRecord(rawMeasure)) throw new Error("The model returned an invalid structure measure.");
    const measure = typeof rawMeasure.measure === "number" && Number.isFinite(rawMeasure.measure) ? rawMeasure.measure : index + 1;
    const section = cleanPlanString(rawMeasure.section, "Section");
    const chord = cleanPlanString(rawMeasure.chord, "C");
    const requiredBass = cleanPlanString(rawMeasure.requiredBass, chord.match(/^[A-G](?:#|b)?/)?.[0] ?? "C");
    const requiredChordTones = Array.isArray(rawMeasure.requiredChordTones)
      ? rawMeasure.requiredChordTones.filter((tone): tone is string => typeof tone === "string").map((tone) => tone.trim()).filter(Boolean).slice(0, 8)
      : [];
    const role = cleanPlanString(rawMeasure.role, "harmony");
    return { measure, section, chord, requiredBass, requiredChordTones, role };
  });

  if (measures.length === 0) throw new Error("The model returned an empty structure plan.");

  return {
    ...(typeof parsed.title === "string" && parsed.title.trim() ? { title: parsed.title.trim().slice(0, 80) } : {}),
    ...(isPlanKey(parsed.key) ? { key: parsed.key } : {}),
    ...(isPlanTimeSignature(parsed.timeSignature) ? { timeSignature: parsed.timeSignature } : {}),
    measures: measures.map((measure, index) => ({ ...measure, measure: index + 1 }))
  };
}

function cleanPlanString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
}

function isPlanKey(value: unknown): value is { fifths: number } {
  return isRecord(value) && typeof value.fifths === "number" && Number.isFinite(value.fifths);
}

function isPlanTimeSignature(value: unknown): value is { beats: number; beatType: number } {
  return (
    isRecord(value) &&
    typeof value.beats === "number" &&
    Number.isFinite(value.beats) &&
    typeof value.beatType === "number" &&
    Number.isFinite(value.beatType)
  );
}

function isScoreOperation(value: unknown): value is ScoreOperation {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "create_score":
      return isRecord(value.params) && Array.isArray(value.params.measures);
    case "replace_measures":
      return hasRange(value) && isRecord(value.params) && Array.isArray(value.params.measures);
    case "copy_measure":
      return (
        typeof value.fromMeasure === "number" &&
        Number.isFinite(value.fromMeasure) &&
        typeof value.toMeasure === "number" &&
        Number.isFinite(value.toMeasure)
      );
    case "clear_staff_in_measure":
      return hasMeasureNumber(value) && typeof value.staff === "number" && Number.isFinite(value.staff);
    case "insert_note":
      return hasMeasureNumber(value) && isRecord(value.params) && hasBeatParams(value.params) && isPitch(value.params.pitch);
    case "insert_rest":
      return hasMeasureNumber(value) && isRecord(value.params) && hasBeatParams(value.params);
    case "insert_chord":
      return hasMeasureNumber(value) && isRecord(value.params) && hasBeatParams(value.params) && isPitchArray(value.params.pitches);
    case "set_harmony":
      return hasMeasureNumber(value) && isRecord(value.params) && typeof value.params.startBeat === "number" && Number.isFinite(value.params.startBeat);
    case "set_tempo":
      return hasMeasureNumber(value) && isRecord(value.params) && typeof value.params.startBeat === "number" && Number.isFinite(value.params.startBeat);
    case "set_dynamic":
      return hasMeasureNumber(value) && isRecord(value.params) && typeof value.params.startBeat === "number" && Number.isFinite(value.params.startBeat);
    case "rewrite_phrase":
      return hasRange(value) && isRecord(value.params) && ["simpler", "more_motion", "block_chords", "arpeggio"].includes(String(value.params.strategy));
    case "transpose":
      return isRecord(value.params) && typeof value.params.targetKey === "string";
    case "simplify_left_hand":
      return hasRange(value) && isRecord(value.params) && ["root_notes", "root_and_fifth", "block_chords"].includes(String(value.params.strategy));
    case "update_note":
      return typeof value.noteId === "string" && isRecord(value.params);
    case "delete_note":
      return typeof value.noteId === "string";
    default:
      return false;
  }
}

function hasRange(value: Record<string, unknown>) {
  return (
    isRecord(value.range) &&
    typeof value.range.fromMeasure === "number" &&
    Number.isFinite(value.range.fromMeasure) &&
    typeof value.range.toMeasure === "number" &&
    Number.isFinite(value.range.toMeasure)
  );
}

function hasMeasureNumber(value: Record<string, unknown>) {
  return typeof value.measureNumber === "number" && Number.isFinite(value.measureNumber);
}

function hasBeatParams(value: Record<string, unknown>) {
  return (
    typeof value.startBeat === "number" &&
    Number.isFinite(value.startBeat) &&
    typeof value.durationBeats === "number" &&
    Number.isFinite(value.durationBeats) &&
    value.durationBeats > 0
  );
}

function isPitchArray(value: unknown): value is Pitch[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPitch);
}

function isPitch(value: unknown): value is Pitch {
  return (
    isRecord(value) &&
    ["A", "B", "C", "D", "E", "F", "G"].includes(String(value.step)) &&
    typeof value.octave === "number" &&
    Number.isFinite(value.octave) &&
    (value.alter === undefined || typeof value.alter === "number")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
