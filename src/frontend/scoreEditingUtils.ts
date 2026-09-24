import type { MouseEvent } from "react";
import { AccidentalEnum, GraphicalNote, NoteEnum, OpenSheetMusicDisplay, Pitch as OsmdPitch, PointF2D } from "opensheetmusicdisplay";
import { pitchToMidi, pitchToToneName } from "../shared/operations";
import type { Measure, NoteEvent, Pitch, Score, ScoreOperation, Step } from "../shared/types";

export const BEAT_EPSILON = 0.001;
export const HIGHLIGHT_CLASS = "score-note-selected";
export const CHORD_TONE_HIGHLIGHT_CLASS = "score-note-chord-tone";

export const DURATION_BY_KEY: Record<string, number> = {
  "3": 0.25,
  "4": 0.5,
  "5": 1,
  "6": 2,
  "7": 4
};

export const DURATION_OPTIONS = [
  { label: "16th", value: 0.25 },
  { label: "Dotted 16th", value: 0.375 },
  { label: "8th", value: 0.5 },
  { label: "Dotted 8th", value: 0.75 },
  { label: "Quarter", value: 1 },
  { label: "Dotted quarter", value: 1.5 },
  { label: "Half", value: 2 },
  { label: "Dotted half", value: 3 },
  { label: "Whole", value: 4 }
] as const;

export type NoteLocator = {
  measureNumber: number;
  startBeat: number;
  staff?: number;
  /** Undefined means the target is a rest. */
  pitch?: Pitch;
};

type TimestampLike = { RealValue: number };
type GraphicalNoteWithSvg = GraphicalNote & {
  getSVGGElement?: () => SVGGElement | string | null;
  getSVGId?: () => string;
  vfnoteIndex?: number;
};
type UpdateNoteOperation = Extract<ScoreOperation, { type: "update_note" }>;

const NOTE_ENUM_TO_STEP: Record<number, Step> = {
  [NoteEnum.C]: "C",
  [NoteEnum.D]: "D",
  [NoteEnum.E]: "E",
  [NoteEnum.F]: "F",
  [NoteEnum.G]: "G",
  [NoteEnum.A]: "A",
  [NoteEnum.B]: "B"
};

export function beatsNear(left: number, right: number): boolean {
  return Math.abs(left - right) <= BEAT_EPSILON;
}

export function pitchesEqual(left: Pitch, right: Pitch): boolean {
  return left.step === right.step && left.octave === right.octave && (left.alter ?? 0) === (right.alter ?? 0);
}

export function replacePitchWithoutDuplicates(pitches: Pitch[], from: Pitch, to: Pitch): Pitch[] {
  const next: Pitch[] = [];
  for (const candidate of pitches) {
    const pitch = pitchesEqual(candidate, from) ? to : candidate;
    if (!next.some((existing) => pitchesEqual(existing, pitch))) next.push(pitch);
  }
  return next;
}

export function osmdTimestampToStartBeat(timestamp: TimestampLike): number {
  // OSMD Fraction RealValue is in whole notes; project startBeat uses quarter-note beats (see musicxml.ts).
  return timestamp.RealValue * 4;
}

export function osmdPitchToScorePitch(pitch: OsmdPitch): Pitch {
  const step = NOTE_ENUM_TO_STEP[pitch.FundamentalNote] ?? "C";
  const alter = osmdAlterFromAccidental(pitch.Accidental);
  // OSMD stores octaves shifted down by OctaveXmlDifference (3) relative to MusicXML.
  const octave = pitch.Octave + OsmdPitch.OctaveXmlDifference;
  return { step, octave, ...(alter ? { alter } : {}) };
}

function osmdAlterFromAccidental(accidental: AccidentalEnum): number | undefined {
  const halfTones = OsmdPitch.HalfTonesFromAccidental(accidental);
  if (halfTones === 0) return undefined;
  return halfTones;
}

export function measureCapacityBeats(measure: Pick<Measure, "durationBeats" | "timeSignature">): number {
  return measure.durationBeats ?? measure.timeSignature.beats * (4 / measure.timeSignature.beatType);
}

export function eventFitsInMeasure(
  startBeat: number,
  durationBeats: number,
  measure: Pick<Measure, "durationBeats" | "timeSignature">
): boolean {
  const capacity = measureCapacityBeats(measure);
  return (
    startBeat >= -BEAT_EPSILON &&
    durationBeats >= 0.25 - BEAT_EPSILON &&
    startBeat + durationBeats <= capacity + BEAT_EPSILON
  );
}

export function effectiveStaff(event: NoteEvent): number {
  if (event.staff) return event.staff;
  const lowest = event.pitches[0];
  if (!lowest) return 1;
  return pitchToMidi(lowest) < 60 ? 2 : 1;
}

export function effectiveVoice(event: NoteEvent): number {
  return event.voice ?? 1;
}

