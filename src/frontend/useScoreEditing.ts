import { ScoreSaveQueue } from "./scoreSaveQueue";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { GraphicalNote, OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { applyOperations, exportMusicXML, introducedBlockingValidationReason, transposePitch, validateScore } from "../shared";
import type { BeamMark, NoteEvent, PhraseMark, Pitch, Score, ScoreOperation } from "../shared";
import {
  BEAT_EPSILON,
  buildChordAddOperation,
  clickToOsmdPoint,
  DURATION_BY_KEY,
  DURATION_OPTIONS,
  effectiveStaff,
  effectiveVoice,
  eventFitsInMeasure,
  eventsOverlappingInterval,
  findFreeVoiceForInsert,
  findGraphicalNoteAtClientPoint,
  findNoteEvent,
  findNoteEventAtBeat,
  findNoteEventById,
  graphicalNoteToLocator,
  highlightNoteEvents,
  hasPitchedEventStartingAtBeat,
  highlightSelectedNote,
  inferInsertStartBeatFromClick,
  isEditableTarget,
  locateBlankClick,
  maxInsertDurationAtBeat,
  measureCapacityBeats,
  pitchesEqual,
  replacePitchWithoutDuplicates,
  selectedGraphicalNotesInClientRect,
  sortPitchesByMidi,
  pitchFromStaffPosition,
  type BlankClickTarget,
  type NoteLocator
} from "./scoreEditingUtils";

type ProjectResponse = {
  project: { id: string; title?: string; r2_key?: string | null };
  musicxml: string;
  score: Score;
  validation?: { valid: boolean; errors: string[]; warnings: string[] };
};

export type SelectedNoteState = {
  noteId: string;
  measureNumber: number;
  startBeat: number;
  durationBeats: number;
  measureCapacityBeats: number;
  staff: number;
  voice: number;
  tie?: PhraseMark;
  slur?: PhraseMark;
  beam?: BeamMark;
  /** All sounding pitches for this event. Empty for rests. */
  pitches: Pitch[];
  /** The chord tone currently being edited. Omitted for rests. */
  pitch?: Pitch;
  locator: NoteLocator;
};

type UseScoreEditingOptions = {
  busy?: boolean;
  project: ProjectResponse | null;
  setProject: React.Dispatch<React.SetStateAction<ProjectResponse | null>>;
  setEditError: (message: string | null) => void;
  osmdRef: React.RefObject<OpenSheetMusicDisplay | null>;
  scoreRef: React.RefObject<HTMLDivElement | null>;
};

const MAX_CLICK_TOLERANCE_PX = 16;
const SINGLE_CLICK_DELAY_MS = 250;
const MIN_DRAG_SELECTION_PX = 4;

type ScoreClickPoint = {
  clientX: number;
  clientY: number;
};

type SelectionBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CommitOptions = {
  clearSelection?: boolean;
  resyncNoteId?: string;
  resyncLocator?: NoteLocator;
};

export function useScoreEditing({ project, setProject, setEditError, osmdRef, scoreRef, busy }: UseScoreEditingOptions) {
  const [selectedNote, setSelectedNote] = useState<SelectedNoteState | null>(null);
  const [chordToneTargetId, setChordToneTargetId] = useState<string | null>(null);
  const [contextSelectedNoteIds, setContextSelectedNoteIds] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const projectRef = useRef<ProjectResponse | null>(project);
  const selectedNoteRef = useRef<SelectedNoteState | null>(null);
  const selectedLocatorRef = useRef<NoteLocator | null>(null);
  const selectedGraphicalNoteRef = useRef<GraphicalNote | null>(null);
  const contextSelectedGraphicalNotesRef = useRef<Map<string, GraphicalNote>>(new Map());
  const contextSelectedNoteIdsRef = useRef<string[]>([]);
  const selectedPitchesRef = useRef<Pitch[]>([]);
  const pendingRequestRef = useRef(0);
  const saveQueueRef = useRef(new ScoreSaveQueue());
  const selectionVersionRef = useRef(0);
  const pendingClickRef = useRef<number | null>(null);
  const ignoreDoubleClickUntilRef = useRef(0);
  const dragStartRef = useRef<{ clientX: number; clientY: number; localX: number; localY: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressSelectionUntilRef = useRef(0);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const clearSelection = useCallback(() => {
    selectionVersionRef.current += 1;
    selectedLocatorRef.current = null;
    selectedGraphicalNoteRef.current = null;
    selectedPitchesRef.current = [];
    contextSelectedGraphicalNotesRef.current = new Map();
    contextSelectedNoteIdsRef.current = [];
    selectedNoteRef.current = null;
    setSelectedNote(null);
    setChordToneTargetId(null);
    setContextSelectedNoteIds([]);
    setSelectionBox(null);
    highlightSelectedNote(osmdRef.current, scoreRef.current, null);
  }, [osmdRef, scoreRef]);

  const reapplyHighlight = useCallback(() => {
    const contextIds = contextSelectedNoteIdsRef.current;
    if (project && contextIds.length > 0) {
      const selectedEvents = contextIds
        .map((noteId) => findNoteEventById(project.score, noteId))
        .filter((event): event is NonNullable<typeof event> => Boolean(event));
      highlightNoteEvents(osmdRef.current, scoreRef.current, selectedEvents, contextSelectedGraphicalNotesRef.current);
      return;
    }
    highlightSelectedNote(
      osmdRef.current,
      scoreRef.current,
      selectedLocatorRef.current,
      selectedGraphicalNoteRef.current,
      selectedChordPitches(selectedPitchesRef.current)
    );
  }, [osmdRef, project, scoreRef]);

  const clearContextSelection = useCallback(() => {
    contextSelectedGraphicalNotesRef.current = new Map();
    contextSelectedNoteIdsRef.current = [];
    setContextSelectedNoteIds([]);
    setSelectionBox(null);
    highlightSelectedNote(
      osmdRef.current,
      scoreRef.current,
      selectedLocatorRef.current,
      selectedGraphicalNoteRef.current,
      selectedChordPitches(selectedPitchesRef.current)
    );
  }, [osmdRef, scoreRef]);

  const syncSelectedFromScore = useCallback(
    (score: Score, noteId: string, preferredPitch?: Pitch) => {
      const event = findNoteEventById(score, noteId);
      if (!event) {
        clearSelection();
        return;
      }

      const previousLocator = selectedLocatorRef.current;
      const focusedPitch = resolveFocusedPitch(event.pitches, preferredPitch ?? previousLocator?.pitch, selectedPitchesRef.current);
      const locator: NoteLocator = {
        measureNumber: event.measureNumber,
        startBeat: event.startBeat,
        ...(event.staff ? { staff: event.staff } : {}),
        ...(focusedPitch ? { pitch: focusedPitch } : {})
      };
      selectedLocatorRef.current = locator;
      selectedGraphicalNoteRef.current = null;
      const nextSelected = buildSelectedNoteState(score, event, locator, focusedPitch);
      selectedPitchesRef.current = nextSelected.pitches;
      selectedNoteRef.current = nextSelected;
      setSelectedNote(nextSelected);
      requestAnimationFrame(() => {
        reapplyHighlight();
      });
    },
    [clearSelection, reapplyHighlight]
  );

  const resyncSelectionAfterEdit = useCallback(
    (score: Score, options?: CommitOptions) => {
      if (options?.clearSelection) {
        clearSelection();
        return;
      }

      const preferredPitch = options?.resyncLocator?.pitch;

      if (options?.resyncNoteId) {
        const byId = findNoteEventById(score, options.resyncNoteId);
        if (byId) {
          syncSelectedFromScore(score, byId.id, preferredPitch);
          return;
        }
      }

      const locator = options?.resyncLocator ?? selectedLocatorRef.current;
      if (locator) {
        const byLocator = findNoteEvent(score, locator);
        if (byLocator) {
          syncSelectedFromScore(score, byLocator.id, preferredPitch ?? locator.pitch);
          return;
        }

        const byBeat = findNoteEventAtBeat(score, locator.measureNumber, locator.startBeat, locator.staff);
        if (byBeat) {
          syncSelectedFromScore(score, byBeat.id, preferredPitch ?? locator.pitch);
        }
      }
    },
    [clearSelection, syncSelectedFromScore]
  );

  const markSelectionEditSettled = useCallback(() => {
    suppressSelectionUntilRef.current = Date.now() + 350;
  }, []);

  const persistScore = useCallback(
    async (previousProject: ProjectResponse, nextScore: Score, options?: CommitOptions) => {
      if (previousProject.project.id === "streaming") return;

      const requestId = pendingRequestRef.current + 1;
      pendingRequestRef.current = requestId;
      const selectionVersion = selectionVersionRef.current;

      try {
        const payload = await saveQueueRef.current.save(previousProject, exportMusicXML(nextScore));
        if (pendingRequestRef.current !== requestId) return;
        if (projectRef.current?.project.id !== previousProject.project.id) return;

        const persistedProject = {
          ...previousProject,
          project: payload.project,
          validation: payload.validation,
          score: payload.score,
          musicxml: payload.musicxml
        };
        setProject((current) => {
          if (!current || current.project.id !== previousProject.project.id) return current;
          if (current.musicxml === payload.musicxml) {
            const next = {
              ...current,
              project: payload.project,
              validation: payload.validation,
              score: payload.score
            };
            projectRef.current = next;
            return next;
          }
          projectRef.current = persistedProject;
          return persistedProject;
        });
        if (options?.clearSelection) {
          clearSelection();
        } else if (selectionVersionRef.current !== selectionVersion) {
          return;
        } else {
          resyncSelectionAfterEdit(payload.score, options);
        }
      } catch (error) {
        if (pendingRequestRef.current !== requestId) return;
        if (projectRef.current?.project.id !== previousProject.project.id) return;
        const restored = saveQueueRef.current.confirmed(previousProject.project.id) ?? previousProject;
        projectRef.current = restored;
        setProject(restored);
        const activeSelectedNote = selectedNoteRef.current;
        if (activeSelectedNote?.noteId) {
          syncSelectedFromScore(restored.score, activeSelectedNote.noteId);
        }
        setEditError(error instanceof Error ? error.message : "Failed to save edit.");
      }
    },
    [resyncSelectionAfterEdit, setEditError, setProject, syncSelectedFromScore]
  );

  const commitScoreChange = useCallback(
    (operations: ScoreOperation[], options?: CommitOptions) => {
      const currentProject = projectRef.current;
      if (!currentProject || busy) return;

      const previousProject = currentProject;
      const previousValidation = validateScore(previousProject.score);
      const nextScore = applyOperations(previousProject.score, operations);
      const validation = validateScore(nextScore);
      const blockingIssue = introducedBlockingValidationReason(previousValidation, validation);
      if (blockingIssue) {
        setEditError(blockingIssue);
        return;
      }

      let nextMusicxml: string;
      try {
        nextMusicxml = exportMusicXML(nextScore);
      } catch (error) {
        setEditError(error instanceof Error ? error.message : "This edit could not be exported safely.");
        return;
      }
      const nextProject = { ...previousProject, score: nextScore, musicxml: nextMusicxml };
      projectRef.current = nextProject;
      setProject(nextProject);

      if (options?.clearSelection) {
        clearSelection();
      } else {
        resyncSelectionAfterEdit(nextScore, options);
        markSelectionEditSettled();
      }

      void persistScore(previousProject, nextScore, options);
    },
    [busy, clearSelection, markSelectionEditSettled, persistScore, resyncSelectionAfterEdit, setEditError, setProject]
  );

  const applyOperation = useCallback(
    (operation: ScoreOperation, options?: { clearSelection?: boolean; resyncPitch?: Pitch }) => {
      const activeProject = projectRef.current;
      const activeSelectedNote = selectedNoteRef.current;
      let resolvedOperation = operation;
      if (
        activeProject &&
        (operation.type === "update_note" || operation.type === "delete_note") &&
        !findNoteEventById(activeProject.score, operation.noteId) &&
        selectedLocatorRef.current
      ) {
        const event =
          findNoteEvent(activeProject.score, selectedLocatorRef.current) ??
          findNoteEventAtBeat(
            activeProject.score,
            selectedLocatorRef.current.measureNumber,
            selectedLocatorRef.current.startBeat,
            selectedLocatorRef.current.staff
          );
        if (event) resolvedOperation = { ...operation, noteId: event.id };
      }

      const noteId = resolvedOperation.type === "update_note" || resolvedOperation.type === "delete_note" ? resolvedOperation.noteId : activeSelectedNote?.noteId;
      const resyncPitch = options?.resyncPitch ?? activeSelectedNote?.pitch;
      const splitPitch =
        resolvedOperation.type === "update_note" && resolvedOperation.params.splitPitch && resolvedOperation.params.voice !== undefined
          ? resolvedOperation.params.splitPitch
          : undefined;

      commitScoreChange([resolvedOperation], {
        clearSelection: options?.clearSelection,
        ...(splitPitch && activeSelectedNote && !options?.clearSelection
          ? {
              resyncLocator: {
                measureNumber: activeSelectedNote.measureNumber,
                startBeat: activeSelectedNote.startBeat,
                staff: activeSelectedNote.staff,
                pitch: splitPitch
              }
            }
          : noteId && !options?.clearSelection && activeSelectedNote
            ? {
                resyncNoteId: noteId,
                resyncLocator: {
                  measureNumber: activeSelectedNote.measureNumber,
                  startBeat: activeSelectedNote.startBeat,
                  staff: activeSelectedNote.staff,
                  ...(resyncPitch ? { pitch: resyncPitch } : {})
                }
              }
            : {})
      });
    },
    [commitScoreChange]
  );

  const beginChordToneAdd = useCallback(() => {
    if (!selectedNote?.pitch) return;
    setChordToneTargetId(selectedNote.noteId);
  }, [selectedNote?.noteId, selectedNote?.pitch]);

  const cancelChordToneAdd = useCallback(() => {
    setChordToneTargetId(null);
  }, []);

  const addChordToneAtClick = useCallback(
    (event: MouseEvent<HTMLDivElement>): boolean => {
      if (!project || !selectedNote || chordToneTargetId !== selectedNote.noteId) return false;

      ignoreDoubleClickUntilRef.current = Date.now() + SINGLE_CLICK_DELAY_MS + 100;

      const osmd = osmdRef.current;
      const container = scoreRef.current;
      if (!osmd || !container) return true;

      const clickPoint = clickToOsmdPoint(event, container, osmd.zoom);
      if (!clickPoint) return true;

      const target = locateBlankClick(osmd, clickPoint);
      if (!target) {
        setEditError("Click a staff position to add the chord tone.");
        return true;
      }

      if (target.staff !== selectedNote.staff || target.measureNumber !== selectedNote.measureNumber) {
        setEditError("Add chord tones on the selected note's staff and measure.");
        return true;
      }

      const measure = project.score.parts[0]?.measures.find((candidate) => candidate.number === target.measureNumber);
      if (!measure) return true;

      const noteEvent = findNoteEventById(project.score, selectedNote.noteId);
      if (!noteEvent || noteEvent.pitches.length === 0) {
        setChordToneTargetId(null);
        setEditError("Select a note before adding a chord tone.");
        return true;
      }

      const pitch = pitchFromStaffPosition(target.staff, target.halfSpacesFromTopLine, measure.key?.fifths ?? 0);
      if (noteEvent.pitches.some((candidate) => pitchesEqual(candidate, pitch))) {
        setEditError("That chord tone already exists.");
        return true;
      }

      setChordToneTargetId(null);
      commitScoreChange([{ type: "update_note", noteId: noteEvent.id, params: { pitches: [...noteEvent.pitches, pitch] } }], {
        resyncNoteId: noteEvent.id,
        resyncLocator: {
          measureNumber: selectedNote.measureNumber,
          startBeat: selectedNote.startBeat,
          staff: selectedNote.staff,
          pitch
        }
      });
      return true;
    },
    [chordToneTargetId, commitScoreChange, osmdRef, project, scoreRef, selectedNote, setEditError]
  );

  const insertAtBlankClick = useCallback(
    (target: BlankClickTarget, kind: "note" | "rest") => {
      if (!project) return;

      const osmd = osmdRef.current;
      if (!osmd) return;

      const part = project.score.parts[0];
      const measure = part?.measures.find((candidate) => candidate.number === target.measureNumber);
      if (!measure) return;

      const capacity = measureCapacityBeats(measure);
      let startBeat = inferInsertStartBeatFromClick(osmd, measure, target.staff, 1, target.osmdX);
      let durationBeats = maxInsertDurationAtBeat(measure.events, target.staff, 1, startBeat, capacity);
      if (durationBeats < 0.25 - BEAT_EPSILON) {
        setEditError("This measure is full.");
        return;
      }

      let voice = findFreeVoiceForInsert(measure.events, target.staff, startBeat, durationBeats);
      if (voice === null) {
        setEditError("That beat is already occupied.");
        return;
      }

      startBeat = inferInsertStartBeatFromClick(osmd, measure, target.staff, voice, target.osmdX);
      durationBeats = maxInsertDurationAtBeat(measure.events, target.staff, voice, startBeat, capacity);
      if (durationBeats < 0.25 - BEAT_EPSILON || !eventFitsInMeasure(startBeat, durationBeats, measure)) {
        setEditError("This measure is full.");
        return;
      }

      voice = findFreeVoiceForInsert(measure.events, target.staff, startBeat, durationBeats);
      if (voice === null) {
        setEditError("That beat is already occupied.");
        return;
      }

      const pitch =
        kind === "note" ? pitchFromStaffPosition(target.staff, target.halfSpacesFromTopLine, measure.key?.fifths ?? 0) : undefined;

      if (pitch && hasPitchedEventStartingAtBeat(measure.events, target.staff, voice, startBeat)) {
        const chordOp = buildChordAddOperation(measure.events, target.staff, voice, startBeat, pitch);
        if (!chordOp) {
          setEditError("That note already exists.");
          return;
        }
        commitScoreChange([chordOp], {
          resyncNoteId: chordOp.noteId,
          resyncLocator: {
            measureNumber: target.measureNumber,
            startBeat,
            staff: target.staff,
            pitch
          }
        });
        return;
      }

      const overlapping = eventsOverlappingInterval(measure.events, target.staff, voice, startBeat, durationBeats);
      if (kind === "rest" && overlapping.some((event) => event.pitches.length > 0)) {
        setEditError("That beat is already occupied.");
        return;
      }

      const operations: ScoreOperation[] = [
        ...overlapping.filter((event) => event.pitches.length === 0).map((rest): ScoreOperation => ({ type: "delete_note", noteId: rest.id })),
        kind === "note"
          ? {
              type: "insert_note",
              measureNumber: target.measureNumber,
              params: { startBeat, durationBeats, pitch: pitch!, staff: target.staff, voice }
            }
          : {
              type: "insert_rest",
              measureNumber: target.measureNumber,
              params: { startBeat, durationBeats, staff: target.staff, voice }
            }
      ];

      const resyncLocator: NoteLocator = {
        measureNumber: target.measureNumber,
        startBeat,
        staff: target.staff,
        ...(pitch ? { pitch } : {})
      };
      commitScoreChange(operations, { resyncLocator });
    },
    [commitScoreChange, osmdRef, project, setEditError]
  );

  const selectNoteAtClick = useCallback(
    (click: ScoreClickPoint) => {
      const osmd = osmdRef.current;
      const container = scoreRef.current;
      if (!osmd || !container || !project) return;

      const graphicalNote = findGraphicalNoteAtClientPoint(
        osmd,
        container,
        click.clientX,
        click.clientY,
        MAX_CLICK_TOLERANCE_PX * osmd.zoom
      );
      if (!graphicalNote) {
        clearSelection();
        return;
      }

      const locator = graphicalNoteToLocator(graphicalNote);
      if (!locator) {
        clearSelection();
        return;
      }

      const noteEvent = findNoteEvent(project.score, locator);
      if (!noteEvent) {
        clearSelection();
        return;
      }

      selectedLocatorRef.current = locator;
      selectedGraphicalNoteRef.current = graphicalNote;
      contextSelectedGraphicalNotesRef.current = new Map();
      contextSelectedNoteIdsRef.current = [];
      setContextSelectedNoteIds([]);
      const focusedPitch = resolveFocusedPitch(noteEvent.pitches, locator.pitch);
      const nextLocator = { ...locator, ...(focusedPitch ? { pitch: focusedPitch } : {}) };
      const nextSelected = buildSelectedNoteState(project.score, noteEvent, nextLocator, focusedPitch);
      selectedPitchesRef.current = nextSelected.pitches;
      selectedNoteRef.current = nextSelected;
      setSelectedNote(nextSelected);
      highlightSelectedNote(osmd, container, nextLocator, graphicalNote, selectedChordPitches(nextSelected.pitches));
    },
    [clearSelection, osmdRef, project, scoreRef]
  );

  const handleScoreClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }
      if (addChordToneAtClick(event)) {
        if (pendingClickRef.current) {
          window.clearTimeout(pendingClickRef.current);
          pendingClickRef.current = null;
        }
        return;
      }
      if (Date.now() < suppressSelectionUntilRef.current) return;
      if (pendingClickRef.current) window.clearTimeout(pendingClickRef.current);
      const click = { clientX: event.clientX, clientY: event.clientY };
      pendingClickRef.current = window.setTimeout(() => {
        pendingClickRef.current = null;
        selectNoteAtClick(click);
      }, SINGLE_CLICK_DELAY_MS);
    },
    [addChordToneAtClick, selectNoteAtClick]
  );

  const handleScoreMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!event.shiftKey || event.button !== 0 || !scoreRef.current || !project) return;
      const rect = scoreRef.current.getBoundingClientRect();
      dragStartRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        localX: event.clientX - rect.left,
        localY: event.clientY - rect.top
      };
      suppressNextClickRef.current = true;
      setSelectionBox({ left: event.clientX - rect.left, top: event.clientY - rect.top, width: 0, height: 0 });
      event.preventDefault();
    },
    [project, scoreRef]
  );

  const handleScoreMouseMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      const container = scoreRef.current;
      if (!start || !container) return;
      const rect = container.getBoundingClientRect();
      const currentX = event.clientX - rect.left;
      const currentY = event.clientY - rect.top;
      setSelectionBox(selectionBoxFromPoints(start.localX, start.localY, currentX, currentY));
      event.preventDefault();
    },
    [scoreRef]
  );

  const handleScoreMouseUp = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (!start || !project) return;
      const osmd = osmdRef.current;
      const container = scoreRef.current;
      if (!osmd || !container) {
        setSelectionBox(null);
        return;
      }

      const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
      if (moved < MIN_DRAG_SELECTION_PX) {
        setSelectionBox(null);
        return;
      }

      const clientRect = clientRectFromPoints(start.clientX, start.clientY, event.clientX, event.clientY);
      const selected = selectedGraphicalNotesInClientRect(osmd, project.score, clientRect);
      const graphicalNotesByEventId = new Map(selected.map((entry) => [entry.event.id, entry.graphicalNote]));
      selectedLocatorRef.current = null;
      selectedGraphicalNoteRef.current = null;
      selectedNoteRef.current = null;
      setSelectedNote(null);
      setChordToneTargetId(null);
      contextSelectedGraphicalNotesRef.current = graphicalNotesByEventId;
      contextSelectedNoteIdsRef.current = selected.map((entry) => entry.event.id);
      setContextSelectedNoteIds(contextSelectedNoteIdsRef.current);
      highlightNoteEvents(osmd, container, selected.map((entry) => entry.event), graphicalNotesByEventId);
      setSelectionBox(null);
      event.preventDefault();
    },
    [osmdRef, project, scoreRef]
  );

  const handleScoreDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (ignoreDoubleClickUntilRef.current > Date.now()) {
        ignoreDoubleClickUntilRef.current = 0;
        return;
      }
      if (chordToneTargetId) return;
      if (pendingClickRef.current) {
        window.clearTimeout(pendingClickRef.current);
        pendingClickRef.current = null;
      }

      const osmd = osmdRef.current;
      const container = scoreRef.current;
      if (!osmd || !container || !project) return;

      const clickPoint = clickToOsmdPoint(event, container, osmd.zoom);
      if (!clickPoint) return;

      const graphicalNote = findGraphicalNoteAtClientPoint(
        osmd,
        container,
        event.clientX,
        event.clientY,
        MAX_CLICK_TOLERANCE_PX * osmd.zoom
      );
      if (graphicalNote) {
        return;
      }

      const blankTarget = locateBlankClick(osmd, clickPoint);
      if (blankTarget) {
        insertAtBlankClick(blankTarget, event.shiftKey ? "rest" : "note");
      }
    },
    [chordToneTargetId, insertAtBlankClick, osmdRef, project, scoreRef]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!project || !selectedNote) return;

      const keyFifths = project.score.parts[0]?.measures.find((measure) => measure.number === selectedNote.measureNumber)?.key?.fifths ?? 0;

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        if (!selectedNote.pitch || selectedNote.pitches.length === 0) return;
        const semitones = event.shiftKey ? (event.key === "ArrowUp" ? 12 : -12) : event.key === "ArrowUp" ? 1 : -1;
        const nextPitch = transposePitch(selectedNote.pitch, semitones, keyFifths);
        applyOperation({
          type: "update_note",
          noteId: selectedNote.noteId,
          params: {
            pitches: replacePitchWithoutDuplicates(selectedNote.pitches, selectedNote.pitch, nextPitch)
          }
        }, { resyncPitch: nextPitch });
        return;
      }

      if (event.key in DURATION_BY_KEY) {
        event.preventDefault();
        applyOperation({
          type: "update_note",
          noteId: selectedNote.noteId,
          params: { durationBeats: DURATION_BY_KEY[event.key], reflowFollowing: true }
        });
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (selectedNote.pitches.length > 1 && selectedNote.pitch) {
          applyOperation({
            type: "update_note",
            noteId: selectedNote.noteId,
            params: {
              pitches: selectedNote.pitches.filter((candidate) => !pitchesEqual(candidate, selectedNote.pitch!))
            }
          });
          return;
        }
        applyOperation({ type: "delete_note", noteId: selectedNote.noteId }, { clearSelection: true });
      }
    },
    [applyOperation, project, selectedNote]
  );

  useEffect(() => {
    contextSelectedNoteIdsRef.current = contextSelectedNoteIds;
  }, [contextSelectedNoteIds]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const focusChordPitch = useCallback(
    (pitch: Pitch) => {
      setSelectedNote((current) => {
        if (!current || current.pitches.length === 0 || !current.pitches.some((candidate) => pitchesEqual(candidate, pitch))) {
          return current;
        }

        const locator: NoteLocator = {
          ...current.locator,
          pitch
        };
        selectedLocatorRef.current = locator;
        const nextSelected = { ...current, pitch, locator };
        selectedNoteRef.current = nextSelected;
        requestAnimationFrame(() => {
          highlightSelectedNote(
            osmdRef.current,
            scoreRef.current,
            locator,
            undefined,
            selectedChordPitches(current.pitches)
          );
        });
        selectedPitchesRef.current = current.pitches;
        return nextSelected;
      });
    },
    [osmdRef, scoreRef]
  );

  useEffect(() => {
    if (!project) {
      clearSelection();
      return;
    }
    clearSelection();
  }, [clearSelection, project?.project.id]);

  return {
    waitForSaves: (projectId: string) => saveQueueRef.current.flush(projectId),
    selectedNote,
    chordToneMode: chordToneTargetId === selectedNote?.noteId,
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
    clearSelection,
    focusChordPitch,
    reapplyHighlight
  };
}

