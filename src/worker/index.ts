import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { betterAuth } from "better-auth";
import { applyOperations, exportMusicXML, introducedBlockingValidationReason, parseMusicXML, validateScore } from "../shared";
import type { NoteEvent, Pitch, PlannerContext, PlannerHistoryMessage, Score, ScoreOperation, Selection } from "../shared";
import { hasLlmPlanner, classifyComposerIntent, planScoreEditWithModel, streamScoreOperationsWithModel } from "./llm";

type Bindings = {
  ASSETS?: Fetcher;
  DB?: D1Database;
  MUSICXML_BUCKET?: R2Bucket;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AI_DAILY_USER_LIMIT?: string | number;
  AI_DAILY_GLOBAL_LIMIT?: string | number;
};

type ProjectRecord = {
  id: string;
  user_id?: string | null;
  title?: string | null;
  r2_key?: string | null;
  musicxml_text?: string | null;
  created_at: string;
  updated_at: string;
};

type AuthSession = {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
  };
  session: {
    id: string;
    userId: string;
  };
};

const memory = {
  projects: new Map<string, ProjectRecord>(),
  messages: new Map<string, unknown>(),
  objects: new Map<string, string>()
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", async (c) => {
  if (!c.env.ASSETS) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  if (!c.env.DB) return c.json({ error: "Authentication requires D1." }, 503);
  return createAuth(c.env, c.req.raw).handler(c.req.raw);
});

app.post("/api/projects", async (c) => {
  const session = await requireSession(c);
  const { musicxml, title } = await readMusicXmlUpload(c.req.raw);
  try {
    parseMusicXML(musicxml);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
  const result = await createProjectFromMusicXml(c.env, musicxml, title, session.user.id);
  return c.json(result);
});

app.get("/api/projects", async (c) => {
  const session = await requireSession(c);
  return c.json({ projects: await listProjects(c.env, session.user.id) });
});

app.get("/api/bootstrap", async (c) => {
  const requestedProjectId = c.req.query("projectId");
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          const session = await currentSession(c);
          send({ type: "session", user: session?.user ?? null });
          if (!session) return;

          const projects = await listProjects(c.env, session.user.id);
          send({ type: "projects", projects });

          const selectedProject = selectInitialProject(projects, requestedProjectId);
          send({ type: "project", project: selectedProject ? await getProjectResponse(c.env, selectedProject) : null });
        } catch (error) {
          send({ type: "error", error: errorMessage(error) });
        } finally {
          send({ type: "done" });
          controller.close();
        }
      }
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
});

app.post("/api/agent/classify-intent", async (c) => {
  const session = await requireSession(c);
  const body = await readLimitedJson<{ message?: string; context?: { scoreTitle?: string; measureCount?: number } }>(c.req.raw);
  if (hasLlmPlanner(c.env)) await consumeAiQuota(c.env, session.user.id);
  const intent = await classifyComposerIntent(c.env, body?.message ?? "", body?.context);
  return c.json({ intent });
});

app.post("/api/projects/stream-generate", async (c) => {
  const session = await requireSession(c);
  const body = await readLimitedJson<{ prompt?: string; context?: PlannerContext; history?: PlannerHistoryMessage[] }>(c.req.raw);
  const prompt = body?.prompt?.trim() || "Create a short beginner piano phrase";
  if (hasLlmPlanner(c.env)) await consumeAiQuota(c.env, session.user.id);
  const title = titleFromPrompt(prompt);
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const sendChunk = (chunk: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        };

        if (hasLlmPlanner(c.env)) {
          let streamedScore = generatedScore(title, []);
          let hasStreamedScore = false;
          const generationPrompt = prompt;

          sendChunk({
            done: false,
            assistantText: "Sketching the shape of the piece..."
          });

          sendChunk({ done: false, assistantText: "Putting notes on the page..." });

          let assistantText = "Your sheet is ready.";
          try {
            const plan = await streamScoreOperationsWithModel(
              c.env,
              {
                message: generationPrompt,
                context: body?.context,
                history: body?.history
              },
              (chunk) => {
                if (!chunk.operation) return;
                streamedScore = applyOperations(streamedScore, [normalizeStreamOperation(chunk.operation, currentTimeSignature(streamedScore))]);
                const validation = validateScore(streamedScore);
                hasStreamedScore = hasRenderableEvents(streamedScore) && validation.valid;
                sendChunk({
                  done: false,
                  assistantText: chunk.assistantText ?? "Still writing...",
                  musicxml: exportMusicXML(streamedScore),
                  score: streamedScore,
                  validation
                });
              }
            );
            assistantText = plan.assistantText;
          } catch (error) {
            assistantText = `The model stream stopped early, so I saved the valid score generated so far. ${errorMessage(error)}`;
          }

          const finalScore = hasStreamedScore ? streamedScore : generatedScore(title, generatedEvents());
          if (!hasStreamedScore) {
            assistantText = `${assistantText} I could not stream a valid generated score, so I used the local starter phrase.`;
          }
          const result = await createProjectFromMusicXml(c.env, exportMusicXML(finalScore), finalScore.title ?? title, session.user.id);
          sendChunk({
            done: true,
            assistantText,
            ...result
          });
          controller.close();
          return;
        }

        const events = generatedEvents();
        for (let index = 1; index <= events.length; index++) {
          const score = generatedScore(title, events.slice(0, index));
          sendChunk({
            done: false,
            assistantText: `Placing note ${index} of ${events.length}...`,
            musicxml: exportMusicXML(score),
            score,
            validation: validateScore(score)
          });
          await sleep(350);
        }

        const finalScore = generatedScore(title, events);
        const result = await createProjectFromMusicXml(c.env, exportMusicXML(finalScore), title, session.user.id);
        sendChunk({
          done: true,
          assistantText: "Your sheet is ready.",
          ...result
        });
        controller.close();
      }
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache"
      }
    }
  );
});

async function createProjectFromMusicXml(env: Bindings, musicxml: string, title?: string, userId?: string) {
  const score = parseMusicXML(musicxml);
  const normalizedMusicXml = exportMusicXML(score);
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();
  const r2Key = projectR2Key(projectId);

  await putObject(env, r2Key, normalizedMusicXml);
  await insertProject(env, {
    id: projectId,
    user_id: userId ?? null,
    title: title ?? score.title ?? "Untitled score",
    r2_key: r2Key,
    musicxml_text: normalizedMusicXml,
    created_at: now,
    updated_at: now
  });

  return {
    project: projectSummary(await getProject(env, projectId)),
    musicxml: normalizedMusicXml,
    score: parseMusicXML(normalizedMusicXml),
    validation: validateScore(score)
  };
}

function projectSummary(project: ProjectRecord | undefined) {
  if (!project) throw new Error("Project not found after write.");
  const { musicxml_text: _musicxmlText, ...summary } = project;
  return summary;
}

async function getProjectResponse(env: Bindings, project: ProjectRecord) {
  const musicxml = await getProjectMusicXml(env, project);
  const score = parseMusicXML(musicxml);
  return { project: projectSummary(project), musicxml, score, validation: validateScore(score) };
}