export function eventsOverlappingInterval(
  events: NoteEvent[],
  staff: number,
  voice: number,
  startBeat: number,
  durationBeats: number
): NoteEvent[] {
  return events.filter(
    (event) =>
      effectiveStaff(event) === staff &&
      effectiveVoice(event) === voice &&
      event.startBeat < startBeat + durationBeats - BEAT_EPSILON &&
      event.startBeat + event.durationBeats > startBeat + BEAT_EPSILON
  );
}

/** Pick the lowest-numbered voice on this staff with no note collision at [startBeat, startBeat + duration). */
export function findFreeVoiceForInsert(events: NoteEvent[], staff: number, startBeat: number, durationBeats: number): number | null {
  for (const voice of [1, 2, 3, 4]) {
    const overlapping = eventsOverlappingInterval(events, staff, voice, startBeat, durationBeats);
    if (!overlapping.some((event) => event.pitches.length > 0)) return voice;
  }
  return null;
}

/** When every voice is rhythmically blocked, allow adding a chord tone at the exact same beat. */
export function buildChordAddOperation(
  events: NoteEvent[],
  staff: number,
  voice: number,
  startBeat: number,
  pitch: Pitch
): UpdateNoteOperation | null {
  const atBeat = events.find(
    (event) =>
      effectiveStaff(event) === staff &&
      effectiveVoice(event) === voice &&
      beatsNear(event.startBeat, startBeat) &&
      event.pitches.length > 0
  );
  if (!atBeat || atBeat.pitches.some((p) => pitchesEqual(p, pitch))) return null;

  const spanning = eventsOverlappingInterval(events, staff, voice, startBeat, atBeat.durationBeats).filter(
    (event) => event.pitches.length > 0 && !beatsNear(event.startBeat, startBeat)
  );
  if (spanning.length > 0) return null;

  return {
    type: "update_note",
    noteId: atBeat.id,
    params: { pitches: [...atBeat.pitches, pitch] }
  };
}

export function hasPitchedEventStartingAtBeat(events: NoteEvent[], staff: number, voice: number, startBeat: number): boolean {
  return events.some(
    (event) => effectiveStaff(event) === staff && effectiveVoice(event) === voice && beatsNear(event.startBeat, startBeat) && event.pitches.length > 0
  );
}

export function findNoteEvent(score: Score, locator: NoteLocator): NoteEvent | undefined {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      if (measure.number !== locator.measureNumber) continue;
      for (const event of measure.events) {
        if (!beatsNear(event.startBeat, locator.startBeat)) continue;
        // Rests without an explicit staff can't be inferred from pitch, so don't enforce staff for them.
        const skipStaffCheck = event.pitches.length === 0 && event.staff === undefined;
        if (!skipStaffCheck && locator.staff !== undefined && effectiveStaff(event) !== locator.staff) continue;
        const targetPitch = locator.pitch;
        if (!targetPitch) {
          if (event.pitches.length === 0) return event;
          continue;
        }
        if (event.pitches.some((pitch) => pitchesEqual(pitch, targetPitch))) return event;
      }
    }
  }
  return undefined;
}

export function findNoteEventById(score: Score, noteId: string): NoteEvent | undefined {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      const event = measure.events.find((candidate) => candidate.id === noteId);
      if (event) return event;
    }
  }
  return undefined;
}

export function findNoteEventAtBeat(
  score: Score,
  measureNumber: number,
  startBeat: number,
  staff?: number
): NoteEvent | undefined {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      if (measure.number !== measureNumber) continue;
      for (const event of measure.events) {
        if (!beatsNear(event.startBeat, startBeat)) continue;
        if (staff !== undefined && effectiveStaff(event) !== staff) continue;
        if (event.pitches.length > 0) return event;
      }
    }
  }
  return undefined;
}

export type ScoreScrollSnapshot = {
  windowScrollX: number;
  windowScrollY: number;
  paperScrollLeft: number;
  paperScrollTop: number;
  windowScrollRatio: number;
  paperScrollRatio: number;
};

export function captureScoreScrollSnapshot(container: HTMLElement | null): ScoreScrollSnapshot {
  const scorePaper = container?.closest<HTMLElement>(".score-paper") ?? null;
  const windowScrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const paperScrollMax = scorePaper ? Math.max(1, scorePaper.scrollHeight - scorePaper.clientHeight) : 1;
  return {
    windowScrollX: window.scrollX,
    windowScrollY: window.scrollY,
    paperScrollLeft: scorePaper?.scrollLeft ?? 0,
    paperScrollTop: scorePaper?.scrollTop ?? 0,
    windowScrollRatio: window.scrollY / windowScrollMax,
    paperScrollRatio: (scorePaper?.scrollTop ?? 0) / paperScrollMax
  };
}

export function restoreScoreScrollSnapshot(container: HTMLElement | null, snapshot: ScoreScrollSnapshot) {
  const windowScrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo(snapshot.windowScrollX, snapshot.windowScrollRatio * windowScrollMax);
  const scorePaper = container?.closest<HTMLElement>(".score-paper") ?? null;
  if (!scorePaper) return;
  const paperScrollMax = Math.max(1, scorePaper.scrollHeight - scorePaper.clientHeight);
  scorePaper.scrollLeft = snapshot.paperScrollLeft;
  scorePaper.scrollTop = snapshot.paperScrollRatio * paperScrollMax;
}