function selectionBoxFromPoints(startX: number, startY: number, endX: number, endY: number): SelectionBox {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  };
}

function clientRectFromPoints(startX: number, startY: number, endX: number, endY: number): DOMRect {
  return new DOMRect(Math.min(startX, endX), Math.min(startY, endY), Math.abs(endX - startX), Math.abs(endY - startY));
}

function selectedChordPitches(pitches: Pitch[]): Pitch[] | undefined {
  return pitches.length > 1 ? pitches : undefined;
}

function buildSelectedNoteState(score: Score, event: NoteEvent, locator: NoteLocator, focusedPitch?: Pitch): SelectedNoteState {
  const measure = score.parts[0]?.measures.find((candidate) => candidate.number === event.measureNumber);
  const pitches = sortPitchesByMidi(event.pitches);
  const pitch = event.pitches.length > 0 ? resolveFocusedPitch(pitches, focusedPitch ?? locator.pitch) : undefined;

  return {
    noteId: event.id,
    measureNumber: event.measureNumber,
    startBeat: event.startBeat,
    durationBeats: event.durationBeats,
    measureCapacityBeats: measure ? measureCapacityBeats(measure) : 4,
    staff: effectiveStaff(event),
    voice: effectiveVoice(event),
    pitches,
    ...(event.tie ? { tie: event.tie } : {}),
    ...(event.slur ? { slur: event.slur } : {}),
    ...(event.beam ? { beam: event.beam } : {}),
    ...(pitch ? { pitch } : {}),
    locator: {
      ...locator,
      ...(pitch ? { pitch } : {})
    }
  };
}

