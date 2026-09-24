import { readProjectStream } from "./projectStream";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from "react-router";
import { jsPDF } from "jspdf";
import { CursorType, OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { createAuthClient } from "better-auth/react";
import "svg2pdf.js";
import * as Tone from "tone";
import { Repeat, MoreHorizontal, ChevronDown, FileCode2, FileMusic, FileText, Trash2 } from "lucide-react";
import { EditorMenu } from "./EditorMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { exportMidi, generateTimeline, pitchToToneName } from "../shared";
import type { Measure, NoteEvent, PlaybackEvent, Score } from "../shared";
import { NoteInspector, type InspectorAnchorRect } from "./NoteInspector";
import { ChatMarkdown } from "./ChatMarkdown";
import { Landing } from "./Landing";
import { LandingScore } from "./LandingScore";
import { useScoreEditing } from "./useScoreEditing";
import {
  captureScoreScrollSnapshot,
  findGraphicalNoteForLocator,
  getGraphicalNoteHighlightTarget,
  measureClientRect,
  pinScoreRenderHeight,
  restoreScoreScrollSnapshot,
  type NoteLocator
} from "./scoreEditingUtils";
import "./styles.css";
import "./editor.css";

const ACTIVE_PROJECT_KEY = "sheetcraft.activeProjectId";
const AUTH_USER_HINT_KEY = "sheetcraft.authUserHint";
const DEFAULT_ASSISTANT_MESSAGE = "Describe the musical intention, structure, or feeling you want to shape.";
const STREAM_SCORE_RENDER_DEBOUNCE_MS = 400;
const OSMD_OPTIONS = {
  autoResize: true,
  backend: "svg" as const,
  drawTitle: false,
  drawPartNames: false,
  drawPartAbbreviations: false,
  disableCursor: false,
  followCursor: false,
  cursorsOptions: [
    {
      type: CursorType.CurrentArea,
      color: "#16766f",
      alpha: 0.28,
      follow: false
    }
  ]
};
const PIANO_SAMPLE_BASE_URL = "https://tonejs.github.io/audio/salamander/";
const PIANO_SAMPLE_URLS = {
  A0: "A0.mp3",
  C1: "C1.mp3",
  "F#1": "Fs1.mp3",
  C2: "C2.mp3",
  "F#2": "Fs2.mp3",
  C3: "C3.mp3",
  "F#3": "Fs3.mp3",
  C4: "C4.mp3",
  "F#4": "Fs4.mp3",
  C5: "C5.mp3",
  "F#5": "Fs5.mp3",
  C6: "C6.mp3",
  "F#6": "Fs6.mp3",
  C7: "C7.mp3",
  C8: "C8.mp3"
};
const authClient = createAuthClient();

type ProjectResponse = {
  project: { id: string; title?: string; r2_key?: string | null };
  musicxml: string;
  score: Score;
  assistantText?: string;
  validation?: { valid: boolean; errors: string[]; warnings: string[] };
};

type ProjectSummary = {
  id: string;
  title?: string | null;
  r2_key?: string | null;
  created_at: string;
  updated_at: string;
};

type BootstrapEvent =
  | { type: "session"; user: AuthUser | null }
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "project"; project: ProjectResponse | null }
  | { type: "error"; error: string }
  | { type: "done" };