export function pinScoreRenderHeight(container: HTMLElement): () => void {
  const pinnedHeight = container.offsetHeight;
  container.style.minHeight = `${pinnedHeight}px`;
  return () => {
    const nextHeight = container.offsetHeight;
    container.style.minHeight = nextHeight > 0 ? `${nextHeight}px` : "";
  };
}

export function clickToOsmdPoint(event: MouseEvent<HTMLElement>, container: HTMLElement, zoom: number): PointF2D | null {
  // OSMD unit origin is the rendered SVG's top-left (not the container, which has padding).
  // getBoundingClientRect is viewport-relative, so scroll is already accounted for.
  const svg = container.querySelector("svg");
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const scale = 10 * zoom;
  const x = (event.clientX - rect.left) / scale;
  const y = (event.clientY - rect.top) / scale;
  return new PointF2D(x, y);
}

export function graphicalNoteToLocator(graphicalNote: GraphicalNote): NoteLocator | null {
  const sourceNote = graphicalNote.sourceNote;
  if (!sourceNote) return null;

  const isRest = sourceNote.isRest();
  const osmdPitch = isRest ? undefined : sourceNote.Pitch;
  if (!isRest && !osmdPitch) return null;

  const staffEntry = graphicalNote.parentVoiceEntry?.parentStaffEntry;
  const timestamp = staffEntry?.relInMeasureTimestamp ?? staffEntry?.sourceStaffEntry?.Timestamp;
  if (!timestamp) return null;

  const measureNumber = sourceNote.SourceMeasure?.MeasureNumber;
  if (!measureNumber) return null;

  // Staff.Id is the 1-based instrumentStaffId, matching MusicXML <staff> numbering.
  const staff = sourceNote.ParentStaffEntry?.ParentStaff?.Id;

  return {
    measureNumber,
    startBeat: osmdTimestampToStartBeat(timestamp),
    ...(staff !== undefined ? { staff } : {}),
    ...(osmdPitch ? { pitch: osmdPitchToScorePitch(osmdPitch) } : {})
  };
}

function resolveSvgElementReference(reference: string): SVGElement | null {
  const candidates = [reference, reference.startsWith("vf-") ? reference : `vf-${reference}`];
  for (const id of candidates) {
    const element = document.getElementById(id);
    if (element instanceof SVGElement) return element;
  }
  return null;
}

export function getGraphicalNoteStaveGroup(graphicalNote: GraphicalNote): SVGGElement | null {
  const noteWithSvg = graphicalNote as GraphicalNoteWithSvg;
  const svgId = noteWithSvg.getSVGId?.();
  if (!svgId) return null;
  const byId = document.getElementById(`vf-${svgId}`);
  return byId instanceof SVGGElement ? byId : null;
}

function noteAbsoluteY(graphicalNote: GraphicalNote): number {
  return (graphicalNote as { PositionAndShape?: { AbsolutePosition?: { y: number } } }).PositionAndShape?.AbsolutePosition?.y ?? 0;
}

function pickNoteheadShape(noteheadGroup: SVGGElement): SVGGraphicsElement | null {
  const shape = noteheadGroup.querySelector("path, ellipse");
  return shape instanceof SVGGraphicsElement ? shape : null;
}

function pickNoteheadIndex(graphicalNote: GraphicalNote, noteheadGroups: SVGGElement[]): number {
  const noteWithSvg = graphicalNote as GraphicalNoteWithSvg;
  if (
    typeof noteWithSvg.vfnoteIndex === "number" &&
    noteWithSvg.vfnoteIndex >= 0 &&
    noteWithSvg.vfnoteIndex < noteheadGroups.length
  ) {
    return noteWithSvg.vfnoteIndex;
  }

  const voiceEntry = graphicalNote.parentVoiceEntry;
  const notes = (voiceEntry?.notes ?? []).filter(isSelectableGraphicalNote);
  if (notes.length <= 1) return 0;

  const sortedNotes = [...notes].sort((left, right) => noteAbsoluteY(left) - noteAbsoluteY(right));
  const sortedHeads = [...noteheadGroups]
    .map((group, index) => ({ index, y: pickNoteheadShape(group)?.getBoundingClientRect().top ?? 0 }))
    .sort((left, right) => left.y - right.y);

  const noteRank = sortedNotes.findIndex((note) => note === graphicalNote);
  if (noteRank < 0 || noteRank >= sortedHeads.length) return 0;
  return sortedHeads[noteRank].index;
}

export function getGraphicalNoteHighlightTarget(graphicalNote: GraphicalNote): SVGGraphicsElement | null {
  const group = getGraphicalNoteStaveGroup(graphicalNote);
  if (!group) return null;

  const noteheadGroups = [...group.querySelectorAll<SVGGElement>("g.vf-notehead")];
  if (noteheadGroups.length > 1) {
    return pickNoteheadShape(noteheadGroups[pickNoteheadIndex(graphicalNote, noteheadGroups)]);
  }
  if (noteheadGroups.length === 1) {
    return pickNoteheadShape(noteheadGroups[0]);
  }

  return getGraphicalNoteHeadElement(group);
}