function resolveFocusedPitch(pitches: Pitch[], preferred?: Pitch, previousPitches?: Pitch[]): Pitch | undefined {
  if (pitches.length === 0) return undefined;
  if (preferred && pitches.some((candidate) => pitchesEqual(candidate, preferred))) return preferred;
  if (preferred && previousPitches?.length) {
    const sortedPrevious = sortPitchesByMidi(previousPitches);
    const sortedNext = sortPitchesByMidi(pitches);
    const index = sortedPrevious.findIndex((candidate) => pitchesEqual(candidate, preferred));
    if (index >= 0 && index < sortedNext.length) return sortedNext[index];
  }
  return sortPitchesByMidi(pitches)[0];
}

export function durationLabel(durationBeats: number): string {
  const option = DURATION_OPTIONS.find((candidate) => Math.abs(candidate.value - durationBeats) < BEAT_EPSILON);
  if (option) return option.label;
  const match = Object.entries(DURATION_BY_KEY).find(([, beats]) => Math.abs(beats - durationBeats) < BEAT_EPSILON);
  if (!match) return `${durationBeats} beats`;
  const labels: Record<string, string> = { "3": "16th", "4": "8th", "5": "Quarter", "6": "Half", "7": "Whole" };
  return labels[match[0]] ?? `${durationBeats} beats`;
}