type StreamGenerateChunk = Partial<ProjectResponse> & {
  done: boolean;
  error?: string;
  assistantText?: string;
  musicxml?: string;
  score?: Score;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

type RequestHistory = Array<Pick<ChatMessage, "role" | "content">>;

type PlaybackState = "stopped" | "playing" | "paused";
type AuthMode = "sign-in" | "sign-up";

type AuthUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => authUserHint());
  const [authPending, setAuthPending] = useState(() => Boolean(authUserHint()));
  const [bootstrapPending, setBootstrapPending] = useState(true);
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [composerInput, setComposerInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: DEFAULT_ASSISTANT_MESSAGE
    }
  ]);
  const [busy, setBusy] = useState(false);
  const [editorPanel, setEditorPanel] = useState<"composer" | "note">("composer");
  const [scoreZoom, setScoreZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [currentMeasure, setCurrentMeasure] = useState<number | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("stopped");
  const [playbackLoop, setPlaybackLoop] = useState(false);
  const [playbackBpm, setPlaybackBpm] = useState(96);
  const [playbackBpmOverridden, setPlaybackBpmOverridden] = useState(false);
  const [scoreRenderMusicxml, setScoreRenderMusicxml] = useState<string | null>(null);
  const [scoreRendering, setScoreRendering] = useState(false);
  const [scoreRenderedOnce, setScoreRenderedOnce] = useState(false);
  const [measureHighlightStyle, setMeasureHighlightStyle] = useState<React.CSSProperties | null>(null);
  const [inspectorAnchorRect, setInspectorAnchorRect] = useState<InspectorAnchorRect | null>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const osmdContainerRef = useRef<HTMLDivElement | null>(null);
  const scoreRenderGenerationRef = useRef(0);
  const pendingScoreMusicxmlRef = useRef<string | null>(null);
  const scoreRenderTimerRef = useRef<number | null>(null);
  const streamedScorePreviewRef = useRef(false);
  const cursorMeasureRef = useRef<number | null>(null);
  const currentMeasureRef = useRef<number | null>(null);
  const playbackStateRef = useRef<PlaybackState>("stopped");
  const projectRef = useRef<ProjectResponse | null>(null);
  const highlightEventIdsRef = useRef<number[]>([]);
  const playbackRunRef = useRef(0);
  const playbackLoopRef = useRef(false);
  const loopHandlerRef = useRef<(() => void) | null>(null);
  const pianoSamplerRef = useRef<Tone.Sampler | null>(null);
  const pianoSamplerPromiseRef = useRef<Promise<Tone.Sampler> | null>(null);
  const reapplyHighlightRef = useRef<() => void>(() => {});

  currentMeasureRef.current = currentMeasure;
  playbackStateRef.current = playbackState;
  projectRef.current = project;

  const {
    waitForSaves,
    selectedNote,
    chordToneMode,
    contextSelectedNoteIds,
    selectionBox,
    handleScoreClick,
    handleScoreDoubleClick,
    handleScoreMouseDown,
    handleScoreMouseMove,
    handleScoreMouseUp,
    applyOperation,
    beginChordToneAdd,
    cancelChordToneAdd,
    clearContextSelection,
    focusChordPitch,
    reapplyHighlight
  } = useScoreEditing({
    busy,
    project,
    setProject,
    setEditError,
    osmdRef,
    scoreRef
  });

  useEffect(() => {
    if (selectedNote) setEditorPanel("note");
  }, [selectedNote?.noteId]);
  useEffect(() => {
    if (contextSelectedNoteIds.length) setEditorPanel("composer");
  }, [contextSelectedNoteIds]);
  reapplyHighlightRef.current = reapplyHighlight;

  const flushScoreRender = useCallback((musicxml: string) => {
    pendingScoreMusicxmlRef.current = musicxml;
    if (scoreRenderTimerRef.current !== null) {
      window.clearTimeout(scoreRenderTimerRef.current);
      scoreRenderTimerRef.current = null;
    }
    setScoreRenderMusicxml(musicxml);
  }, []);

  const scheduleScoreRender = useCallback((musicxml: string, delayMs: number) => {
    pendingScoreMusicxmlRef.current = musicxml;
    // Throttle rather than debounce: keep the pending timer alive so a fast
    // stream of chunks cannot indefinitely postpone the next render.
    if (scoreRenderTimerRef.current !== null) return;
    scoreRenderTimerRef.current = window.setTimeout(() => {
      scoreRenderTimerRef.current = null;
      if (pendingScoreMusicxmlRef.current !== null) {
        setScoreRenderMusicxml(pendingScoreMusicxmlRef.current);
      }
    }, delayMs);
  }, []);

  const inspectorKeyFifths = useMemo(
    () => project?.score.parts[0]?.measures.find((measure) => measure.number === selectedNote?.measureNumber)?.key?.fifths ?? 0,
    [project, selectedNote?.measureNumber]
  );

  const measures = useMemo(() => project?.score.parts[0]?.measures.map((measure) => measure.number) ?? [], [project]);
  const scoreBpm = useMemo(() => (project ? initialTempoBpm(project.score) : 96), [project]);
  const noteCount = useMemo(
    () => project?.score.parts.reduce((sum, part) => sum + part.measures.reduce((inner, measure) => inner + measure.events.length, 0), 0) ?? 0,
    [project]
  );

  const bootstrapping = bootstrapPending;

  const bootstrap = useCallback(async () => {
    setBootstrapPending(true);
    setError(null);
    try {
      const projectId = localStorage.getItem(ACTIVE_PROJECT_KEY);
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      await readBootstrap(`/api/bootstrap${query}`, (event) => {
        if (event.type === "session") {
          setAuthUser(event.user);
          setAuthPending(false);
          if (event.user) {
            localStorage.setItem(AUTH_USER_HINT_KEY, JSON.stringify(event.user));
          }
          if (!event.user) {
            localStorage.removeItem(AUTH_USER_HINT_KEY);
            localStorage.removeItem(ACTIVE_PROJECT_KEY);
            setBusy(false);
          }
          return;
        }
        if (event.type === "projects") {
          setProjects(event.projects);
          return;
        }
        if (event.type === "project") {
          setProject(event.project);
          if (event.project && event.project.project.id !== "streaming") {
            localStorage.setItem(ACTIVE_PROJECT_KEY, event.project.project.id);
          }
          return;
        }
        if (event.type === "error") throw new Error(event.error);
      });
    } catch (err) {
      setAuthUser(null);
      localStorage.removeItem(AUTH_USER_HINT_KEY);
      setProject(null);
      setProjects([]);
      setError(errorMessage(err));
    } finally {
      setAuthPending(false);
      setBootstrapPending(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!project?.musicxml) {
      setScoreRendering(false);
      setScoreRenderedOnce(false);
      pendingScoreMusicxmlRef.current = null;
      if (scoreRenderTimerRef.current !== null) {
        window.clearTimeout(scoreRenderTimerRef.current);
        scoreRenderTimerRef.current = null;
      }
      setScoreRenderMusicxml(null);
      setMeasureHighlightStyle(null);
      return;
    }

    setScoreRendering(true);
    pendingScoreMusicxmlRef.current = project.musicxml;

    if (!busy) {
      flushScoreRender(project.musicxml);
      return;
    }

    if (!streamedScorePreviewRef.current) {
      streamedScorePreviewRef.current = true;
      flushScoreRender(project.musicxml);
      return;
    }

    scheduleScoreRender(project.musicxml, STREAM_SCORE_RENDER_DEBOUNCE_MS);
  }, [busy, flushScoreRender, project?.musicxml, scheduleScoreRender]);

  useLayoutEffect(() => {
    setInspectorAnchorRect(selectedNote ? selectedNoteAnchorRect(osmdRef.current, scoreRef.current, selectedNote.locator) : null);
  }, [scoreRenderMusicxml, selectedNote?.noteId, selectedNote?.locator]);

  useEffect(() => {
    if (busy) {
      streamedScorePreviewRef.current = false;
      return;
    }
    if (pendingScoreMusicxmlRef.current) {
      flushScoreRender(pendingScoreMusicxmlRef.current);
    }
  }, [busy, flushScoreRender]);

  useEffect(() => {
    if (bootstrapPending || !scoreRenderMusicxml || !scoreRef.current) return;
    const musicxml = scoreRenderMusicxml;
    const generation = ++scoreRenderGenerationRef.current;

    async function render() {
      const container = scoreRef.current;
      if (!container) return;

      const scrollSnapshot = captureScoreScrollSnapshot(container);
      const releaseHeightPin = pinScoreRenderHeight(container);

      // React remounts the score container when the project is cleared (e.g. "New
      // project"), so a kept OSMD instance may be bound to a detached DOM node and
      // would render invisibly. Recreate it whenever the container changed.
      let osmd = osmdRef.current;
      if (!osmd || osmdContainerRef.current !== container) {
        osmd = new OpenSheetMusicDisplay(container, OSMD_OPTIONS);
        // OSMD ignores a logLevel constructor option; the instance method is
        // the only way to silence benign mid-stream skyline warnings.
        osmd.setLogLevel("error");
        osmd.EngravingRules.PageLeftMargin = 2;
        osmd.EngravingRules.PageRightMargin = 2;
        osmd.EngravingRules.SystemLabelsRightMargin = 0;
        osmdRef.current = osmd;
        osmdContainerRef.current = container;
      }

      await osmd.load(musicxml);
      if (generation !== scoreRenderGenerationRef.current) {
        releaseHeightPin();
        return;
      }

      osmd.Zoom = scoreZoom;
      osmd.render();
      osmd.enableOrDisableCursors(true);
      osmd.cursor.hide();
      cursorMeasureRef.current = null;

      const finalizeRender = () => {
        if (generation !== scoreRenderGenerationRef.current) return;
        restoreScoreScrollSnapshot(container, scrollSnapshot);
        reapplyHighlightRef.current();
        if (playbackStateRef.current !== "stopped" && currentMeasureRef.current !== null && projectRef.current) {
          showMeasureCursor(currentMeasureRef.current, projectRef.current.score);
        }
        restoreScoreScrollSnapshot(container, scrollSnapshot);
      };

      finalizeRender();
      requestAnimationFrame(() => {
        finalizeRender();
        requestAnimationFrame(() => {
          finalizeRender();
          releaseHeightPin();
          if (generation === scoreRenderGenerationRef.current) setScoreRendering(false);
          setScoreRenderedOnce(true);
        });
      });
    }

    void render().catch((err: unknown) => {
      if (generation === scoreRenderGenerationRef.current) setScoreRendering(false);
      setError(err instanceof Error ? err.message : "Failed to render score.");
    });
  }, [bootstrapPending, scoreRenderMusicxml, scoreZoom]);

  useEffect(() => {
    setPlaybackBpm(scoreBpm);
    setPlaybackBpmOverridden(false);
  }, [project?.project.id]);

  useEffect(() => {
    if (!playbackBpmOverridden) setPlaybackBpm(scoreBpm);
  }, [playbackBpmOverridden, scoreBpm]);

  useEffect(() => {
    if (!editError) return;
    const timer = window.setTimeout(() => setEditError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [editError]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chatMessages]);

  useEffect(() => {
    setTitleDraft(project?.project.title ?? "");
  }, [project?.project.id, project?.project.title]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      setProjectAndRemember(await createProjectFromFile(file));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    if (!project || project.project.id === "streaming") return;
    const title = titleDraft.trim();
    if (!title || title === project.project.title) return;
    try {
      const result = await request<{ project: ProjectResponse["project"] }>(`/api/projects/${project.project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      });
      setProject((current) => (current ? { ...current, project: { ...current.project, ...result.project } } : current));
      await refreshProjects();
    } catch (err) {
      setError(errorMessage(err));
      setTitleDraft(project.project.title ?? "");
    }
  }

  async function switchProject(projectId: string) {
    if (projectId === project?.project.id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const loadedProject = await request<ProjectResponse>(`/api/projects/${projectId}`, { method: "GET" });
      setProjectAndRemember(loadedProject);
      resetChat(`Loaded "${loadedProject.project.title ?? "Untitled project"}".`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(projectId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await request<{ ok: boolean }>(`/api/projects/${projectId}`, { method: "DELETE" });
      if (projectId === project?.project.id) {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
        const result = await request<{ projects: ProjectSummary[] }>("/api/projects", { method: "GET" });
        setProjects(result.projects);
        const nextProject = result.projects[0];
        if (nextProject) {
          const loadedProject = await request<ProjectResponse>(`/api/projects/${nextProject.id}`, { method: "GET" });
          setProjectAndRemember(loadedProject);
          resetChat(`Loaded "${loadedProject.project.title ?? "Untitled project"}".`);
        } else {
          setProject(null);
          resetChat(DEFAULT_ASSISTANT_MESSAGE);
        }
      } else {
        await refreshProjects();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function startNewProject() {
    setProject(null);
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
    resetChat(DEFAULT_ASSISTANT_MESSAGE);
    setComposerInput("");
  }

  async function sendAgentEdit(prompt: string, requestHistory?: RequestHistory) {
    if (!project) return;
    if (!prompt) return;
    const nextHistory = requestHistory ?? [...historyForRequest(chatMessages), { role: "user" as const, content: prompt }];
    setBusy(true);
    setError(null);
    setStreamStatus("Looking at your score...");
    let confirmedProject = project;
    try {
      await waitForSaves(project.project.id);
      confirmedProject = await request<ProjectResponse>(`/api/projects/${project.project.id}`, { method: "GET" });
      const response = await fetch(`/api/projects/${project.project.id}/agent/stream-edit`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          selection: scoreSelection(project, contextSelectedNoteIds),
          context: scoreContext(project, noteCount, contextSelectedNoteIds),
          history: nextHistory
        })
      });
      if (!response.ok || !response.body) throw new Error("Failed to start streaming edit.");

      await readProjectStream<StreamGenerateChunk>(response, (chunk) => {
        setStreamStatus(chunk.assistantText ?? null);
        const { musicxml, score } = chunk;
        if (musicxml && score) {
          setProjectAndRemember(projectFromStreamChunk({ ...chunk, musicxml, score }, project));
        }
        if (chunk.done) {
          appendChat("assistant", chunk.assistantText ?? "Done. I updated the score.");
        }
      });
    } catch (err) {
      const restored = await request<ProjectResponse>(`/api/projects/${project.project.id}`, { method: "GET" }).catch(() => confirmedProject);
      setProjectAndRemember(restored);
      setError(errorMessage(err));
      appendChat("assistant", errorMessage(err));
    } finally {
      setBusy(false);
      setStreamStatus(null);
    }
  }

  async function streamGenerate(prompt: string, requestHistory?: RequestHistory) {
    const generationPrompt = prompt || "Create a short beginner left-hand piano phrase";
    const nextHistory = requestHistory ?? [...historyForRequest(chatMessages), { role: "user" as const, content: generationPrompt }];
    setBusy(true);
    setError(null);
    setStreamStatus("Sitting with the idea...");
    const previousProject = project;
    try {
      const response = await fetch("/api/projects/stream-generate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: generationPrompt,
          context: project ? scoreContext(project, noteCount) : undefined,
          history: nextHistory
        })
      });
      if (!response.ok || !response.body) throw new Error("Failed to start streaming generation.");

      await readProjectStream<StreamGenerateChunk>(response, (chunk) => {
        setStreamStatus(chunk.assistantText ?? null);
        const { musicxml, score } = chunk;
        if (musicxml && score) {
          setProjectAndRemember(projectFromStreamChunk({ ...chunk, musicxml, score }));
        }
        if (chunk.done) appendChat("assistant", chunk.assistantText ?? "Your sheet is ready.");
      });
    } catch (err) {
      setProject(previousProject);
      setError(errorMessage(err));
      appendChat("assistant", errorMessage(err));
    } finally {
      setBusy(false);
      setStreamStatus(null);
    }
  }

  async function play(range?: { fromBeat: number; toBeat: number }) {
    if (!project) return;
    const timeline = generateTimeline(project.score);
    if (timeline.length === 0) return;
    const playbackRun = playbackRunRef.current + 1;
    playbackRunRef.current = playbackRun;

    const fromBeat = range?.fromBeat ?? 0;
    const toBeat = range?.toBeat ?? timelineEndBeat(timeline);
    if (toBeat <= fromBeat) return;

    setError(null);
    clearMeasureHighlightEvents();
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    pianoSamplerRef.current?.releaseAll();
    osmdRef.current?.cursor.hide();
    cursorMeasureRef.current = null;

    let piano: Tone.Sampler;
    try {
      void Tone.start().catch((err: unknown) => {
        setError(errorMessage(err));
      });
      piano = await getPianoSampler();
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    if (playbackRunRef.current !== playbackRun) return;

    const transport = Tone.getTransport();
    const bpm = playbackBpm;
    const loopPlayback = playbackLoopRef.current && !range;
    transport.bpm.value = bpm;
    transport.PPQ = 192;
    transport.position = `${fromBeat * transport.PPQ}i`;
    configureTransportLoop(transport, toBeat, loopPlayback);
    detachLoopHandler();
    if (loopPlayback) {
      attachLoopHandler(project.score, timeline, playbackRun, toBeat);
    }

    const startMeasureNumber = measureNumberAtBeat(timeline, fromBeat);
    setPlaybackStatus("playing");
    if (startMeasureNumber !== null) {
      showActiveMeasure(startMeasureNumber, project.score);
    }
    scheduleMeasureHighlightEvents(project.score, timeline, playbackRun, fromBeat, toBeat, { stopAtEnd: !loopPlayback });

    for (const event of timeline) {
      if (event.startBeat >= toBeat) break;
      if (event.startBeat + event.durationBeats <= fromBeat) continue;

      const noteStart = Math.max(event.startBeat, fromBeat);
      const noteEnd = Math.min(event.startBeat + event.durationBeats, toBeat);
      const durationBeats = noteEnd - noteStart;
      if (durationBeats <= 0) continue;

      transport.schedule((time) => {
        const legatoFactor = event.slur ? 1.04 : 1;
        piano.triggerAttackRelease(
          event.pitches.map(pitchToToneName),
          `${durationBeats * legatoFactor * transport.PPQ}i`,
          time,
          event.velocity ?? 0.75
        );
      }, `${noteStart * transport.PPQ}i`);
    }
    transport.start();
  }

  async function playMeasure(measureNumber: number) {
    if (!project) return;
    const range = measureBeatRange(project.score, measureNumber);
    if (!range) return;
    const timeline = generateTimeline(project.score);
    await play({ fromBeat: range.fromBeat, toBeat: timelineEndBeat(timeline) });
  }

  function pause() {
    if (playbackState !== "playing") return;
    Tone.getTransport().pause();
    pianoSamplerRef.current?.releaseAll();
    setPlaybackStatus("paused");
  }

  function resume() {
    if (!project || playbackState !== "paused") return;
    const timeline = generateTimeline(project.score);
    if (timeline.length === 0) return;

    const transport = Tone.getTransport();
    const currentBeat = transport.ticks / transport.PPQ;
    const measureNumber = measureNumberAtBeat(timeline, currentBeat);
    setPlaybackStatus("playing");
    if (measureNumber !== null) {
      showActiveMeasure(measureNumber, project.score);
    }
    transport.start();
  }

  function updatePlaybackBpm(value: number) {
    const nextBpm = clampBpm(value);
    setPlaybackBpm(nextBpm);
    setPlaybackBpmOverridden(nextBpm !== scoreBpm);
    Tone.getTransport().bpm.value = nextBpm;
  }

  function togglePlaybackLoop() {
    const next = !playbackLoopRef.current;
    playbackLoopRef.current = next;
    setPlaybackLoop(next);

    if (!project || playbackState === "stopped") return;

    const timeline = generateTimeline(project.score);
    const transport = Tone.getTransport();
    const endBeat = timelineEndBeat(timeline);
    const currentBeat = transport.ticks / transport.PPQ;
    const playbackRun = playbackRunRef.current;
    configureTransportLoop(transport, endBeat, next);
    detachLoopHandler();
    clearMeasureHighlightEvents();
    if (next) {
      attachLoopHandler(project.score, timeline, playbackRun, endBeat);
      scheduleMeasureHighlightEvents(project.score, timeline, playbackRun, currentBeat, endBeat, { stopAtEnd: false });
    } else {
      scheduleMeasureHighlightEvents(project.score, timeline, playbackRun, currentBeat, endBeat, { stopAtEnd: true });
    }
  }

  function stop() {
    playbackRunRef.current += 1;
    clearMeasureHighlightEvents();
    detachLoopHandler();
    const transport = Tone.getTransport();
    transport.loop = false;
    transport.stop();
    transport.cancel();
    pianoSamplerRef.current?.releaseAll();
    osmdRef.current?.cursor.hide();
    cursorMeasureRef.current = null;
    clearActiveMeasure();
    setMeasureHighlightStyle(null);
    setPlaybackStatus("stopped");
  }

  function setPlaybackStatus(nextState: PlaybackState) {
    playbackStateRef.current = nextState;
    setPlaybackState(nextState);
  }

  function showActiveMeasure(measureNumber: number, score: Score) {
    currentMeasureRef.current = measureNumber;
    setCurrentMeasure(measureNumber);
    showMeasureCursor(measureNumber, score);
    restoreActiveMeasureCursorSoon(measureNumber);
  }

  function clearActiveMeasure() {
    currentMeasureRef.current = null;
    setCurrentMeasure(null);
  }

  function restoreActiveMeasureCursorSoon(measureNumber: number) {
    let frames = 2;
    const restore = () => {
      if (playbackStateRef.current === "stopped") return;
      if (currentMeasureRef.current !== measureNumber) return;
      const activeProject = projectRef.current;
      if (!activeProject) return;

      showMeasureCursor(measureNumber, activeProject.score);
      frames -= 1;
      if (frames > 0) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  }

  async function getPianoSampler() {
    if (pianoSamplerRef.current?.loaded) return pianoSamplerRef.current;
    if (pianoSamplerPromiseRef.current) return pianoSamplerPromiseRef.current;

    pianoSamplerPromiseRef.current = new Promise<Tone.Sampler>((resolve, reject) => {
      const limiter = new Tone.Limiter(-3).toDestination();
      const sampler = new Tone.Sampler({
        urls: PIANO_SAMPLE_URLS,
        baseUrl: PIANO_SAMPLE_BASE_URL,
        attack: 0.002,
        release: 1.2,
        onerror: reject
      });
      sampler.connect(limiter);

      const timeout = new Promise<never>((_, rejectTimeout) => {
        window.setTimeout(() => rejectTimeout(new Error("Piano samples took too long to load.")), 15_000);
      });

      void Promise.race([Tone.loaded(), timeout])
        .then(() => {
          pianoSamplerRef.current = sampler;
          resolve(sampler);
        })
        .catch(reject);
    });

    return pianoSamplerPromiseRef.current;
  }

  function showMeasureCursor(measureNumber: number, score: Score) {
    const osmd = osmdRef.current;
    if (!osmd) return;

    const measureIndex = score.parts[0]?.measures.findIndex((measure) => measure.number === measureNumber) ?? -1;
    if (measureIndex < 0) return;
    updateMeasureHighlight(measureNumber);

    const cursor = osmd.cursor;
    cursor.reset();
    for (let index = 0; index < measureIndex; index++) {
      cursor.nextMeasure();
    }
    cursor.show();
    releaseCursorSize();
    cursor.update();
    keepCursorAboveScore();
    cursorMeasureRef.current = measureNumber;
  }

  function updateMeasureHighlight(measureNumber: number) {
    const osmd = osmdRef.current;
    const container = scoreRef.current;
    if (!osmd || !container) return;

    const rect = measureClientRect(osmd, container, measureNumber);
    if (!rect) return;
    setMeasureHighlightStyle({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  }

  function releaseCursorSize() {
    const cursorImage = scoreRef.current?.querySelector<HTMLImageElement>('img[id^="cursorImg"]');
    if (!cursorImage) return;

    cursorImage.style.removeProperty("width");
    cursorImage.style.removeProperty("height");
  }

  function keepCursorAboveScore() {
    const cursorImage = scoreRef.current?.querySelector<HTMLImageElement>('img[id^="cursorImg"]');
    if (!cursorImage) return;

    cursorImage.style.zIndex = "2";
    cursorImage.style.pointerEvents = "none";
    cursorImage.style.opacity = "1";
    cursorImage.style.maxWidth = "none";
    cursorImage.style.width = `${cursorImage.getAttribute("width") ?? cursorImage.width}px`;
    cursorImage.style.height = `${cursorImage.getAttribute("height") ?? cursorImage.height}px`;
  }

  function scheduleMeasureHighlightEvents(
    score: Score,
    timeline: PlaybackEvent[],
    playbackRun: number,
    fromBeat: number,
    toBeat?: number,
    options: { stopAtEnd?: boolean } = {}
  ) {
    clearMeasureHighlightEvents();
    const transport = Tone.getTransport();
    const measureStarts = new Map<number, number>();
    let timelineEnd = 0;

    for (const event of timeline) {
      const current = measureStarts.get(event.measureNumber);
      if (current === undefined || event.startBeat < current) {
        measureStarts.set(event.measureNumber, event.startBeat);
      }
      timelineEnd = Math.max(timelineEnd, event.startBeat + event.durationBeats);
    }

    const stopBeat = toBeat ?? timelineEnd;

    for (const [measureNumber, startBeat] of measureStarts.entries()) {
      if (startBeat <= fromBeat) continue;
      if (startBeat >= stopBeat) continue;
      const eventId = transport.schedule((time) => {
        Tone.getDraw().schedule(() => {
          if (playbackRunRef.current !== playbackRun) return;
          showActiveMeasure(measureNumber, score);
        }, time);
      }, `${startBeat * transport.PPQ}i`);
      highlightEventIdsRef.current.push(eventId);
    }

    if ((options.stopAtEnd ?? true) && stopBeat > fromBeat) {
      const endEventId = transport.schedule((time) => {
        Tone.getDraw().schedule(() => {
          if (playbackRunRef.current !== playbackRun) return;
          stop();
        }, time);
      }, `${stopBeat * transport.PPQ}i`);
      highlightEventIdsRef.current.push(endEventId);
    }
  }

  function attachLoopHandler(score: Score, timeline: PlaybackEvent[], playbackRun: number, toBeat: number) {
    const onLoop = () => {
      if (playbackRunRef.current !== playbackRun) return;
      scheduleMeasureHighlightEvents(score, timeline, playbackRun, 0, toBeat, { stopAtEnd: false });
      const firstMeasureNumber = timeline[0]?.measureNumber;
      if (firstMeasureNumber !== undefined) {
        showActiveMeasure(firstMeasureNumber, score);
      }
    };
    Tone.getTransport().on("loop", onLoop);
    loopHandlerRef.current = onLoop;
  }

  function detachLoopHandler() {
    const handler = loopHandlerRef.current;
    if (!handler) return;
    Tone.getTransport().off("loop", handler);
    loopHandlerRef.current = null;
  }

  function clearMeasureHighlightEvents() {
    const transport = Tone.getTransport();
    for (const eventId of highlightEventIdsRef.current) {
      transport.clear(eventId);
    }
    highlightEventIdsRef.current = [];
  }

  function measureNumberAtBeat(timeline: PlaybackEvent[], beat: number): number | null {
    let measureNumber: number | null = null;
    for (const event of timeline) {
      if (event.startBeat <= beat) measureNumber = event.measureNumber;
      if (event.startBeat > beat) break;
    }
    return measureNumber;
  }

  function setProjectAndRemember(nextProject: ProjectResponse) {
    setProject(nextProject);
    if (nextProject.project.id !== "streaming") {
      localStorage.setItem(ACTIVE_PROJECT_KEY, nextProject.project.id);
      void refreshProjects();
    }
  }

  function appendChat(role: ChatMessage["role"], content: string) {
    setChatMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role,
        content
      }
    ]);
  }

  function resetChat(content = DEFAULT_ASSISTANT_MESSAGE) {
    setChatMessages([
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content
      }
    ]);
  }

  function resetComposerSession() {
    if (busy) return;
    resetChat();
    clearContextSelection();
    setComposerInput("");
    setError(null);
  }

  async function refreshProjects() {
    try {
      const result = await request<{ projects: ProjectSummary[] }>("/api/projects", { method: "GET" });
      setProjects(result.projects);
    } catch {
      setProjects([]);
    }
  }

  function submitComposer() {
    const prompt = composerInput.trim();
    if (!prompt || busy) return;
    const nextHistory = [...historyForRequest(chatMessages), { role: "user" as const, content: prompt }];
    appendChat("user", prompt);
    setComposerInput("");
    setBusy(true);
    if (!project) {
      void streamGenerate(prompt, nextHistory);
      return;
    }
    void routeComposerIntent(prompt, nextHistory);
  }

  async function routeComposerIntent(prompt: string, requestHistory: RequestHistory) {
    try {
      const context = scoreContext(project!, noteCount, contextSelectedNoteIds);
      const result = await request<{ intent: "generate" | "edit" }>("/api/agent/classify-intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          context: {
            scoreTitle: context.scoreTitle,
            measureCount: context.measureCount
          }
        })
      });
      if (result.intent === "generate") {
        void streamGenerate(prompt, requestHistory);
        return;
      }
    } catch {
    }
    void sendAgentEdit(prompt, requestHistory);
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = authEmail.trim();
    const password = authPassword;
    const name = authName.trim() || email.split("@")[0] || "SheetCraft user";
    if (!email || !password || authBusy) return;

    setAuthBusy(true);
    setAuthError(null);
    try {
      const result =
        authMode === "sign-up"
          ? await authClient.signUp.email({ name, email, password })
          : await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(authErrorMessage(result.error));
      setAuthPassword("");
      setAuthPending(true);
      await bootstrap();
      navigate("/editor", { replace: true });
    } catch (err) {
      setAuthError(errorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authClient.signOut();
      setAuthUser(null);
      localStorage.removeItem(AUTH_USER_HINT_KEY);
      setProject(null);
      setProjects([]);
      localStorage.removeItem(ACTIVE_PROJECT_KEY);
      navigate("/login", { replace: true });
    } catch (err) {
      setAuthError(errorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  if (authPending && !authUser) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<BootstrapShell />} />
        <Route path="/editor" element={<BootstrapShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  const actionsDisabled = busy || bootstrapping;

  const editorView = (
    <main className="app-shell editor-shell">
      <header className="editor-header">
        <Link className="editor-logo" to="/"><span aria-hidden="true">♮</span>SheetCraft</Link>
        <div className="editor-project-title">            {bootstrapping ? (
              <div className="title-skeleton" aria-hidden="true" />
            ) : project ? (
              <Input
                className="title-input"
                value={titleDraft}
                onBlur={() => void saveTitle()}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setTitleDraft(project.project.title ?? "");
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Project title"
              />
            ) : (
              <h1>SheetCraft</h1>
            )}
</div>
        <span className="editor-save-status">{busy ? "Updating score…" : editError ? "Changes need attention" : "Autosave on"}</span>
        <span className="editor-export-formats">MusicXML · MIDI · PDF</span>
        <EditorMenu className="editor-export-trigger" label="Export score" heading="EXPORT SCORE" trigger={<>Export <ChevronDown size={14} /></>}>            <Button
              variant="ghost"
              disabled={!project || bootstrapping}
              onClick={() => {
                if (!project) return;
                downloadMusicXml(project.musicxml, exportFilename(project.project.title, "musicxml"));
              }}
            >
              <FileCode2 /><span><strong>MusicXML</strong><small>Edit in other notation apps</small></span><em>.xml</em>
            </Button>
            <Button
              variant="ghost"
              disabled={!project || actionsDisabled}
              title="Export a MIDI file for GarageBand and other music apps"
              onClick={() => {
                if (!project) return;
                try {
                  const bytes = exportMidi(project.score, playbackBpmOverridden ? { bpm: playbackBpm } : {});
                  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = exportFilename(project.project.title, "mid");
                  anchor.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              <FileMusic /><span><strong>MIDI</strong><small>Open in your music software</small></span><em>.mid</em>
            </Button>
            <Button
              variant="ghost"
              disabled={!project || bootstrapping}
              onClick={() => {
                const osmd = osmdRef.current;
                if (!project || !osmd) return;
                void downloadScorePdf(osmd, exportFilename(project.project.title, "pdf")).catch((err: unknown) =>
                  setError(errorMessage(err))
                );
              }}
            >
              <FileText /><span><strong>PDF document</strong><small>Print or share your score</small></span><em>.pdf</em>
            </Button>
</EditorMenu>
        <details className="editor-account"><summary aria-label="Account">{(authUser?.name || authUser?.email || "U").slice(0, 2).toUpperCase()}</summary><AccountPanel user={authUser} busy={authBusy} onSignOut={() => void signOut()} /></details>
      </header>
      <aside className="editor-library">
        <div className="editor-library-label">YOUR SCORES</div>
        <div className="editor-library-actions"><Button disabled={actionsDisabled} onClick={startNewProject}>＋ New score</Button>            <label className={authUser && !actionsDisabled ? "upload-button" : "upload-button disabled"}>
              Import MusicXML
              <input
                type="file"
                accept=".musicxml,.xml,.mxl"
                disabled={!authUser || actionsDisabled}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>
</div>
        <div className="editor-projects">{projects.map(item => <div className={`editor-project-row${item.id === project?.project.id ? " active" : ""}`} key={item.id}>
          <button className="editor-project-open" disabled={actionsDisabled} onClick={() => void switchProject(item.id)}><span aria-hidden="true">♩</span><span><strong>{item.title || "Untitled score"}</strong><small>{formatProjectDate(item.updated_at)}</small></span></button>
          <EditorMenu className="editor-project-trigger" label={`Actions for ${item.title || "Untitled score"}`} heading={item.title || "Untitled score"} trigger={<MoreHorizontal size={18} />}><button className="editor-menu-danger" disabled={actionsDisabled} onClick={() => void deleteProject(item.id)}><Trash2 size={16} /><span><strong>Delete score</strong><small>Remove from your library</small></span></button></EditorMenu>
        </div>)}{projects.length === 0 && <p className="editor-library-empty">Your saved scores will appear here.</p>}</div>
        <div className="editor-library-footer"><details><summary>⌨ Keyboard shortcuts</summary><p>↑ / ↓ Change pitch<br/>3–7 Change duration<br/>Delete Remove note<br/>⌘ / Ctrl + Enter Send message</p></details><Link to="/">← Back to home</Link></div>
      </aside>
      <section className="score-pane">
        <div className="editor-score-toolbar"><span className="editor-select-label">↖ Select</span><span className="editor-select-hint">Click a note to edit · Drag to select</span><div className="editor-zoom"><button aria-label="Zoom out" disabled={!project || scoreZoom <= .6} onClick={() => setScoreZoom(value => Math.max(.6, +(value - .1).toFixed(1)))}>−</button><button aria-label="Reset zoom" onClick={() => setScoreZoom(1)}>{Math.round(scoreZoom * 100)}%</button><button aria-label="Zoom in" disabled={!project || scoreZoom >= 1.6} onClick={() => setScoreZoom(value => Math.min(1.6, +(value + .1).toFixed(1)))}>＋</button></div></div>
        <div className="editor-score-scroll">        {project || bootstrapping ? (
          <>
            <div className="score-paper"><header className="editor-score-title"><h1>{project?.project.title || "Untitled score"}</h1><span>{project?.score.parts.map(part => part.name).join(" · ")}</span></header>
              {editError && <div className="edit-toast">{editError}</div>}
              {project && (
                <>
                  <div className="score-canvas">
                    <div
                      ref={scoreRef}
                      className="score-render"
                      onClick={handleScoreClick}
                      onDoubleClick={handleScoreDoubleClick}
                      onMouseDown={handleScoreMouseDown}
                      onMouseMove={handleScoreMouseMove}
                      onMouseUp={handleScoreMouseUp}
                    />
                    {measureHighlightStyle && <div className="measure-highlight" style={measureHighlightStyle} />}
                    {selectionBox && <div className="score-selection-box" style={selectionBox} />}
                  </div>

                </>
              )}
              {(bootstrapping || (scoreRendering && !scoreRenderedOnce)) && <ScoreLoadingOverlay />}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <strong>Start with a phrase</strong>
            <span>Generate a short score or import MusicXML to begin composing.</span>
            <div className="empty-state-prompts" aria-hidden="true">
              <p className="empty-state-prompt">&ldquo;Write a gentle 8-bar melody in C major&rdquo;</p>
              <p className="empty-state-prompt">&ldquo;Add a simple left-hand accompaniment to measures 1–4&rdquo;</p>
              <p className="empty-state-prompt">&ldquo;Transpose the theme up a whole step&rdquo;</p>
            </div>
          </div>
        )}


</div>
        <footer className="editor-transport">            <div className="tempo-control" aria-label="Playback tempo">
              <span>Score {scoreBpm} BPM</span>
              <label>
                BPM
                <Input
                  type="number"
                  min={40}
                  max={240}
                  value={playbackBpm}
                  disabled={!project || bootstrapping}
                  onChange={(event) => updatePlaybackBpm(Number(event.target.value))}
                />
              </label>
              <input
                type="range"
                min={40}
                max={240}
                value={playbackBpm}
                disabled={!project || bootstrapping}
                onChange={(event) => updatePlaybackBpm(Number(event.target.value))}
              />
            </div>
            <Button
              variant="ghost"
              disabled={!project || bootstrapping}
              aria-pressed={playbackLoop}
              aria-label="Loop playback"
              className={playbackLoop ? "playback-loop-active" : undefined}
              onClick={togglePlaybackLoop}
            >
              <Repeat />
              Loop
            </Button>
            <Button
              variant="ghost"
              disabled={!project || actionsDisabled}
              aria-label={playbackState === "playing" ? "Pause" : "Play"}
              onClick={() => {
                if (playbackState === "playing") {
                  pause();
                  return;
                }
                if (playbackState === "paused") {
                  resume();
                  return;
                }
                void play();
              }}
            >
              <span aria-hidden="true">{playbackState === "playing" ? "Ⅱ" : "▶"}</span>
            </Button>
            <Button variant="ghost" disabled={!project || bootstrapping} onClick={stop}>
              Restart
            </Button>
<details className="editor-measures"><summary>{currentMeasure ? `Measure ${currentMeasure}` : "Play from measure"} ⌃</summary>{project && <MeasureStrip measures={measures} currentMeasure={currentMeasure} disabled={actionsDisabled} onMeasureClick={number => void playMeasure(number)} />}</details></footer>
      </section>
      <aside className="agent-panel">
        <div className="editor-panel-tabs" role="tablist" aria-label="Editor panel"><button role="tab" aria-selected={editorPanel === "composer"} onClick={() => setEditorPanel("composer")}>✳ Composer</button><button role="tab" aria-selected={editorPanel === "note"} onClick={() => setEditorPanel("note")}>Note properties</button></div>
        {editorPanel === "note" ? <div className="editor-note-panel">{selectedNote ? <NoteInspector
                      selectedNote={selectedNote}
                      docked
                      onApply={applyOperation}
                      onFocusPitch={focusChordPitch}
                      chordToneMode={chordToneMode}
                      onBeginChordToneAdd={beginChordToneAdd}
                      onCancelChordToneAdd={cancelChordToneAdd}
                      keyFifths={inspectorKeyFifths}
                    /> : <div className="editor-note-empty"><h2>Select a note</h2><p>Click a note on the score to edit its pitch, rhythm and notation.</p><button onClick={() => setEditorPanel("composer")}>Return to Composer</button></div>}</div> : <div className="editor-composer-panel">        <div className="inspector-heading">
          <div className="inspector-heading-copy">
            <span>THIS CONVERSATION</span>
          </div>
          <Button variant="ghost" size="sm" disabled={actionsDisabled} onClick={resetComposerSession}>
            Reset
          </Button>
        </div>

        <div className="chat-thread" aria-live="polite">
          {chatMessages.map((chatMessage) => (
            <div className={`chat-message ${chatMessage.role}`} key={chatMessage.id}>
              <span>{chatMessage.role === "assistant" ? "✳ Composer" : "You"}</span>
              <ChatMarkdown content={chatMessage.content} />
            </div>
          ))}
          {busy && (
            <div className="chat-message assistant pending">
              <span>Composer</span>
              <ChatMarkdown content={streamStatus ?? "Thinking it through..."} />
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {error && <div className="error">{error}</div>}

        {contextSelectedNoteIds.length > 0 && (
          <div className="chat-context-selection">
            <span>{contextSelectedNoteIds.length} notes selected for chat</span>
            <button type="button" onClick={clearContextSelection}>
              Clear
            </button>
          </div>
        )}

        <div className="composer-box">
          <Textarea
            aria-label="Message Composer"
            placeholder="Describe the change you want…"
            value={composerInput}
            onChange={(event) => setComposerInput(event.target.value)}
            rows={3}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitComposer();
              }
            }}
          />
          <div className="composer-actions">
            <span>Cmd/Ctrl Enter to send</span>
            <Button size="lg" disabled={actionsDisabled || !composerInput.trim()} onClick={submitComposer}>
              Send ↑
            </Button>
          </div>
        </div>
</div>}
      </aside>
    </main>
  );

  const authView = (
    <AuthPage
      mode={authMode}
      name={authName}
      email={authEmail}
      password={authPassword}
      busy={authBusy}
      error={authError}
      onModeChange={setAuthMode}
      onNameChange={setAuthName}
      onEmailChange={setAuthEmail}
      onPasswordChange={setAuthPassword}
      onSubmit={submitAuth}
    />
  );

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={authUser ? <Navigate to="/editor" replace /> : authView} />
      <Route path="/editor" element={authUser ? editorView : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ScoreLoadingOverlay() {
  return (
    <div className="score-loading-overlay" aria-busy="true" aria-label="Loading score">
      <div className="score-skeleton-lines" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function BootstrapShell() {
  return (
    <main className="app-shell bootstrap-shell" aria-busy="true" aria-label="Loading SheetCraft">
      <section className="score-pane">
        <header className="topbar">
          <div className="brand-block">
            <span className="product-mark">SheetCraft</span>
            <div className="title-skeleton" aria-hidden="true" />
          </div>
        </header>
        <div className="score-paper score-skeleton">
          <div className="score-skeleton-lines">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>
      <aside className="agent-panel">
        <div className="account-skeleton" aria-hidden="true" />
        <section className="project-panel">
          <div className="project-panel-heading">
            <span>Projects</span>
          </div>
          <div className="project-list">
            <div className="project-item-skeleton" />
            <div className="project-item-skeleton" />
            <div className="project-item-skeleton" />
          </div>
        </section>
        <div className="inspector-heading">
          <div className="inspector-heading-copy">
            <span>Composer</span>
            <strong>Compose in conversation</strong>
          </div>
        </div>
        <div className="chat-thread">
          <div className="chat-skeleton" aria-hidden="true" />
          <div className="chat-skeleton short" aria-hidden="true" />
        </div>
      </aside>
    </main>
  );
}

function AuthPage(props: {
  mode: AuthMode;
  name: string;
  email: string;
  password: string;
  busy: boolean;
  error: string | null;
  onModeChange: (mode: AuthMode) => void;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const isSignUp = props.mode === "sign-up";

  return (
    <main className={`auth-page ${isSignUp ? "is-sign-up" : "is-sign-in"}`}>
      <div className="auth-page-inner">
        <section className="auth-brand" aria-label="SheetCraft">
          <Link className="auth-brand-mark" to="/">
            <span aria-hidden="true">♮</span>SheetCraft
          </Link>
          <div className="auth-brand-copy">
            <span className="auth-eyebrow">A LITTLE SPACE FOR YOUR MUSIC</span>
            <h2>Every phrase.<br />Another possibility.</h2>
            <p>Bring your ideas into focus.<br />Shape your score, one conversation at a time.</p>
          </div>
          <div className="auth-brand-staff" aria-hidden="true"><LandingScore /></div>
          <span className="auth-brand-footer">Score editing in conversation.</span>
        </section>

        <section className="auth-content" aria-label={isSignUp ? "Create account" : "Sign in"}>
          <Link className="auth-back" to="/">← Back to home</Link>
          <div className="auth-card">
            <header className="auth-heading">
              <span className="auth-eyebrow">{isSignUp ? "YOUR FIRST MEASURE" : "YOUR MUSIC IS WAITING"}</span>
              <h1>{isSignUp ? "Create your account." : "Welcome back."}</h1>
              <p>{isSignUp ? "A home for your scores and every revision." : "Sign in to pick up where you left off."}</p>
            </header>
          <form className="auth-form" onSubmit={props.onSubmit}>
            {isSignUp && (
              <label className="auth-field">
                <span>Name</span>
                <Input
                  value={props.name}
                  autoComplete="name"
                  placeholder="Your name"
                  disabled={props.busy}
                  onChange={(event) => props.onNameChange(event.target.value)}
                />
              </label>
            )}
            <label className="auth-field">
              <span>Email</span>
              <Input
                value={props.email}
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                disabled={props.busy}
                onChange={(event) => props.onEmailChange(event.target.value)}
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <Input
                value={props.password}
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                placeholder={isSignUp ? "At least 8 characters" : "Your password"}
                disabled={props.busy}
                onChange={(event) => props.onPasswordChange(event.target.value)}
              />
            </label>
            {props.error && <div className="auth-error" role="alert">{props.error}</div>}
            <Button type="submit" size="lg" disabled={props.busy || !props.email.trim() || !props.password}>
              {props.busy ? (isSignUp ? "Creating…" : "Signing in…") : isSignUp ? "Create account" : "Sign in"}
            </Button>
          </form>

          <p className="auth-switch">
            {isSignUp ? (
              <>
                Already have an account?{" "}
                <button type="button" disabled={props.busy} onClick={() => props.onModeChange("sign-in")}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                New here?{" "}
                <button type="button" disabled={props.busy} onClick={() => props.onModeChange("sign-up")}>
                  Create an account
                </button>
              </>
            )}
          </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function AccountPanel(props: {
  user: AuthUser | null;
  busy: boolean;
  onSignOut: () => void;
}) {
  if (!props.user) return null;

  return (
    <section className="account-panel signed-in">
      <div>
        <span>Account</span>
        <strong>{props.user.name || props.user.email || "Signed in"}</strong>
        {props.user.email && <small>{props.user.email}</small>}
      </div>
      <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onSignOut}>
        Sign out
      </Button>
    </section>
  );
}

function MeasureStrip(props: {
  measures: number[];
  currentMeasure: number | null;
  disabled?: boolean;
  onMeasureClick: (measureNumber: number) => void;
}) {
  return (
    <div className="measure-strip">
      {props.measures.map((measure) => {
        const current = props.currentMeasure === measure;
        return (
          <button
            type="button"
            className={current ? "measure-chip current" : "measure-chip"}
            key={measure}
            disabled={props.disabled}
            aria-current={current ? "true" : undefined}
            aria-label={`Play from measure ${measure}`}
            onClick={() => props.onMeasureClick(measure)}
          >
            {measure}
          </button>
        );
      })}
    </div>
  );
}

function exportFilename(title: string | undefined, extension: "musicxml" | "pdf" | "mid"): string {
  const sanitized = (title ?? "").replace(/[/\\:*?"<>|]/g, "").trim();
  return `${sanitized || "untitled-score"}.${extension}`;
}

function downloadMusicXml(musicxml: string, filename: string) {
  const blob = new Blob([musicxml], { type: "application/vnd.recordare.musicxml+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function selectedNoteAnchorRect(
  osmd: OpenSheetMusicDisplay | null,
  scoreContainer: HTMLElement | null,
  locator: NoteLocator
): InspectorAnchorRect | null {
  if (!osmd || !scoreContainer) return null;
  const scorePaper = scoreContainer.closest<HTMLElement>(".score-paper");
  if (!scorePaper) return null;

  const graphicalNote = findGraphicalNoteForLocator(osmd, locator);
  const target = graphicalNote ? getGraphicalNoteHighlightTarget(graphicalNote) : null;
  if (!target || !scorePaper.contains(target)) return null;

  const targetRect = target.getBoundingClientRect();
  const parentRect = scorePaper.getBoundingClientRect();
  return {
    left: targetRect.left - parentRect.left + scorePaper.scrollLeft,
    top: targetRect.top - parentRect.top + scorePaper.scrollTop,
    width: targetRect.width,
    height: targetRect.height
  };
}

type SvgBackend = {
  getSvgElement(): SVGElement;
};

function svgPageSize(svgElement: SVGElement): { width: number; height: number } {
  const width = svgElement.clientWidth || Number(svgElement.getAttribute("width")) || svgElement.getBoundingClientRect().width;
  const height = svgElement.clientHeight || Number(svgElement.getAttribute("height")) || svgElement.getBoundingClientRect().height;
  return { width, height };
}

function getBackendSvg(backend: OpenSheetMusicDisplay["Drawer"]["Backends"][number]): SVGElement {
  const getSvgElement = (backend as unknown as SvgBackend).getSvgElement;
  if (typeof getSvgElement !== "function") {
    throw new Error("SVG backend not available for PDF export.");
  }
  return getSvgElement.call(backend);
}

async function downloadScorePdf(osmd: OpenSheetMusicDisplay, filename: string) {
  const backends = osmd.Drawer.Backends;
  if (!backends.length) {
    throw new Error("No score pages available for export.");
  }

  const firstSvg = getBackendSvg(backends[0]);
  const firstSize = svgPageSize(firstSvg);
  const doc = new jsPDF({
    orientation: firstSize.height > firstSize.width ? "p" : "l",
    unit: "px",
    format: [firstSize.width, firstSize.height]
  });

  for (let index = 0; index < backends.length; index++) {
    const svgElement = getBackendSvg(backends[index]);
    const { width, height } = svgPageSize(svgElement);
    if (index > 0) {
      doc.addPage([width, height], width > height ? "l" : "p");
    }
    await doc.svg(svgElement, { x: 0, y: 0, width, height });
  }

  doc.save(filename);
}

async function createProjectFromFile(file: File): Promise<ProjectResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("title", file.name.replace(/\.(musicxml|xml|mxl)$/i, ""));
  return request<ProjectResponse>("/api/projects", { method: "POST", body: form });
}

function projectFromStreamChunk(chunk: StreamGenerateChunk & { musicxml: string; score: Score }, fallbackProject?: ProjectResponse): ProjectResponse {
  return {
    project: chunk.project ?? fallbackProject?.project ?? {
      id: "streaming",
      title: "Stream Generated Sheet",
      r2_key: null
    },
    musicxml: chunk.musicxml,
    score: chunk.score,
    assistantText: chunk.assistantText,
    validation: chunk.validation
  };
}

function scoreContext(project: ProjectResponse, noteCount: number, selectedNoteIds: string[] = []) {
  return {
    scoreTitle: project.project.title,
    measureCount: project.score.parts[0]?.measures.length ?? 0,
    noteCount,
    targetRange: scoreSelection(project, selectedNoteIds),
    selectedNotes: selectedNoteSummaries(project.score, selectedNoteIds)
  };
}

function scoreSelection(project: ProjectResponse, selectedNoteIds: string[] = []) {
  const selectedNotes = selectedNoteSummaries(project.score, selectedNoteIds);
  if (selectedNotes.length > 0) {
    const measures = selectedNotes.map((note) => note.measureNumber);
    return {
      fromMeasure: Math.min(...measures),
      toMeasure: Math.max(...measures),
      noteIds: selectedNotes.map((note) => note.id)
    };
  }

  const measures = project.score.parts[0]?.measures.map((measure) => measure.number) ?? [];
  if (!measures.length) return { fromMeasure: 1, toMeasure: 1 };
  return {
    fromMeasure: Math.min(...measures),
    toMeasure: Math.max(...measures)
  };
}

function selectedNoteSummaries(score: Score, selectedNoteIds: string[]) {
  if (!selectedNoteIds.length) return [];
  const selected = new Set(selectedNoteIds);
  const summaries: Array<Pick<NoteEvent, "id" | "measureNumber" | "startBeat" | "durationBeats" | "pitches" | "staff" | "voice">> = [];
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (!selected.has(event.id)) continue;
        summaries.push({
          id: event.id,
          measureNumber: event.measureNumber,
          startBeat: event.startBeat,
          durationBeats: event.durationBeats,
          pitches: event.pitches,
          staff: event.staff,
          voice: event.voice,
          ...(event.beam ? { beam: event.beam } : {})
        });
      }
    }
  }
  return summaries;
}

function historyForRequest(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function timelineEndBeat(timeline: PlaybackEvent[]): number {
  let endBeat = 0;
  for (const event of timeline) {
    endBeat = Math.max(endBeat, event.startBeat + event.durationBeats);
  }
  return endBeat;
}

function measureDurationBeats(measure: Pick<Measure, "durationBeats" | "timeSignature">): number {
  return measure.durationBeats ?? measure.timeSignature.beats * (4 / measure.timeSignature.beatType);
}

function measureBeatRange(score: Score, measureNumber: number): { fromBeat: number; toBeat: number } | null {
  const part = score.parts[0];
  if (!part) return null;

  let offset = 0;
  for (const measure of part.measures) {
    const length = measureDurationBeats(measure);
    if (measure.number === measureNumber) {
      return { fromBeat: offset, toBeat: offset + length };
    }
    offset += length;
  }
  return null;
}

function configureTransportLoop(transport: ReturnType<typeof Tone.getTransport>, endBeat: number, enabled: boolean) {
  if (enabled && endBeat > 0) {
    transport.loop = true;
    transport.loopStart = 0;
    transport.loopEnd = `${endBeat * transport.PPQ}i`;
    return;
  }
  transport.loop = false;
}

function clampBpm(value: number): number {
  if (!Number.isFinite(value)) return 96;
  return Math.min(240, Math.max(40, Math.round(value)));
}

function initialTempoBpm(score: Score): number {
  const firstTempo = score.parts
    .flatMap((part) => part.measures.flatMap((measure) => (measure.tempos ?? []).map((tempo) => ({ measure: measure.number, ...tempo }))))
    .sort((a, b) => a.measure - b.measure || a.startBeat - b.startBeat)[0];
  return firstTempo?.bpm ?? 96;
}

function formatProjectDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function readBootstrap(url: string, onEvent: (event: BootstrapEvent) => void): Promise<void> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  if (!response.body) throw new Error("Bootstrap response has no body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    onEvent(JSON.parse(line) as BootstrapEvent);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      dispatch(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    if (done) break;
  }
  dispatch(buffer);
}

function authUserHint(): AuthUser | null {
  try {
    const value = localStorage.getItem(AUTH_USER_HINT_KEY);
    if (!value) return null;
    const user = JSON.parse(value) as Partial<AuthUser>;
    if (typeof user.id !== "string" || !user.id) return null;
    return {
      id: user.id,
      name: typeof user.name === "string" ? user.name : null,
      email: typeof user.email === "string" ? user.email : null
    };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function authErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "Authentication failed.";
  const record = error as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
  const message =
    stringValue(record.message) ??
    stringValue(record.statusText) ??
    stringValue(record.code) ??
    stringValue(nested?.message) ??
    stringValue(nested?.code);
  return message || "Authentication failed.";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

createRoot(document.getElementById("root")!).render(<App />);