export function getGraphicalNoteSvgElement(graphicalNote: GraphicalNote): SVGGElement | null {
  const noteWithSvg = graphicalNote as GraphicalNoteWithSvg;
  const element = noteWithSvg.getSVGGElement?.();
  if (element instanceof SVGGElement) return element;
  if (typeof element === "string") {
    const resolved = resolveSvgElementReference(element);
    if (resolved instanceof SVGGElement) return resolved;
  }

  return getGraphicalNoteStaveGroup(graphicalNote);
}

function getGraphicalNoteHeadElement(group: SVGGElement): SVGGraphicsElement | null {
  const noteheadGroup = group.querySelector(".vf-notehead");
  if (noteheadGroup) {
    const shape = noteheadGroup.querySelector("ellipse, path");
    if (shape instanceof SVGGraphicsElement) return shape;
  }

  const ellipses = [...group.querySelectorAll("ellipse")];
  if (ellipses.length === 1) return ellipses[0];

  if (ellipses.length > 1) {
    return ellipses.reduce((best, candidate) => {
      const bestRect = best.getBoundingClientRect();
      const candidateRect = candidate.getBoundingClientRect();
      return candidateRect.width * candidateRect.height < bestRect.width * bestRect.height ? candidate : best;
    });
  }

  const path = group.querySelector("path");
  return path instanceof SVGGraphicsElement ? path : null;
}

function distancePointToRect(clientX: number, clientY: number, rect: DOMRect): number {
  const dx = Math.max(rect.left - clientX, clientX - rect.right, 0);
  const dy = Math.max(rect.top - clientY, clientY - rect.bottom, 0);
  return Math.hypot(dx, dy);
}

function distancePointToNoteHead(clientX: number, clientY: number, graphicalNote: GraphicalNote): number | null {
  const target = getGraphicalNoteHighlightTarget(graphicalNote);
  if (!target) return null;
  return distancePointToRect(clientX, clientY, target.getBoundingClientRect());
}

function findGraphicalNoteBySvgId(osmd: OpenSheetMusicDisplay, svgId: string): GraphicalNote | null {
  const graphicSheet = osmd.GraphicSheet;
  if (!graphicSheet) return null;

  for (const staffMeasures of graphicSheet.MeasureList) {
    for (const graphicalMeasure of staffMeasures) {
      for (const staffEntry of graphicalMeasure.staffEntries) {
        for (const voiceEntry of staffEntry.graphicalVoiceEntries) {
          for (const graphicalNote of voiceEntry.notes) {
            const noteWithSvg = graphicalNote as GraphicalNoteWithSvg;
            if (noteWithSvg.getSVGId?.() === svgId) return graphicalNote;
          }
        }
      }
    }
  }

  return null;
}

function graphicalNoteFromDomNode(osmd: OpenSheetMusicDisplay, node: Element | null): GraphicalNote | null {
  let current: Element | null = node;
  while (current) {
    if (current.id.startsWith("vf-")) {
      const match = findGraphicalNoteBySvgId(osmd, current.id.slice(3));
      if (match) return match;
    }
    current = current.parentElement;
  }
  return null;
}

export function findGraphicalNoteAtClientPoint(
  osmd: OpenSheetMusicDisplay,
  container: HTMLElement,
  clientX: number,
  clientY: number,
  maxDistancePx: number
): GraphicalNote | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (!container.contains(element)) continue;
    const graphicalNote = graphicalNoteFromDomNode(osmd, element);
    if (graphicalNote && isSelectableGraphicalNote(graphicalNote)) return graphicalNote;
  }

  let bestNote: GraphicalNote | null = null;
  let bestDistance = maxDistancePx;
  const graphicSheet = osmd.GraphicSheet;
  if (!graphicSheet) return null;

  for (const staffMeasures of graphicSheet.MeasureList) {
    for (const graphicalMeasure of staffMeasures) {
      for (const staffEntry of graphicalMeasure.staffEntries) {
        for (const voiceEntry of staffEntry.graphicalVoiceEntries) {
          for (const graphicalNote of voiceEntry.notes) {
            if (!isSelectableGraphicalNote(graphicalNote)) continue;
            const distance = distancePointToNoteHead(clientX, clientY, graphicalNote);
            if (distance === null || distance > bestDistance) continue;
            bestDistance = distance;
            bestNote = graphicalNote;
          }
        }
      }
    }
  }

  return bestNote;
}

export function isSelectableGraphicalNote(graphicalNote: GraphicalNote): boolean {
  const element = getGraphicalNoteSvgElement(graphicalNote);
  if (!element) return false;
  return (element.getAttribute("class") ?? "").includes("vf-stavenote");
}