function selectInitialProject(projects: ProjectRecord[], requestedProjectId?: string): ProjectRecord | undefined {
  const latestProject = projects[0];
  const requestedProject = requestedProjectId ? projects.find((project) => project.id === requestedProjectId) : undefined;
  if (latestProject && (!requestedProject || latestProject.updated_at > requestedProject.updated_at)) return latestProject;
  return requestedProject ?? latestProject;
}

app.get("/api/projects/:projectId", async (c) => {
  const session = await requireSession(c);
  const project = await requireOwnedProject(c.env, c.req.param("projectId"), session.user.id);
  if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json(await getProjectResponse(c.env, project));
});

app.patch("/api/projects/:projectId", async (c) => {
  const session = await requireSession(c);
  const body = await readLimitedJson<{ title?: string }>(c.req.raw, 8 * 1024) ?? {};
  const title = body.title?.trim();
  if (!title) return c.json({ error: "Title is required" }, 400);

  const project = await requireOwnedProject(c.env, c.req.param("projectId"), session.user.id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  await updateProjectTitle(c.env, project.id, title);
  return c.json({ project: projectSummary(await getProject(c.env, project.id)) });
});

app.delete("/api/projects/:projectId", async (c) => {
  const session = await requireSession(c);
  const projectId = c.req.param("projectId");
  const project = await requireOwnedProject(c.env, projectId, session.user.id);
  if (!project) return c.json({ error: "Project not found" }, 404);
  await deleteProject(c.env, projectId);
  return c.json({ ok: true });
});

app.post("/api/projects/:projectId/agent/edit", async (c) => {
  const session = await requireSession(c);
  const body = await readLimitedJson<{ message?: string; selection?: Selection; context?: PlannerContext; history?: PlannerHistoryMessage[] }>(c.req.raw) ?? {};
  const project = await requireOwnedProjectOrThrow(c.env, c.req.param("projectId"), session.user.id);
  if (hasLlmPlanner(c.env)) await consumeAiQuota(c.env, session.user.id);
  const score = parseMusicXML(await getProjectMusicXml(c.env, project));
  const editIntent = editIntentFromMessage(score, body.message ?? "");
  const plan = await planScoreEditWithModel(
    c.env,
    {
      message: body.message ?? "",
      selection: body.selection,
      context: body.context,
      history: body.history
    },
    score
  );
  const operations = prepareEditOperations(score, plan.operations, body.message ?? "", editIntent, body.selection, body.context);
  const result = await updateProjectFromOperations(c.env, project, score, operations);
  const assistantText =
    operations.length > 0 ? "Done. I updated the score." : "I could not apply that edit because the generated operation did not produce a valid score change.";

  await insertAgentMessage(c.env, {
    id: crypto.randomUUID(),
    project_id: project.id,
    role: "user",
    content: body.message ?? "",
    selection_json: JSON.stringify(body.selection ?? null),
    operations_json: JSON.stringify(operations),
    created_at: new Date().toISOString()
  });

  return c.json({ ...result, operations, assistantText });
});

app.post("/api/projects/:projectId/agent/stream-edit", async (c) => {
  const session = await requireSession(c);
  const body = await readLimitedJson<{ message?: string; selection?: Selection; context?: PlannerContext; history?: PlannerHistoryMessage[] }>(c.req.raw);
  const project = await requireOwnedProjectOrThrow(c.env, c.req.param("projectId"), session.user.id);
  if (hasLlmPlanner(c.env)) await consumeAiQuota(c.env, session.user.id);
  const currentMusicxml = await getProjectMusicXml(c.env, project);
  const score = parseMusicXML(currentMusicxml);
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const sendChunk = (chunk: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        };

        try {
          let streamedScore = score;
          const operations: ScoreOperation[] = [];
          let rejectedReason: string | undefined;
          const editIntent = editIntentFromMessage(score, body?.message ?? "");

          sendChunk({
            done: false,
            assistantText: "Reading the phrase..."
          });

          const plan = await streamScoreOperationsWithModel(
            c.env,
            {
              message: body?.message ?? "",
              selection: body?.selection,
              context: body?.context,
              history: body?.history
            },
            (chunk) => {
              if (!chunk.operation) return;
              if (!isAllowedStreamingEditOperation(streamedScore, chunk.operation, editIntent)) {
                rejectedReason = blockedOperationReason(streamedScore, chunk.operation, editIntent);
                return;
              }
              const operation = prepareEditOperation(streamedScore, chunk.operation, body?.message ?? "", body?.selection, body?.context);
              const operationBlockedReason = blockingOperationReason(streamedScore, operation);
              if (operationBlockedReason) {
                rejectedReason = operationBlockedReason;
                return;
              }
              const nextScore = applyOperations(streamedScore, [operation]);
              if (sameScore(streamedScore, nextScore)) {
                rejectedReason = unresolvedNoteOperationReason(streamedScore, operation);
                return;
              }
              const validation = validateScore(nextScore);
              const blockedReason = introducedBlockingValidationReason(validateScore(streamedScore), validation);
              if (blockedReason) {
                rejectedReason = blockedReason;
                return;
              }
              operations.push(operation);
              streamedScore = nextScore;
              sendChunk({
                done: false,
                assistantText: chunk.assistantText ?? "Making the change...",
                musicxml: exportMusicXML(streamedScore),
                score: streamedScore,
                validation,
                operations
              });
            },
            score,
            "edit"
          );

          if (operations.length === 0 && plan.operations.length > 0) {
            for (const rawOperation of plan.operations) {
              if (!isAllowedStreamingEditOperation(streamedScore, rawOperation, editIntent)) {
                rejectedReason = blockedOperationReason(streamedScore, rawOperation, editIntent);
                continue;
              }
              const operation = prepareEditOperation(streamedScore, rawOperation, body?.message ?? "", body?.selection, body?.context);
              const operationBlockedReason = blockingOperationReason(streamedScore, operation);
              if (operationBlockedReason) {
                rejectedReason = operationBlockedReason;
                continue;
              }
              const nextScore = applyOperations(streamedScore, [operation]);
              if (sameScore(streamedScore, nextScore)) {
                rejectedReason = unresolvedNoteOperationReason(streamedScore, operation);
                continue;
              }
              const validation = validateScore(nextScore);
              const blockedReason = introducedBlockingValidationReason(validateScore(streamedScore), validation);
              if (blockedReason) {
                rejectedReason = blockedReason;
                continue;
              }
              operations.push(operation);
              streamedScore = nextScore;
            }
            if (operations.length > 0) {
              sendChunk({
                done: false,
                assistantText: plan.assistantText,
                musicxml: exportMusicXML(streamedScore),
                score: streamedScore,
                validation: validateScore(streamedScore),
                operations
              });
            }
          }

          const editSucceeded = operations.length > 0;
          const assistantText = editSucceeded
            ? "Done. I updated the score."
            : rejectedReason ?? "I could not apply that edit because the generated operation did not match any editable score item.";
          const finalResult = editSucceeded
            ? await updateProjectFromScore(c.env, project, streamedScore)
            : { project: projectSummary(project), musicxml: currentMusicxml, score, validation: validateScore(score) };
          const appliedOperations = editSucceeded ? operations : [];
          await insertAgentMessage(c.env, {
            id: crypto.randomUUID(),
            project_id: project.id,
            role: "user",
            content: body?.message ?? "",
            selection_json: JSON.stringify(body?.selection ?? null),
            operations_json: JSON.stringify(appliedOperations),
            created_at: new Date().toISOString()
          });

          sendChunk({
            done: true,
            assistantText,
            operations: appliedOperations,
            ...finalResult
          });
        } catch (error) {
          sendChunk({ done: false, error: errorMessage(error) });
        } finally {
          controller.close();
        }
      }
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache"
      }
    }
  );
});