export function findGraphicalNoteForLocator(osmd: OpenSheetMusicDisplay, locator: NoteLocator): GraphicalNoteWithSvg | null {
  const graphicSheet = osmd.GraphicSheet;
  if (!graphicSheet) return null;

  for (const staffMeasures of graphicSheet.MeasureList) {
    for (const graphicalMeasure of staffMeasures) {
      if (graphicalMeasure.parentSourceMeasure?.MeasureNumber !== locator.measureNumber) continue;

      for (const staffEntry of graphicalMeasure.staffEntries) {
        const startBeat = osmdTimestampToStartBeat(staffEntry.relInMeasureTimestamp);
        if (!beatsNear(startBeat, locator.startBeat)) continue;

        for (const voiceEntry of staffEntry.graphicalVoiceEntries) {
          for (const graphicalNote of voiceEntry.notes) {
            if (!isSelectableGraphicalNote(graphicalNote)) continue;

            const sourceNote = graphicalNote.sourceNote;
            if (!sourceNote) continue;

            if (locator.pitch) {
              if (sourceNote.isRest()) continue;
              const pitch = osmdPitchToScorePitch(sourceNote.Pitch);
              if (!pitchesEqual(pitch, locator.pitch)) continue;
            } else if (!sourceNote.isRest()) {
              continue;
            }

            const staff = sourceNote.ParentStaffEntry?.ParentStaff?.Id;
            if (locator.staff !== undefined && staff !== undefined && staff !== locator.staff) continue;

            return graphicalNote as GraphicalNoteWithSvg;
          }
        }
      }
    }
  }

  return null;
}

export function isClickNearGraphicalNote(graphicalNote: GraphicalNote, clientX: number, clientY: number, maxDistancePx: number): boolean {
  const distance = distancePointToNoteHead(clientX, clientY, graphicalNote);
  if (distance === null) return false;
  return distance <= maxDistancePx;
}

const HIGHLIGHT_ATTR = "data-score-highlight";

function resolveHighlightShape(element: SVGElement): SVGGraphicsElement | null {
  if (element instanceof SVGGraphicsElement && (element.tagName === "path" || element.tagName === "ellipse")) {
    return element;
  }
  const nested = element.querySelector("path, ellipse");
  return nested instanceof SVGGraphicsElement ? nested : null;
}

export function applyNoteHighlight(
  element: SVGElement | null,
  enabled: boolean,
  kind: "selected" | "chord-tone" = "selected"
) {
  const shape = element ? resolveHighlightShape(element) : null;
  if (!shape) return;

  if (!enabled) {
    shape.removeAttribute(HIGHLIGHT_ATTR);
    shape.classList.remove(HIGHLIGHT_CLASS, CHORD_TONE_HIGHLIGHT_CLASS);
    return;
  }

  shape.setAttribute(HIGHLIGHT_ATTR, kind);
}

export function clearAllNoteHighlights(container: HTMLElement | null) {
  container
    ?.querySelectorAll(`path[${HIGHLIGHT_ATTR}], ellipse[${HIGHLIGHT_ATTR}], .${HIGHLIGHT_CLASS}, .${CHORD_TONE_HIGHLIGHT_CLASS}`)
    .forEach((node) => {
      if (node instanceof SVGElement) {
        applyNoteHighlight(node, false);
      }
    });
}

export function highlightGraphicalNote(scoreContainer: HTMLElement | null, graphicalNote: GraphicalNote | null) {
  clearAllNoteHighlights(scoreContainer);
  if (!graphicalNote) return;
  applyNoteHighlight(getGraphicalNoteHighlightTarget(graphicalNote), true);
}

export function highlightGraphicalNotes(scoreContainer: HTMLElement | null, graphicalNotes: GraphicalNote[]) {
  clearAllNoteHighlights(scoreContainer);
  for (const graphicalNote of graphicalNotes) {
    applyNoteHighlight(getGraphicalNoteHighlightTarget(graphicalNote), true);
  }
}

export function highlightSelectedNote(
  osmd: OpenSheetMusicDisplay | null,
  scoreContainer: HTMLElement | null,
  locator: NoteLocator | null,
  graphicalNote?: GraphicalNote | null,
  chordPitches?: Pitch[]
) {
  clearAllNoteHighlights(scoreContainer);
  if (!osmd || !locator) return;

  if (chordPitches && chordPitches.length > 1) {
    const focusedPitch = locator.pitch;
    for (const pitch of chordPitches) {
      const pitchLocator: NoteLocator = { ...locator, pitch };
      const resolved = findGraphicalNoteForLocator(osmd, pitchLocator);
      const element = resolved ? getGraphicalNoteHighlightTarget(resolved) : null;
      if (!element) continue;
      const focused = focusedPitch ? pitchesEqual(pitch, focusedPitch) : false;
      applyNoteHighlight(element, true, focused ? "selected" : "chord-tone");
    }
    return;
  }

  if (graphicalNote) {
    const element = getGraphicalNoteHighlightTarget(graphicalNote);
    if (element && scoreContainer?.contains(element)) {
      applyNoteHighlight(element, true);
      return;
    }
  }

  const resolved = findGraphicalNoteForLocator(osmd, locator);
  applyNoteHighlight(resolved ? getGraphicalNoteHighlightTarget(resolved) : null, true);
}

export type SelectedGraphicalNote = {
  event: NoteEvent;
  graphicalNote: GraphicalNote;
};

export function selectedGraphicalNotesInClientRect(osmd: OpenSheetMusicDisplay, score: Score, rect: DOMRect): SelectedGraphicalNote[] {
  const graphicSheet = osmd.GraphicSheet;
  if (!graphicSheet) return [];

  const selected = new Map<string, SelectedGraphicalNote>();
  for (const staffMeasures of graphicSheet.MeasureList) {
    for (const graphicalMeasure of staffMeasures) {
      for (const staffEntry of graphicalMeasure.staffEntries) {
        for (const voiceEntry of staffEntry.graphicalVoiceEntries) {
          for (const graphicalNote of voiceEntry.notes) {
            if (!isSelectableGraphicalNote(graphicalNote)) continue;

            const element = getGraphicalNoteSvgElement(graphicalNote);
            if (!element || !rectsIntersect(rect, element.getBoundingClientRect())) continue;

            const locator = graphicalNoteToLocator(graphicalNote);
            const event = locator ? findNoteEvent(score, locator) : undefined;
            if (event) selected.set(event.id, { event, graphicalNote });
          }
        }
      }
    }
  }

  return [...selected.values()].sort(
    (left, right) =>
      left.event.measureNumber - right.event.measureNumber ||
      effectiveStaff(left.event) - effectiveStaff(right.event) ||
      effectiveVoice(left.event) - effectiveVoice(right.event) ||
      left.event.startBeat - right.event.startBeat
  );
}

export function noteEventsInClientRect(osmd: OpenSheetMusicDisplay, score: Score, rect: DOMRect): NoteEvent[] {
  return selectedGraphicalNotesInClientRect(osmd, score, rect).map((selection) => selection.event);
}

export function highlightNoteEvents(
  osmd: OpenSheetMusicDisplay | null,
  scoreContainer: HTMLElement | null,
  events: NoteEvent[],
  graphicalNotesByEventId?: Map<string, GraphicalNote>
) {
  clearAllNoteHighlights(scoreContainer);
  if (!osmd) return;

  for (const event of events) {
    const pitches = event.pitches.length ? event.pitches : [undefined];
    for (const pitch of pitches) {
      const graphicalNote =
        findGraphicalNoteForLocator(osmd, {
          measureNumber: event.measureNumber,
          startBeat: event.startBeat,
          staff: effectiveStaff(event),
          ...(pitch ? { pitch } : {})
        }) ?? (pitches.length === 1 ? graphicalNotesByEventId?.get(event.id) : undefined);

      applyNoteHighlight(graphicalNote ? getGraphicalNoteHighlightTarget(graphicalNote) : null, true);
    }
  }
}

function rectsIntersect(left: DOMRect, right: DOMRect): boolean {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}

export function formatPitchLabel(pitch: Pitch): string {
  return pitchToToneName(pitch);
}

export function sortPitchesByMidi(pitches: Pitch[]): Pitch[] {
  return [...pitches].sort((left, right) => pitchToMidi(left) - pitchToMidi(right));
}

export function formatChordLabel(pitches: Pitch[]): string {
  return sortPitchesByMidi(pitches).map(formatPitchLabel).join(" · ");
}

export function startBeatLabel(startBeat: number): string {
  const display = startBeat + 1;
  return Number.isInteger(display) ? `Beat ${display}` : `Beat ${display}`;
}

export function startBeatOptions(
  measureCapacity: number,
  durationBeats: number,
  currentStartBeat?: number
): Array<{ label: string; value: number }> {
  const options: Array<{ label: string; value: number }> = [];
  const maxStart = measureCapacity - durationBeats;
  for (let beat = 0; beat <= maxStart + BEAT_EPSILON; beat += 0.25) {
    const value = Math.round(beat * 4) / 4;
    if (value > maxStart + BEAT_EPSILON) break;
    options.push({ label: startBeatLabel(value), value });
  }

  if (currentStartBeat !== undefined && !options.some((option) => Math.abs(option.value - currentStartBeat) < 0.001)) {
    options.push({ label: `${startBeatLabel(currentStartBeat)} (out of range)`, value: currentStartBeat });
    options.sort((left, right) => left.value - right.value);
  }

  return options;
}

function findGraphicalMeasure(osmd: OpenSheetMusicDisplay, measureNumber: number, staff: number) {
  const graphicSheet = osmd.GraphicSheet;
  if (!graphicSheet) return null;

  for (const staffMeasures of graphicSheet.MeasureList) {
    const graphicalMeasure = staffMeasures[staff - 1];
    if (graphicalMeasure?.parentSourceMeasure?.MeasureNumber === measureNumber) {
      return graphicalMeasure;
    }
  }

  return null;
}