app.post("/api/projects/:projectId/operations", async (c) => {
  const session = await requireSession(c);
  const body = await readLimitedJson<{ operations?: ScoreOperation[]; musicxml?: string; expectedR2Key?: string }>(c.req.raw, MAX_SCORE_BODY_BYTES) ?? {};
  const project = await requireOwnedProjectOrThrow(c.env, c.req.param("projectId"), session.user.id);
  const score = parseMusicXML(await getProjectMusicXml(c.env, project));
  let result: Awaited<ReturnType<typeof updateProjectFromOperations>>;
  try {
    if (body.musicxml !== undefined) {
      if (!body.expectedR2Key || body.expectedR2Key !== project.r2_key) {
        throw new HTTPException(409, { message: "The score changed in another request. Reload it before editing again." });
      }
      const candidate = parseMusicXML(body.musicxml);
      const blockedReason = introducedBlockingValidationReason(validateScore(score), validateScore(candidate));
      if (blockedReason) throw new Error(blockedReason);
      result = await updateProjectFromScore(c.env, project, candidate);
    } else {
      result = await updateProjectFromOperations(c.env, project, score, body.operations ?? []);
    }
  } catch (error) {
    return c.json({ error: errorMessage(error) }, error instanceof HTTPException ? error.status : 400);
  }
  return c.json({ ...result, operations: body.operations ?? [] });
});