export type MeasureClientRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function measureClientRect(osmd: OpenSheetMusicDisplay, container: HTMLElement, measureNumber: number): MeasureClientRect | null {
  const svg = container.querySelector("svg");
  const graphicSheet = osmd.GraphicSheet;
  if (!svg || !graphicSheet) return null;

  const svgRect = svg.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const scale = OSMD_UNIT_PX * osmd.zoom;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const staffMeasures of graphicSheet.MeasureList) {
    for (const graphicalMeasure of staffMeasures) {
      if (!graphicalMeasure || graphicalMeasure.IsExtraGraphicalMeasure) continue;
      if (graphicalMeasure.parentSourceMeasure?.MeasureNumber !== measureNumber) continue;

      const shape = graphicalMeasure.PositionAndShape;
      const stave = (graphicalMeasure as MeasureWithStave).getVFStave?.() as PositionedStaveLike | undefined;
      const measureLeft = stave?.getX ? stave.getX() / OSMD_UNIT_PX : shape.AbsolutePosition.x + shape.BorderLeft;
      const measureRight = stave?.getX && stave.getWidth ? (stave.getX() + stave.getWidth()) / OSMD_UNIT_PX : shape.AbsolutePosition.x + shape.BorderRight;
      const measureTop = stave ? stave.getYForLine(0) / OSMD_UNIT_PX : shape.AbsolutePosition.y + shape.BorderTop;
      const measureBottom = stave ? stave.getYForLine(4) / OSMD_UNIT_PX : shape.AbsolutePosition.y + shape.BorderBottom;

      left = Math.min(left, measureLeft);
      right = Math.max(right, measureRight);
      top = Math.min(top, measureTop);
      bottom = Math.max(bottom, measureBottom);
    }
  }

  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) return null;

  return {
    left: svgRect.left - containerRect.left + left * scale,
    top: svgRect.top - containerRect.top + top * scale,
    width: Math.max((right - left) * scale, 1),
    height: Math.max((bottom - top) * scale, 1)
  };
}

function voiceEventsInMeasure(events: NoteEvent[], staff: number, voice: number): NoteEvent[] {
  return events
    .filter((event) => effectiveStaff(event) === staff && effectiveVoice(event) === voice)
    .sort((left, right) => left.startBeat - right.startBeat || left.durationBeats - right.durationBeats);
}

function endOfLastVoiceEvent(events: NoteEvent[], staff: number, voice: number): number {
  const voiceEvents = voiceEventsInMeasure(events, staff, voice);
  const last = voiceEvents[voiceEvents.length - 1];
  return last ? last.startBeat + last.durationBeats : 0;
}

/** Place a new event after existing notes in this voice that start at or before the click. */
export function inferInsertStartBeatFromClick(
  osmd: OpenSheetMusicDisplay,
  measure: Measure,
  staff: number,
  voice: number,
  osmdX: number
): number {
  const voiceEvents = voiceEventsInMeasure(measure.events, staff, voice);
  if (voiceEvents.length === 0) return 0;

  const graphicalMeasure = findGraphicalMeasure(osmd, measure.number, staff);
  if (!graphicalMeasure) return endOfLastVoiceEvent(measure.events, staff, voice);

  const beatToX = new Map<number, number>();
  for (const staffEntry of graphicalMeasure.staffEntries) {
    const startBeat = Math.round(osmdTimestampToStartBeat(staffEntry.relInMeasureTimestamp) * 4) / 4;
    const x = staffEntry.PositionAndShape.AbsolutePosition.x;
    const existing = beatToX.get(startBeat);
    if (existing === undefined || x < existing) beatToX.set(startBeat, x);
  }

  const anchors = voiceEvents
    .map((event) => {
      const beatKey = Math.round(event.startBeat * 4) / 4;
      const x = beatToX.get(beatKey);
      if (x === undefined) return null;
      return {
        x,
        endBeat: event.startBeat + event.durationBeats
      };
    })
    .filter((anchor): anchor is { x: number; endBeat: number } => anchor !== null)
    .sort((left, right) => left.x - right.x);

  if (anchors.length === 0) return endOfLastVoiceEvent(measure.events, staff, voice);

  let startBeat = 0;
  for (const anchor of anchors) {
    if (anchor.x > osmdX + 0.01) break;
    startBeat = Math.max(startBeat, anchor.endBeat);
  }

  return Math.round(startBeat * 4) / 4;
}

export function maxInsertDurationAtBeat(events: NoteEvent[], staff: number, voice: number, startBeat: number, measureCapacity: number): number {
  const nextStart = voiceEventsInMeasure(events, staff, voice).find((event) => event.startBeat > startBeat + BEAT_EPSILON)?.startBeat;
  const gapEnd = nextStart ?? measureCapacity;
  return Math.max(0, Math.min(1, gapEnd - startBeat, measureCapacity - startBeat));
}

const STEP_ORDER: Step[] = ["C", "D", "E", "F", "G", "A", "B"];
const SHARP_ORDER: Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: Step[] = ["B", "E", "A", "D", "G", "C", "F"];