app.get("*", async (c) => {
  if (!c.env.ASSETS) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

async function updateProjectFromOperations(env: Bindings, project: ProjectRecord, score: ReturnType<typeof parseMusicXML>, operations: ScoreOperation[]) {
  let nextScore = score;
  for (const operation of operations) {
    const candidate = applyOperations(nextScore, [operation]);
    const blockedReason = introducedBlockingValidationReason(validateScore(nextScore), validateScore(candidate));
    if (blockedReason) throw new Error(blockedReason);
    nextScore = candidate;
  }
  return updateProjectFromScore(env, project, nextScore);
}

async function updateProjectFromScore(env: Bindings, project: ProjectRecord, nextScore: Score) {
  const validation = validateScore(nextScore);
  const musicxml = exportMusicXML(nextScore);
  const previousR2Key = projectMusicXmlKey(project);
  const r2Key = projectUpdatedMusicXmlKey(project.id);
  await putObject(env, r2Key, musicxml);
  try {
    await updateProjectStorage(env, project.id, r2Key, musicxml, previousR2Key);
  } catch (error) {
    await deleteObject(env, r2Key).catch(() => undefined);
    throw error;
  }
  if (previousR2Key !== r2Key) {
    await deleteObject(env, previousR2Key).catch(() => undefined);
  }
  return { project: { ...projectSummary(await getProject(env, project.id)), r2_key: r2Key }, musicxml, score: parseMusicXML(musicxml), validation };
}

function hasRenderableEvents(score: Score): boolean {
  return score.parts.some((part) => part.measures.some((measure) => measure.events.some((event) => event.pitches.length > 0)));
}

function normalizeStreamOperation(operation: ScoreOperation, fallbackTimeSignature?: { beats: number; beatType: number }): ScoreOperation {
  const next = structuredClone(operation);
  if (next.type === "create_score") {
    next.params.measures = next.params.measures.map((measure) => normalizeMeasureInput(measure, next.params.timeSignature));
  }
  if (next.type === "replace_measures") {
    next.params.measures = next.params.measures.map((measure) => normalizeMeasureInput(measure, fallbackTimeSignature));
  }
  return next;
}

function currentTimeSignature(score: Score): { beats: number; beatType: number } | undefined {
  return score.parts[0]?.measures.at(-1)?.timeSignature;
}

function timeSignatureForOperation(score: Score, operation: ScoreOperation): { beats: number; beatType: number } | undefined {
  if (operation.type === "replace_measures") {
    return score.parts[0]?.measures.find((measure) => measure.number === operation.range.fromMeasure)?.timeSignature ?? currentTimeSignature(score);
  }
  return currentTimeSignature(score);
}

function prepareEditOperations(
  score: Score,
  rawOperations: ScoreOperation[],
  message: string,
  editIntent: EditIntent,
  selection?: Selection,
  context?: PlannerContext
): ScoreOperation[] {
  let currentScore = score;
  const operations: ScoreOperation[] = [];
  const usedSelectedIds = new Set<string>();

  for (const rawOperation of rawOperations) {
    if (!isAllowedStreamingEditOperation(currentScore, rawOperation, editIntent)) continue;
    const operation = prepareEditOperation(currentScore, rawOperation, message, selection, context, usedSelectedIds);
    if (blockingOperationReason(currentScore, operation)) continue;
    const nextScore = applyOperations(currentScore, [operation]);
    if (introducedBlockingValidationReason(validateScore(currentScore), validateScore(nextScore))) continue;
    if (sameScore(currentScore, nextScore)) continue;
    operations.push(operation);
    currentScore = nextScore;
  }

  return operations;
}

function prepareEditOperation(
  score: Score,
  operation: ScoreOperation,
  message: string,
  selection?: Selection,
  context?: PlannerContext,
  usedSelectedIds: Set<string> = new Set()
): ScoreOperation {
  const normalized = normalizeStreamOperation(operation, timeSignatureForOperation(score, operation));
  const withStaff = normalizeAmbiguousDynamicEdit(preserveUntouchedStaffForClefEdit(score, normalized, message), message);
  return resolveNoteTarget(score, withStaff, selection, context, usedSelectedIds);
}

function normalizeAmbiguousDynamicEdit(operation: ScoreOperation, message: string): ScoreOperation {
  if (operation.type !== "set_dynamic") return operation;
  if (/(both|both staves|all staves|staffs|staves|两个谱表|两行|左右手|双手|全部谱表)/i.test(message)) return operation;
  if (operation.params.staff === 2 && !targetStaffFromMessage(message)) {
    return { ...operation, params: { ...operation.params, staff: 1 } };
  }
  return operation;
}

function blockingOperationReason(score: Score, operation: ScoreOperation): string | undefined {
  return invalidTieUpdateReason(score, operation);
}

function invalidTieUpdateReason(score: Score, operation: ScoreOperation): string | undefined {
  if (operation.type !== "update_note" || operation.params.tie === undefined || operation.params.tie === null) return undefined;
  if (!isPhraseMark(operation.params.tie)) return "I could not apply that tie because the tie mark is invalid.";

  const position = notePosition(score, operation.noteId);
  if (!position || position.event.pitches.length === 0) return "I could not apply that tie because it does not target a pitched note.";

  const needsPrevious = operation.params.tie === "stop" || operation.params.tie === "continue";
  const needsNext = operation.params.tie === "start" || operation.params.tie === "continue";
  if (needsPrevious && !adjacentTiePartner(score, position, "previous")) {
    return "I could not apply that tie because the target note has no adjacent previous note with the same pitch.";
  }
  if (needsNext && !adjacentTiePartner(score, position, "next")) {
    return "I could not apply that tie because the target note has no adjacent next note with the same pitch.";
  }
  return undefined;
}

type PositionedNoteEvent = {
  event: NoteEvent;
  partId: string;
  absoluteStartBeat: number;
  absoluteEndBeat: number;
};

function notePosition(score: Score, noteId: string): PositionedNoteEvent | undefined {
  for (const part of score.parts) {
    let measureOffset = 0;
    for (const measure of [...part.measures].sort((a, b) => a.number - b.number)) {
      for (const event of measure.events) {
        const position = {
          event,
          partId: part.id,
          absoluteStartBeat: measureOffset + event.startBeat,
          absoluteEndBeat: measureOffset + event.startBeat + event.durationBeats
        };
        if (event.id === noteId) return position;
      }
      measureOffset += measureDurationBeats(measure);
    }
  }
  return undefined;
}

function adjacentTiePartner(score: Score, target: PositionedNoteEvent, direction: "previous" | "next"): PositionedNoteEvent | undefined {
  for (const candidate of positionedEvents(score, target.partId)) {
    if (candidate.event.id === target.event.id || candidate.event.pitches.length === 0) continue;
    if (eventStaff(candidate.event) !== eventStaff(target.event)) continue;
    if (eventVoice(candidate.event) !== eventVoice(target.event)) continue;
    if (!samePitchSet(candidate.event, target.event)) continue;
    if (direction === "previous" && nearBeat(candidate.absoluteEndBeat, target.absoluteStartBeat)) return candidate;
    if (direction === "next" && nearBeat(candidate.absoluteStartBeat, target.absoluteEndBeat)) return candidate;
  }
  return undefined;
}

function positionedEvents(score: Score, partId: string): PositionedNoteEvent[] {
  const part = score.parts.find((candidate) => candidate.id === partId);
  if (!part) return [];

  const result: PositionedNoteEvent[] = [];
  let measureOffset = 0;
  for (const measure of [...part.measures].sort((a, b) => a.number - b.number)) {
    for (const event of measure.events) {
      result.push({
        event,
        partId,
        absoluteStartBeat: measureOffset + event.startBeat,
        absoluteEndBeat: measureOffset + event.startBeat + event.durationBeats
      });
    }
    measureOffset += measureDurationBeats(measure);
  }
  return result;
}

function measureDurationBeats(measure: Score["parts"][number]["measures"][number]): number {
  return measure.durationBeats ?? measure.timeSignature.beats * (4 / measure.timeSignature.beatType);
}

function eventVoice(event: { staff?: number; voice?: number; pitches?: Array<{ step: string; alter?: number; octave: number }> }): number {
  return event.voice ?? eventStaff(event);
}

function samePitchSet(left: NoteEvent, right: NoteEvent): boolean {
  if (left.pitches.length !== right.pitches.length) return false;
  const leftKeys = left.pitches.map(pitchKey).sort();
  const rightKeys = right.pitches.map(pitchKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function pitchKey(pitch: { step: string; alter?: number; octave: number }): string {
  return `${pitch.step}:${pitch.alter ?? 0}:${pitch.octave}`;
}

function nearBeat(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.001;
}

function preserveUntouchedStaffForClefEdit(score: Score, operation: ScoreOperation, message: string): ScoreOperation {
  const targetStaff = targetStaffFromMessage(message);
  if (operation.type !== "replace_measures" || !targetStaff) return operation;
  if (/(both|both staves|all staves|staffs|staves|两个谱表|两行|左右手|双手|全部谱表)/i.test(message)) return operation;
  const targetVoice = targetVoiceFromMessage(message);
  const part = score.parts.find((candidate) => candidate.id === operation.partId) ?? score.parts[0];
  if (!part) return operation;

  const next = structuredClone(operation);
  next.params.measures = next.params.measures.map((measure, index) => {
    const measureNumber = measure.number ?? next.range.fromMeasure + index;
    const existingMeasure = part.measures.find((candidate) => candidate.number === measureNumber);
    if (!existingMeasure) return measure;

    const targetEvents = measure.events
      .filter((event) => eventStaff(event) === targetStaff && (targetVoice === undefined || eventVoice(event) === targetVoice))
      .map((event) => ({ ...event, staff: targetStaff, ...(targetVoice ? { voice: targetVoice } : {}) }));
    const untouchedEvents = existingMeasure.events
      .filter((event) => eventStaff(event) !== targetStaff || (targetVoice !== undefined && eventVoice(event) !== targetVoice))
      .map(noteEventToInput);
    if (targetEvents.length === 0 && measure.events.length > 0) {
      return { ...measure, number: measureNumber, events: existingMeasure.events.map(noteEventToInput) };
    }

    return {
      ...measure,
      number: measureNumber,
      harmonies: measure.harmonies ?? existingMeasure.harmonies,
      tempos: measure.tempos ?? existingMeasure.tempos,
      dynamics: measure.dynamics ?? existingMeasure.dynamics,
      events: [...untouchedEvents, ...targetEvents].sort(
        (a, b) => (a.staff ?? 1) - (b.staff ?? 1) || (a.voice ?? 1) - (b.voice ?? 1) || a.startBeat - b.startBeat
      )
    };
  });

  return next;
}

function targetStaffFromMessage(message: string): 1 | 2 | undefined {
  const wantsStaff1 = /\b(g\s*cle[fp]|treble cle[fp]|right hand|right-hand|staff\s*1|rh)\b|高音谱|高音谱号|右手|G谱/i.test(message);
  const wantsStaff2 = /\b(f\s*cle[fp]|bass cle[fp]|left hand|left-hand|staff\s*2|lh)\b|低音谱|低音谱号|左手|F谱/i.test(message);
  if (wantsStaff1 === wantsStaff2) return undefined;
  return wantsStaff1 ? 1 : 2;
}

function targetVoiceFromMessage(message: string): number | undefined {
  const match =
    message.match(/\bvoice\s*(one|two|three|four|[1-4])\b/i) ??
    message.match(/\b(v)\s*([1-4])\b/i) ??
    message.match(/第([一二三四1-4])个?(?:音部|声部|voice)/i);
  const value = match?.[2] ?? match?.[1];
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "one" || normalized === "一") return 1;
  if (normalized === "two" || normalized === "二") return 2;
  if (normalized === "three" || normalized === "三") return 3;
  if (normalized === "four" || normalized === "四") return 4;
  const numeric = Number(normalized);
  return numeric >= 1 && numeric <= 4 ? numeric : undefined;
}

function eventStaff(event: { staff?: number; voice?: number; pitches?: Array<{ step: string; alter?: number; octave: number }> }): number {
  return event.staff ?? inferStaff(event.voice, event.pitches);
}

function noteEventToInput(event: NoteEvent) {
  return {
    startBeat: event.startBeat,
    durationBeats: event.durationBeats,
    pitches: event.pitches,
    ...(event.staff ? { staff: event.staff } : {}),
    ...(event.voice ? { voice: event.voice } : {}),
    ...(event.tie ? { tie: event.tie } : {}),
    ...(event.slur ? { slur: event.slur } : {}),
    ...(event.beam ? { beam: event.beam } : {})
  };
}

function isStreamingEditOperation(operation: ScoreOperation): boolean {
  return [
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
  ].includes(operation.type);
}

type EditIntent = {
  action: "delete" | "notation" | "add_measure" | "replace_measure" | "localized" | "unknown";
  targetMeasureNumbers: Set<number>;
  referencedMeasureNumbers: Set<number>;
  targetStaff?: 1 | 2;
};

function editIntentFromMessage(score: Score, message: string): EditIntent {
  const targetStaff = targetStaffFromMessage(message);
  const referencedMeasureNumbers = explicitMeasureNumbers(score, message);
  const targetMeasureNumbers = explicitTargetMeasureNumbers(score, message);
  const action = editActionFromMessage(message);

  return {
    action,
    targetMeasureNumbers,
    referencedMeasureNumbers,
    ...(targetStaff ? { targetStaff } : {})
  };
}

function isAllowedStreamingEditOperation(score: Score, operation: ScoreOperation, intent: EditIntent): boolean {
  if (!isStreamingEditOperation(operation)) return false;
  if (operation.type === "update_note" && isNotationOnlyUpdate(operation) && intent.action !== "notation") return false;
  if (operation.type === "replace_measures" && intent.action === "notation") return false;
  if (operation.type === "copy_measure") return copyMeasureOperationMatchesIntent(score, operation, intent);
  if (operation.type === "clear_staff_in_measure") return clearStaffOperationMatchesIntent(operation, intent);
  if (operation.type !== "replace_measures") return true;
  return replaceMeasureOperationMatchesIntent(score, operation, intent);
}

function isNotationOnlyUpdate(operation: Extract<ScoreOperation, { type: "update_note" }>): boolean {
  const keys = Object.keys(operation.params);
  return keys.length > 0 && keys.every((key) => key === "beam" || key === "tie" || key === "slur");
}

function blockedOperationReason(score: Score, operation: ScoreOperation, intent: EditIntent): string | undefined {
  if (isAllowedStreamingEditOperation(score, operation, intent)) return undefined;
  if (operation.type === "update_note" && isNotationOnlyUpdate(operation) && intent.action !== "notation") {
    return "I could not apply that edit because the generated operation only changed beaming, ties, or slurs, but the request did not ask for notation marks.";
  }
  if (operation.type === "replace_measures" && intent.action === "notation") {
    return "I could not apply that edit because beam, tie, and slur changes must use update_note on the selected note ids, not replace_measures.";
  }
  if (operation.type === "replace_measures") {
    return "I could not apply that edit because the generated measure rewrite did not match the requested edit scope.";
  }
  if (operation.type === "copy_measure") {
    return "I could not apply that edit because the generated measure copy did not match the requested source or target measure.";
  }
  if (operation.type === "clear_staff_in_measure") {
    return "I could not apply that edit because the generated staff clear did not match the requested measure or staff.";
  }
  return "I could not apply that edit because the generated operation type is not allowed for this request.";
}

function unresolvedNoteOperationReason(score: Score, operation: ScoreOperation): string {
  if (operation.type === "update_note" || operation.type === "delete_note") {
    const event = findNoteById(score, operation.noteId);
    if (!event) {
      return `I could not apply that edit because note id "${operation.noteId}" was not found in the score.`;
    }
    if (operation.type === "update_note" && operation.params.beam !== undefined) {
      return `I could not apply that beam edit because note "${operation.noteId}" already has that beam setting. The selected notes may be the wrong combination and cannot form one beat for beaming.`;
    }
    return `I could not apply that edit because the generated update for "${operation.noteId}" did not change the score.`;
  }
  if (operation.type === "set_harmony") {
    return "I could not apply that harmony edit because the target measure already has that harmony at that beat.";
  }
  return "I could not apply that edit because the generated operation did not match any editable score item.";
}

function findNoteById(score: Score, noteId: string): NoteEvent | undefined {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      const event = measure.events.find((candidate) => candidate.id === noteId);
      if (event) return event;
    }
  }
  return undefined;
}

function pitchesEqual(left: Pitch, right: Pitch): boolean {
  return left.step === right.step && left.octave === right.octave && (left.alter ?? 0) === (right.alter ?? 0);
}

function resolveNoteTarget(
  score: Score,
  operation: ScoreOperation,
  selection?: Selection,
  context?: PlannerContext,
  usedSelectedIds: Set<string> = new Set()
): ScoreOperation {
  if (operation.type !== "update_note" && operation.type !== "delete_note") return operation;
  if (findNoteById(score, operation.noteId)) return operation;

  const selectedNotes = context?.selectedNotes ?? [];
  const selectedIds = (selection?.noteIds ?? selectedNotes.map((note) => note.id)).filter((id) => !usedSelectedIds.has(id));

  if (operation.type === "update_note") {
    const matched = selectedNotes.find(
      (note) =>
        !usedSelectedIds.has(note.id) &&
        findNoteById(score, note.id) &&
        (operation.params.startBeat === undefined || nearBeat(note.startBeat, operation.params.startBeat)) &&
        (operation.params.pitch === undefined || note.pitches.some((pitch) => pitchesEqual(pitch, operation.params.pitch!))) &&
        (operation.params.pitches === undefined ||
          operation.params.pitches.every((pitch) => note.pitches.some((candidate) => pitchesEqual(candidate, pitch))))
    );
    if (matched) {
      usedSelectedIds.add(matched.id);
      return { ...operation, noteId: matched.id };
    }
  }

  if (selectedIds.length === 1 && findNoteById(score, selectedIds[0])) {
    usedSelectedIds.add(selectedIds[0]);
    return { ...operation, noteId: selectedIds[0] };
  }

  const hinted = resolveNoteIdFromHint(score, operation.noteId);
  if (hinted) return { ...operation, noteId: hinted };

  return operation;
}

function resolveNoteIdFromHint(score: Score, noteId: string): string | undefined {
  const match = noteId.match(/^n_(?:P\d+_)?(\d+)_(\d+)(?:_|$)/);
  if (!match) return undefined;

  const measureNumber = Number(match[1]);
  const eventIndex = Number(match[2]);
  if (!Number.isInteger(measureNumber) || !Number.isInteger(eventIndex)) return undefined;

  const measure = score.parts[0]?.measures.find((candidate) => candidate.number === measureNumber);
  if (!measure) return undefined;

  const ordered = [...measure.events].sort(
    (left, right) =>
      (left.staff ?? 1) - (right.staff ?? 1) ||
      (left.voice ?? 1) - (right.voice ?? 1) ||
      left.startBeat - right.startBeat ||
      left.durationBeats - right.durationBeats
  );

  return ordered[eventIndex]?.id;
}

function editActionFromMessage(message: string): EditIntent["action"] {
  const asksForMeasure = hasMeasureTerm(message);
  const asksForNotation = /\b(un[-\s]?beam(?:ed|ing|s)?|beam|beams|beaming|tie|ties|slur|slurs)\b|符杠|连音|连线/i.test(message);
  const asksToDelete = /\b(delete|remove|clear)\b|删除|删掉|清空|去掉/i.test(message);
  const asksToAddMeasure =
    /\b(add|insert|append|create)\b.{0,24}\b(measure|bar)\b|\b(measure|bar)\b.{0,24}\b(add|insert|append|create)\b/i.test(message) ||
    /(?:再?加|新加|新增|添加|增加|插入|追加).{0,12}(?:小?节|一小?节|節|measure|bar)|(?:小?节|一小?节|節).{0,12}(?:再?加|新加|新增|添加|增加|插入|追加)/i.test(message);
  const asksToReplaceMeasure =
    /(replace|rewrite|redo|change).{0,24}(measure|bar)|(?:measure|bar).{0,24}(replace|rewrite|redo|change|to)/i.test(message) ||
    /重写.{0,12}(?:小?节|節|整小?节|整節)|替换.{0,12}(?:小?节|節|整小?节|整節)|(整个|整段|整小?节|整節).{0,12}(?:改|换|重写|替换)|(?:第?[一二三四五六七八九十\d]+个?)?(?:小?节|節).{0,16}(?:改成|改为|换成|变成)/i.test(message);

  if (asksForNotation && !asksToReplaceMeasure) return "notation";
  if (asksToDelete) return "delete";
  if (asksToAddMeasure) return "add_measure";
  if (asksToReplaceMeasure) return "replace_measure";
  if (/后面|前面|这个音|这些音|selected|selection|this note|these notes/i.test(message)) return "localized";
  if (asksForMeasure) return "replace_measure";
  return "unknown";
}

function replaceMeasureOperationMatchesIntent(score: Score, operation: Extract<ScoreOperation, { type: "replace_measures" }>, intent: EditIntent): boolean {
  if (intent.action === "delete" || intent.action === "notation" || intent.action === "localized") return false;

  const targetNumbers = measureRangeNumbers(operation.range.fromMeasure, operation.range.toMeasure);
  if (!targetNumbers.length) return false;

  if (intent.action === "add_measure") {
    const allowedTargets = intent.targetMeasureNumbers.size ? intent.targetMeasureNumbers : measuresAfterLast(score, targetNumbers);
    return targetNumbers.every((measureNumber) => allowedTargets.has(measureNumber));
  }

  if (intent.action === "replace_measure") {
    const allowedTargets = intent.targetMeasureNumbers.size ? intent.targetMeasureNumbers : intent.referencedMeasureNumbers;
    if (allowedTargets.size === 0) return intent.targetStaff !== undefined;
    return targetNumbers.every((measureNumber) => allowedTargets.has(measureNumber));
  }

  return intent.targetStaff !== undefined && targetNumbers.every((measureNumber) => intent.referencedMeasureNumbers.has(measureNumber));
}

function copyMeasureOperationMatchesIntent(score: Score, operation: Extract<ScoreOperation, { type: "copy_measure" }>, intent: EditIntent): boolean {
  if (intent.action !== "add_measure" && intent.action !== "replace_measure") return false;
  if (intent.referencedMeasureNumbers.size > 0 && !intent.referencedMeasureNumbers.has(operation.fromMeasure)) return false;
  if (intent.targetMeasureNumbers.size > 0) return intent.targetMeasureNumbers.has(operation.toMeasure);
  return operation.toMeasure > (score.parts[0]?.measures.at(-1)?.number ?? 0);
}

function clearStaffOperationMatchesIntent(operation: Extract<ScoreOperation, { type: "clear_staff_in_measure" }>, intent: EditIntent): boolean {
  if (intent.action !== "delete") return false;
  if (intent.targetStaff !== undefined && operation.staff !== intent.targetStaff) return false;
  return intent.referencedMeasureNumbers.size === 0 || intent.referencedMeasureNumbers.has(operation.measureNumber);
}

function hasMeasureTerm(message: string): boolean {
  return /\b(measure|bar|m\.?)\b|小?节|節/i.test(message);
}

function explicitMeasureNumbers(score: Score, message: string): Set<number> {
  const numbers = new Set<number>();
  const patterns = [/(?:measure|bar|m\.?)\s*(\d+)/gi, /第?\s*([一二三四五六七八九十\d]+)\s*(?:小?节|節)/g];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const number = parseMeasureNumber(match[1]);
      if (Number.isInteger(number) && number > 0) numbers.add(number);
    }
  }
  if (referencesLastMeasure(message)) {
    const lastMeasureNumber = score.parts[0]?.measures.at(-1)?.number;
    if (lastMeasureNumber !== undefined) numbers.add(lastMeasureNumber);
  }
  return numbers;
}