/** Alteration (+1/-1/0) the key signature applies to a diatonic step. */
export function keyAlterForStep(step: Step, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, Math.min(fifths, 7)).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, Math.min(-fifths, 7)).includes(step) ? -1 : 0;
  return 0;
}

/**
 * Diatonic pitch for a vertical staff position, assuming fixed clefs for this
 * beginner-piano project: staff 1 = treble (top line F5), staff 2 = bass (top line A3).
 * `halfSpacesFromTopLine` counts half line-spacings downward from the top staff line.
 */
export function pitchFromStaffPosition(staff: number, halfSpacesFromTopLine: number, fifths: number): Pitch {
  const referenceDiatonicIndex = staff === 2 ? 3 * 7 + 5 : 5 * 7 + 3; // A3 for bass, F5 for treble
  const diatonicIndex = referenceDiatonicIndex - halfSpacesFromTopLine;
  const step = STEP_ORDER[((diatonicIndex % 7) + 7) % 7];
  const octave = Math.floor(diatonicIndex / 7);
  const alter = keyAlterForStep(step, fifths);
  return { step, octave, ...(alter ? { alter } : {}) };
}

export type BlankClickTarget = {
  measureNumber: number;
  /** 1-based staff number (MeasureList staffIndex + 1). */
  staff: number;
  /** Click position across the measure's playable width, normalized to [0, 1]. */
  xFraction: number;
  /** Click x in OSMD coordinate units. */
  osmdX: number;
  /** Half line-spacings below the top staff line, rounded to the nearest half-space. */
  halfSpacesFromTopLine: number;
};

// OSMD renders 1 unit = 10px at zoom 1; VexFlow stave coordinates are in those pixels.
const OSMD_UNIT_PX = 10;
// Vertical tolerance above/below the five staff lines, in OSMD units (covers ledger-line area).
const STAFF_VERTICAL_TOLERANCE = 2.5;

type StaveLike = { getYForLine(line: number): number };
type PositionedStaveLike = StaveLike & {
  getX?: () => number;
  getWidth?: () => number;
  getNoteStartX?: () => number;
};
type MeasureWithStave = { getVFStave?: () => StaveLike };

/**
 * Hit-test a click (in OSMD units) against every rendered measure/staff. Returns the
 * measure, staff and normalized coordinates when the click lands on a staff, else null.
 */
export function locateBlankClick(osmd: OpenSheetMusicDisplay, clickPoint: PointF2D): BlankClickTarget | null {
  const graphicSheet = osmd.GraphicSheet;
  if (!graphicSheet) return null;

  for (const staffMeasures of graphicSheet.MeasureList) {
    for (let staffIndex = 0; staffIndex < staffMeasures.length; staffIndex++) {
      const graphicalMeasure = staffMeasures[staffIndex];
      if (!graphicalMeasure || graphicalMeasure.IsExtraGraphicalMeasure) continue;
      const measureNumber = graphicalMeasure.parentSourceMeasure?.MeasureNumber;
      if (!measureNumber || measureNumber < 1) continue;

      const shape = graphicalMeasure.PositionAndShape;
      const stave = (graphicalMeasure as MeasureWithStave).getVFStave?.() as PositionedStaveLike | undefined;
      const staveLeft = stave?.getX ? stave.getX() / OSMD_UNIT_PX : undefined;
      const staveRight = stave?.getX && stave.getWidth ? (stave.getX() + stave.getWidth()) / OSMD_UNIT_PX : undefined;
      const measureLeft = staveLeft ?? shape.AbsolutePosition.x + shape.BorderLeft;
      const measureRight = staveRight ?? shape.AbsolutePosition.x + shape.BorderRight;
      if (clickPoint.x < measureLeft || clickPoint.x > measureRight) continue;

      if (!stave) continue;
      const topLineY = stave.getYForLine(0) / OSMD_UNIT_PX;
      const bottomLineY = stave.getYForLine(4) / OSMD_UNIT_PX;
      if (clickPoint.y < topLineY - STAFF_VERTICAL_TOLERANCE || clickPoint.y > bottomLineY + STAFF_VERTICAL_TOLERANCE) continue;

      const entryXs = graphicalMeasure.staffEntries.map((entry) => entry.PositionAndShape.AbsolutePosition.x);
      const noteStartX = stave.getNoteStartX ? stave.getNoteStartX() / OSMD_UNIT_PX : undefined;
      const regionStart = noteStartX ?? (entryXs.length > 0 ? Math.min(...entryXs) : measureLeft + graphicalMeasure.beginInstructionsWidth);
      const regionEnd = measureRight;
      if (regionEnd - regionStart <= 0) continue;
      const xFraction = Math.min(Math.max((clickPoint.x - regionStart) / (regionEnd - regionStart), 0), 1);

      const halfLineSpacing = (bottomLineY - topLineY) / 8; // 4 line gaps = 8 half-spaces
      const halfSpacesFromTopLine = Math.round((clickPoint.y - topLineY) / halfLineSpacing);

      return { measureNumber, staff: staffIndex + 1, xFraction, osmdX: clickPoint.x, halfSpacesFromTopLine };
    }
  }

  return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