function explicitTargetMeasureNumbers(score: Score, message: string): Set<number> {
  const numbers = new Set<number>();
  const patterns = [
    /(?:add|insert|append|create)\s+(?:measure|bar|m\.?)\s*(\d+)/gi,
    /copy\s+(?:measure|bar|m\.?)\s*(\d+)\s+(?:to|into|as)\s+(?:measure|bar|m\.?)\s*(\d+)/gi,
    /(?:再?加|新加|新增|添加|增加|插入|追加)\s*第?\s*([一二三四五六七八九十\d]+)\s*(?:小?节|節)/g,
    /第?\s*([一二三四五六七八九十\d]+)\s*(?:小?节|節).{0,12}(?:复制|拷贝).{0,8}(?:到|至).{0,4}第?\s*([一二三四五六七八九十\d]+)\s*(?:小?节|節)/g,
    /第?\s*([一二三四五六七八九十\d]+)\s*(?:小?节|節).{0,16}(?:改成|改为|换成|变成)/g,
    /(?:measure|bar|m\.?)\s*(\d+).{0,16}(?:to|into|as|replace|rewrite|change)/gi
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const number = parseMeasureNumber(match[2] ?? match[1]);
      if (Number.isInteger(number) && number > 0) numbers.add(number);
    }
  }
  if (referencesLastMeasure(message)) {
    const lastMeasureNumber = score.parts[0]?.measures.at(-1)?.number;
    if (lastMeasureNumber !== undefined) numbers.add(lastMeasureNumber);
  }
  return numbers;
}

function referencesLastMeasure(message: string): boolean {
  return /\b(last|final|ending|end)\b|最后|末尾|结尾/i.test(message) && hasMeasureTerm(message);
}

function measureRangeNumbers(fromMeasure: number, toMeasure: number): number[] {
  if (!Number.isInteger(fromMeasure) || !Number.isInteger(toMeasure) || fromMeasure <= 0 || toMeasure < fromMeasure) return [];
  const numbers: number[] = [];
  for (let measureNumber = fromMeasure; measureNumber <= toMeasure; measureNumber += 1) numbers.push(measureNumber);
  return numbers;
}

function measuresAfterLast(score: Score, measureNumbers: number[]): Set<number> {
  const lastMeasureNumber = score.parts[0]?.measures.at(-1)?.number ?? 0;
  return new Set(measureNumbers.filter((measureNumber) => measureNumber > lastMeasureNumber));
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

function sameScore(left: Score, right: Score): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeMeasureInput(
  measure: Extract<ScoreOperation, { type: "create_score" }>["params"]["measures"][number],
  fallbackTimeSignature?: { beats: number; beatType: number }
) {
  const effectiveTimeSignature = measure.timeSignature ?? fallbackTimeSignature ?? { beats: 4, beatType: 4 };
  const measureLength = measure.durationBeats ?? effectiveTimeSignature.beats * (4 / effectiveTimeSignature.beatType);
  const minimumDuration = 0.25;
  const events = measure.events.map((event) => ({ ...event }));
  const rawMaxEnd = Math.max(0, ...events.map((event) => event.startBeat + event.durationBeats));

  if (effectiveTimeSignature.beatType !== 4 && rawMaxEnd > measureLength + 0.001 && rawMaxEnd <= effectiveTimeSignature.beats + 0.001) {
    const beatUnitScale = 4 / effectiveTimeSignature.beatType;
    for (const event of events) {
      event.startBeat *= beatUnitScale;
      event.durationBeats *= beatUnitScale;
    }
  }

  const groups = new Map<string, typeof events>();

  for (const event of events) {
    const staff = event.staff ?? inferStaff(event.voice, event.pitches);
    const voice = event.voice ?? 1;
    event.staff = staff;
    event.voice = voice;
    if (!isPhraseMark(event.tie)) delete event.tie;
    if (!isPhraseMark(event.slur)) delete event.slur;
    if (!isBeamMark(event.beam)) delete event.beam;
    const key = `${staff}:${voice}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  for (const group of groups.values()) {
    const minimumStart = Math.min(...group.map((event) => event.startBeat));
    const shift = minimumStart >= measureLength ? Math.floor(minimumStart / measureLength) * measureLength : 0;

    for (const event of group) {
      event.startBeat = clampBeat(event.startBeat - shift, 0, Math.max(0, measureLength - minimumDuration));
      event.durationBeats = Math.min(Math.max(event.durationBeats, minimumDuration), measureLength - event.startBeat);
    }
  }

  const normalizedEvents = events.filter((event) => event.durationBeats >= minimumDuration && event.startBeat + event.durationBeats <= measureLength + 0.001);

  return {
    ...measure,
    ...(measure.timeSignature ? { timeSignature: measure.timeSignature } : {}),
    ...(!measure.timeSignature && fallbackTimeSignature ? { timeSignature: fallbackTimeSignature } : {}),
    ...(measure.durationBeats ? { durationBeats: measure.durationBeats } : {}),
    ...(measure.implicit ? { implicit: measure.implicit } : {}),
    ...(measure.harmonies ? { harmonies: measure.harmonies } : {}),
    ...(measure.tempos ? { tempos: measure.tempos } : {}),
    ...(measure.dynamics ? { dynamics: measure.dynamics } : {}),
    events: normalizedEvents.sort((a, b) => (a.staff ?? 1) - (b.staff ?? 1) || (a.voice ?? 1) - (b.voice ?? 1) || a.startBeat - b.startBeat)
  };
}

function clampBeat(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isPhraseMark(value: unknown): value is "start" | "stop" | "continue" {
  return value === "start" || value === "stop" || value === "continue";
}

function isBeamMark(value: unknown): value is "begin" | "continue" | "end" | "none" {
  return value === "begin" || value === "continue" || value === "end" || value === "none";
}

function inferStaff(voice: number | undefined, pitches: Array<{ step: string; alter?: number; octave: number }> | undefined): number {
  if (voice === 2) return 2;
  const lowest = pitches?.reduce<number | undefined>((lowestMidi, pitch) => {
    const midi = pitchToMidi(pitch);
    return lowestMidi === undefined ? midi : Math.min(lowestMidi, midi);
  }, undefined);
  return lowest !== undefined && lowest < 60 ? 2 : 1;
}

function pitchToMidi(pitch: { step: string; alter?: number; octave: number }): number {
  const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (pitch.octave + 1) * 12 + (semitones[pitch.step] ?? 0) + (pitch.alter ?? 0);
}

function generatedEvents(): NoteEvent[] {
  return [
    {
      id: "stream_n_1",
      measureNumber: 1,
      startBeat: 0,
      durationBeats: 1,
      pitches: [{ step: "C", octave: 3 }],
      voice: 1
    },
    {
      id: "stream_n_2",
      measureNumber: 1,
      startBeat: 1,
      durationBeats: 1,
      pitches: [{ step: "G", octave: 3 }],
      voice: 1
    },
    {
      id: "stream_n_3",
      measureNumber: 1,
      startBeat: 2,
      durationBeats: 1,
      pitches: [{ step: "E", octave: 3 }],
      voice: 1
    },
    {
      id: "stream_n_4",
      measureNumber: 1,
      startBeat: 3,
      durationBeats: 1,
      pitches: [{ step: "G", octave: 3 }],
      voice: 1
    }
  ];
}

function generatedScore(title: string, events: NoteEvent[]): Score {
  return {
    id: "stream_score",
    title,
    parts: [
      {
        id: "P1",
        name: "Piano",
        measures: [
          {
            number: 1,
            divisions: 1,
            timeSignature: { beats: 4, beatType: 4 },
            key: { fifths: 0 },
            events
          }
        ]
      }
    ]
  };
}

function titleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Sheet";
  return cleaned.length > 42 ? `${cleaned.slice(0, 39)}...` : cleaned;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_SCORE_BODY_BYTES = 4 * 1024 * 1024;

export async function readMusicXmlUpload(request: Request): Promise<{ musicxml: string; title?: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  const bytes = await readLimitedBody(request, MAX_SCORE_BODY_BYTES);
  if (contentType.includes("multipart/form-data")) {
    const form = await new Response(bytes.buffer as ArrayBuffer, { headers: { "content-type": contentType } }).formData();
    const file = form.get("file");
    const title = stringOrUndefined(form.get("title"));
    if (!(file instanceof File)) throw new Error("Expected a MusicXML file field named file.");
    return { musicxml: await file.text(), title };
  }
  let body: { musicxml?: string; title?: string };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON request." });
  }
  if (!body.musicxml) throw new Error("Expected musicxml.");
  return { musicxml: body.musicxml, title: body.title };
}

const MAX_AI_BODY_BYTES = 64 * 1024;

export async function readLimitedJson<T>(request: Request, maxBytes = MAX_AI_BODY_BYTES): Promise<T | undefined> {
  const bytes = await readLimitedBody(request, maxBytes);
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON request." });
  }
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (contentLength > maxBytes) throw new HTTPException(413, { message: "The request is too large." });
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HTTPException(413, { message: "The request is too large." });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function createAuth(env: Bindings, request?: Request) {
  const origin = authBaseURL(env, request);
  return betterAuth({
    appName: "SheetCraft",
    baseURL: origin,
    secret: authSecret(env, origin),
    database: env.DB,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8
    },
    trustedOrigins: (incomingRequest) => authTrustedOrigins(origin, incomingRequest),
    advanced: {
      cookiePrefix: "sheetcraft",
      useSecureCookies: origin.startsWith("https://")
    }
  });
}

function authBaseURL(env: Bindings, request?: Request): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  if (request) return new URL(request.url).origin;
  return "http://localhost:5173";
}

function authTrustedOrigins(origin: string, request?: Request): string[] {
  const origins = new Set([origin]);
  if (!request) return [...origins];

  const requestOrigin = new URL(request.url).origin;
  origins.add(requestOrigin);

  const headerOrigin = request.headers.get("origin");
  if (headerOrigin && isAllowedDevOrigin(headerOrigin)) origins.add(headerOrigin);

  return [...origins];
}

function isAllowedDevOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") && ["5173", "5174", "8787", "8788"].includes(url.port);
  } catch {
    return false;
  }
}

function authSecret(env: Bindings, origin: string): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const hostname = new URL(origin).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "sheetcraft-local-development-secret-change-before-deploy";
  }
  throw new Error("BETTER_AUTH_SECRET is required outside local development.");
}

async function currentSession(c: { env: Bindings; req: { raw: Request } }): Promise<AuthSession | null> {
  if (!c.env.DB) return null;
  const session = await createAuth(c.env, c.req.raw).api.getSession({ headers: c.req.raw.headers });
  return session as AuthSession | null;
}

async function requireSession(c: { env: Bindings; req: { raw: Request } }): Promise<AuthSession> {
  const session = await currentSession(c);
  if (!session) throw new HTTPException(401, { message: "Sign in required." });
  return session;
}

export async function consumeAiQuota(env: Bindings, userId: string, day = new Date().toISOString().slice(0, 10)) {
  if (!env.DB) throw new HTTPException(503, { message: "AI usage limits require D1." });
  const limits = [
    { subject: `user:${userId}`, limit: positiveLimit(env.AI_DAILY_USER_LIMIT, 30) },
    { subject: "global", limit: positiveLimit(env.AI_DAILY_GLOBAL_LIMIT, 300) }
  ];
  for (const { subject, limit } of limits) {
    const result = await env.DB.prepare(
      `insert into ai_daily_usage (day, subject, request_count) values (?, ?, 1)
       on conflict(day, subject) do update set request_count = request_count + 1
       where request_count < ?`
    ).bind(day, subject, limit).run();
    if (result.meta.changes !== 1) {
      throw new HTTPException(429, { message: "Today's AI request limit has been reached." });
    }
  }
}

function positiveLimit(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringOrUndefined(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function projectR2Key(projectId: string): string {
  return `projects/${projectId}/score.musicxml`;
}

function projectUpdatedMusicXmlKey(projectId: string): string {
  return `projects/${projectId}/score-${Date.now()}-${crypto.randomUUID()}.musicxml`;
}

function projectMusicXmlKey(project: ProjectRecord): string {
  if (!project.r2_key) throw new Error("Project has no MusicXML object.");
  return project.r2_key;
}

async function getProjectMusicXml(env: Bindings, project: ProjectRecord): Promise<string> {
  if (project.musicxml_text) return project.musicxml_text;
  return getObject(env, projectMusicXmlKey(project));
}

async function putObject(env: Bindings, key: string, value: string) {
  if (env.MUSICXML_BUCKET) {
    await env.MUSICXML_BUCKET.put(key, value, { httpMetadata: { contentType: "application/vnd.recordare.musicxml+xml" } });
    return;
  }
  memory.objects.set(key, value);
}

async function deleteObject(env: Bindings, key: string) {
  if (env.MUSICXML_BUCKET) {
    await env.MUSICXML_BUCKET.delete(key);
    return;
  }
  memory.objects.delete(key);
}

async function getObject(env: Bindings, key: string): Promise<string> {
  if (env.MUSICXML_BUCKET) {
    const object = await env.MUSICXML_BUCKET.get(key);
    if (!object) throw new Error(`Missing R2 object ${key}`);
    return object.text();
  }
  const value = memory.objects.get(key);
  if (!value) throw new Error(`Missing object ${key}`);
  return value;
}

async function insertProject(env: Bindings, project: ProjectRecord) {
  if (env.DB) {
    await env.DB.prepare(
      "insert into projects (id, user_id, title, r2_key, musicxml_text, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(project.id, project.user_id, project.title, project.r2_key, project.musicxml_text, project.created_at, project.updated_at)
      .run();
    return;
  }
  memory.projects.set(project.id, project);
}

async function getProject(env: Bindings, id: string): Promise<ProjectRecord | undefined> {
  if (env.DB) {
    return (
      (await env.DB.prepare("select * from projects where id = ?").bind(id).first<ProjectRecord>()) ?? undefined
    );
  }
  return memory.projects.get(id);
}

async function requireOwnedProject(env: Bindings, id: string, userId: string): Promise<ProjectRecord | undefined> {
  const project = await getProject(env, id);
  if (!project || project.user_id !== userId) return undefined;
  return project;
}

async function requireOwnedProjectOrThrow(env: Bindings, id: string, userId: string): Promise<ProjectRecord> {
  const project = await requireOwnedProject(env, id, userId);
  if (!project) throw new HTTPException(404, { message: "Project not found." });
  return project;
}

async function listProjects(env: Bindings, userId: string): Promise<ProjectRecord[]> {
  if (env.DB) {
    const rows = await env.DB.prepare(
      "select id, user_id, title, r2_key, created_at, updated_at from projects where r2_key is not null and user_id = ? order by updated_at desc"
    )
      .bind(userId)
      .all<ProjectRecord>();
    return rows.results;
  }
  return [...memory.projects.values()]
    .filter((project) => project.r2_key && project.user_id === userId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function requireProject(env: Bindings, id: string): Promise<ProjectRecord> {
  const project = await getProject(env, id);
  if (!project) throw new Error("Project not found.");
  return project;
}

export async function updateProjectStorage(env: Bindings, projectId: string, r2Key: string, musicxml: string, expectedR2Key: string) {
  const updatedAt = new Date().toISOString();
  if (env.DB) {
    const result = await env.DB.prepare("update projects set r2_key = ?, musicxml_text = ?, updated_at = ? where id = ? and r2_key = ?")
      .bind(r2Key, musicxml, updatedAt, projectId, expectedR2Key)
      .run();
    if (result.meta.changes !== 1) throw new HTTPException(409, { message: "The score changed in another request. Reload it before editing again." });
    return;
  }
  const project = memory.projects.get(projectId);
  if (!project || project.r2_key !== expectedR2Key) throw new HTTPException(409, { message: "The score changed in another request. Reload it before editing again." });
  memory.projects.set(projectId, { ...project, r2_key: r2Key, musicxml_text: musicxml, updated_at: updatedAt });
}

async function updateProjectTitle(env: Bindings, projectId: string, title: string) {
  const updatedAt = new Date().toISOString();
  if (env.DB) {
    await env.DB.prepare("update projects set title = ?, updated_at = ? where id = ?")
      .bind(title, updatedAt, projectId)
      .run();
    return;
  }
  const project = memory.projects.get(projectId);
  if (project) memory.projects.set(projectId, { ...project, title, updated_at: updatedAt });
}

async function deleteProject(env: Bindings, projectId: string) {
  const project = await getProject(env, projectId);
  if (project?.r2_key) await deleteObject(env, project.r2_key);

  if (env.DB) {
    await env.DB.batch([
      env.DB.prepare("delete from agent_messages where project_id = ?").bind(projectId),
      env.DB.prepare("delete from projects where id = ?").bind(projectId)
    ]);
    return;
  }

  for (const [messageId, message] of memory.messages.entries()) {
    if ((message as { project_id?: string }).project_id === projectId) memory.messages.delete(messageId);
  }
  memory.projects.delete(projectId);
}

async function insertAgentMessage(env: Bindings, message: {
  id: string;
  project_id: string;
  role: string;
  content: string;
  selection_json?: string | null;
  operations_json?: string | null;
  created_at: string;
}) {
  if (env.DB) {
    await env.DB.prepare(
      "insert into agent_messages (id, project_id, role, content, selection_json, operations_json, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        message.id,
        message.project_id,
        message.role,
        message.content,
        message.selection_json,
        message.operations_json,
        message.created_at
      )
      .run();
    return;
  }
  memory.messages.set(message.id, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

export default app;
