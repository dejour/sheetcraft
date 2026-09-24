import type {
  DynamicEvent,
  BeamMark,
  HarmonyEvent,
  Measure,
  MeasureInput,
  NoteEvent,
  NoteInput,
  PhraseMark,
  Pitch,
  PlaybackEvent,
  Score,
  ScoreOperation,
  TempoEvent,
  ValidationResult
} from "./types";

const STEP_TO_SEMITONE: Record<Pitch["step"], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11
};

const SHARP_NAMES: Array<[Pitch["step"], number | undefined]> = [
  ["C", undefined],
  ["C", 1],
  ["D", undefined],
  ["D", 1],
  ["E", undefined],
  ["F", undefined],
  ["F", 1],
  ["G", undefined],
  ["G", 1],
  ["A", undefined],
  ["A", 1],
  ["B", undefined]
];

const FLAT_NAMES: Array<[Pitch["step"], number | undefined]> = [
  ["C", undefined],
  ["D", -1],
  ["D", undefined],
  ["E", -1],
  ["E", undefined],
  ["F", undefined],
  ["G", -1],
  ["G", undefined],
  ["A", -1],
  ["A", undefined],
  ["B", -1],
  ["B", undefined]
];

const KEY_TO_FIFTHS: Record<string, number> = {
  cb: -7,
  gb: -6,
  db: -5,
  ab: -4,
  eb: -3,
  bb: -2,
  f: -1,
  c: 0,
  g: 1,
  d: 2,
  a: 3,
  e: 4,
  b: 5,
  "f#": 6,
  "c#": 7
};

const FIFTHS_TO_TONIC: Record<number, number> = {
  "-7": 11,
  "-6": 6,
  "-5": 1,
  "-4": 8,
  "-3": 3,
  "-2": 10,
  "-1": 5,
  0: 0,
  1: 7,
  2: 2,
  3: 9,
  4: 4,
  5: 11,
  6: 6,
  7: 1
};

function measureDurationBeats(measure: Pick<Measure, "durationBeats" | "timeSignature">): number {
  return measure.durationBeats ?? measure.timeSignature.beats * (4 / measure.timeSignature.beatType);
}

export function applyOperations(score: Score, operations: ScoreOperation[]): Score {
  let next = cloneScore(score);
  for (const operation of operations) {
    if (operation.type === "create_score") next = createScore(operation.params);
    if (operation.type === "replace_measures") next = replaceMeasures(next, operation);
    if (operation.type === "copy_measure") next = copyMeasure(next, operation);
    if (operation.type === "clear_staff_in_measure") next = clearStaffInMeasure(next, operation);
    if (operation.type === "insert_note") next = insertEvent(next, operation.partId, operation.measureNumber, operation.params, [operation.params.pitch]);
    if (operation.type === "insert_rest") next = insertEvent(next, operation.partId, operation.measureNumber, operation.params, []);
    if (operation.type === "insert_chord") next = insertEvent(next, operation.partId, operation.measureNumber, operation.params, operation.params.pitches);
    if (operation.type === "set_harmony") next = setHarmony(next, operation.partId, operation.measureNumber, operation.params);
    if (operation.type === "set_tempo") next = setTempo(next, operation.partId, operation.measureNumber, operation.params);
    if (operation.type === "set_dynamic") next = setDynamic(next, operation.partId, operation.measureNumber, operation.params);
    if (operation.type === "rewrite_phrase") next = rewritePhrase(next, operation);
    if (operation.type === "transpose") next = transposeScore(next, operation.params.targetKey);
    if (operation.type === "simplify_left_hand") next = simplifyLeftHand(next, operation);
    if (operation.type === "update_note") next = updateNote(next, operation.noteId, operation.params);
    if (operation.type === "delete_note") next = deleteNote(next, operation.noteId);
  }
  return next;
}

export function validateScore(score: Score): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!score.parts.length) errors.push("Score must contain at least one part.");

  for (const part of score.parts) {
    if (!part.measures.length) warnings.push(`Part ${part.id} has no measures.`);
    for (const measure of part.measures) {
      if (measure.divisions <= 0) errors.push(`Measure ${measure.number} has invalid divisions.`);
      const measureLength = measureDurationBeats(measure);
      for (const event of measure.events) {
        if (event.durationBeats <= 0) errors.push(`Note ${event.id} has non-positive duration.`);
        if (event.startBeat < 0) errors.push(`Note ${event.id} starts before the measure.`);
        if (event.startBeat + event.durationBeats > measureLength + 0.001) {
          warnings.push(`Note ${event.id} extends past measure ${measure.number}.`);
        }
      }
      for (const group of groupedMeasureEvents(measure.events).values()) {
        const ordered = [...group].sort((a, b) => a.startBeat - b.startBeat || a.durationBeats - b.durationBeats);
        let previous: NoteEvent | undefined;
        for (const event of ordered) {
          if (
            previous &&
            event.startBeat < previous.startBeat + previous.durationBeats - 0.001 &&
            !sameRhythmicSlot(previous, event)
          ) {
            warnings.push(`Note ${event.id} overlaps another event in measure ${measure.number}.`);
          }
          if (!previous || event.startBeat + event.durationBeats > previous.startBeat + previous.durationBeats) previous = event;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function introducedBlockingValidationReason(before: ValidationResult, after: ValidationResult): string | undefined {
  const knownIssues = new Set([...before.errors, ...before.warnings]);

  for (const error of after.errors) {
    if (!knownIssues.has(error)) return error;
  }

  for (const warning of after.warnings) {
    if (knownIssues.has(warning)) continue;
    if (warning.includes("extends past measure") || warning.includes("overlaps another event")) {
      return warning;
    }
  }

  return undefined;
}

function groupedMeasureEvents(events: NoteEvent[]): Map<string, NoteEvent[]> {
  return events.reduce<Map<string, NoteEvent[]>>((groups, event) => {
    const key = `${validationStaff(event)}:${event.voice ?? 1}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
    return groups;
  }, new Map());
}

function validationStaff(event: NoteEvent): number {
  if (event.staff) return event.staff;
  const lowest = event.pitches[0];
  if (!lowest) return 1;
  return pitchToMidi(lowest) < 60 ? 2 : 1;
}

function sameRhythmicSlot(left: NoteEvent, right: NoteEvent): boolean {
  return Math.abs(left.startBeat - right.startBeat) <= 0.001 && Math.abs(left.durationBeats - right.durationBeats) <= 0.001;
}

export function generateTimeline(score: Score): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  for (const part of score.parts) {
    let offset = 0;
    let activeDynamics: Array<{ startBeat: number; staff?: number; velocity: number }> = [];
    for (const measure of part.measures) {
      activeDynamics = [
        ...activeDynamics,
        ...(measure.dynamics ?? []).map((dynamic) => ({
          startBeat: offset + dynamic.startBeat,
          ...(dynamic.staff ? { staff: dynamic.staff } : {}),
          velocity: dynamicVelocity(dynamic.mark)
        }))
      ].sort((a, b) => a.startBeat - b.startBeat);

      for (const event of measure.events) {
        if (event.pitches.length > 0) {
          const staff = event.staff;
          events.push({
            id: event.id,
            partId: part.id,
            measureNumber: measure.number,
            startBeat: offset + event.startBeat,
            durationBeats: event.durationBeats,
            pitches: event.pitches,
            ...(staff ? { staff } : {}),
            velocity: velocityAtBeat(activeDynamics, offset + event.startBeat, staff),
            ...(event.tie ? { tie: event.tie } : {}),
            ...(event.slur ? { slur: event.slur } : {}),
            ...(event.beam ? { beam: event.beam } : {})
          });
        }
      }
      offset += measureDurationBeats(measure);
    }
  }
  return mergeTiedPlaybackEvents(events.sort((a, b) => a.startBeat - b.startBeat));
}

function dynamicVelocity(mark: DynamicEvent["mark"]): number {
  const velocities: Record<DynamicEvent["mark"], number> = {
    pp: 0.35,
    p: 0.48,
    mp: 0.62,
    mf: 0.75,
    f: 0.9,
    ff: 1
  };
  return velocities[mark];
}

function velocityAtBeat(dynamics: Array<{ startBeat: number; staff?: number; velocity: number }>, beat: number, staff?: number): number {
  const matching = dynamics
    .filter((dynamic) => dynamic.startBeat <= beat + 0.001 && (dynamic.staff === undefined || staff === undefined || dynamic.staff === staff))
    .sort((a, b) => {
      const beatOrder = b.startBeat - a.startBeat;
      if (beatOrder !== 0) return beatOrder;
      if (a.staff === staff && b.staff !== staff) return -1;
      if (b.staff === staff && a.staff !== staff) return 1;
      return 0;
    })[0];
  return matching?.velocity ?? 0.75;
}

function mergeTiedPlaybackEvents(events: PlaybackEvent[]): PlaybackEvent[] {
  const merged: PlaybackEvent[] = [];
  const activeTies = new Map<string, PlaybackEvent>();

  for (const event of events) {
    const key = playbackTieKey(event);
    const active = activeTies.get(key);

    if ((event.tie === "stop" || event.tie === "continue") && active && Math.abs(active.startBeat + active.durationBeats - event.startBeat) < 0.001) {
      active.durationBeats += event.durationBeats;
      if (event.slur) active.slur = event.slur;
      if (event.tie === "stop") activeTies.delete(key);
      continue;
    }

    const playableEvent = { ...event };
    merged.push(playableEvent);

    if (event.tie === "start" || event.tie === "continue") {
      activeTies.set(key, playableEvent);
    }
  }

  return merged;
}

function playbackTieKey(event: PlaybackEvent): string {
  return `${event.partId}:${event.pitches.map(pitchKey).sort().join("+")}`;
}

function pitchKey(pitch: Pitch): string {
  return `${pitch.step}:${pitch.alter ?? 0}:${pitch.octave}`;
}

function isPhraseMark(value: unknown): value is PhraseMark {
  return value === "start" || value === "stop" || value === "continue";
}

function isBeamMark(value: unknown): value is BeamMark {
  return value === "begin" || value === "continue" || value === "end" || value === "none";
}

export function pitchToMidi(pitch: Pitch): number {
  return (pitch.octave + 1) * 12 + STEP_TO_SEMITONE[pitch.step] + (pitch.alter ?? 0);
}

export function pitchToToneName(pitch: Pitch): string {
  const accidental = pitch.alter === 1 ? "#" : pitch.alter === -1 ? "b" : "";
  return `${pitch.step}${accidental}${pitch.octave}`;
}

export function transposePitch(pitch: Pitch, semitones: number, keyFifths = 0): Pitch {
  return midiToPitch(pitchToMidi(pitch) + semitones, keyFifths);
}

function cloneScore(score: Score): Score {
  return JSON.parse(JSON.stringify(score)) as Score;
}

function createScore(params: Extract<ScoreOperation, { type: "create_score" }>["params"]): Score {
  const timeSignature = params.timeSignature ?? { beats: 4, beatType: 4 };
  const key = params.key ?? { fifths: 0 };
  const divisions = params.divisions ?? 1;
  return {
    id: `score_${cryptoRandom()}`,
    title: params.title ?? "Untitled score",
    parts: [
      {
        id: "P1",
        name: params.partName ?? "Piano",
        measures: params.measures.map((measure, index) =>
          materializeMeasure(measure, {
            fallbackNumber: index + 1,
            divisions,
            key,
            timeSignature
          })
        )
      }
    ]
  };
}

function materializeMeasure(
  input: MeasureInput,
  defaults: {
    fallbackNumber: number;
    divisions: number;
    key?: { fifths: number };
    timeSignature: { beats: number; beatType: number };
  }
): Measure {
  const number = input.number ?? defaults.fallbackNumber;
  const measure: Measure = {
    number,
    divisions: input.divisions ?? defaults.divisions,
    timeSignature: input.timeSignature ?? defaults.timeSignature,
    ...(input.durationBeats ? { durationBeats: input.durationBeats } : {}),
    ...(input.implicit ? { implicit: input.implicit } : {}),
    key: input.key ?? defaults.key,
    ...(input.harmonies ? { harmonies: input.harmonies } : {}),
    ...(input.tempos ? { tempos: input.tempos } : {}),
    ...(input.dynamics ? { dynamics: input.dynamics } : {}),
    events: []
  };
  measure.events = input.events.map((event, index) => noteInputToEvent(event, number, index));
  return measure;
}

function noteInputToEvent(input: NoteInput, measureNumber: number, index: number): NoteEvent {
  return {
    id: `n_${measureNumber}_${index}_${cryptoRandom()}`,
    measureNumber,
    startBeat: input.startBeat,
    durationBeats: input.durationBeats,
    pitches: input.pitches ?? [],
    ...(input.staff ? { staff: input.staff } : {}),
    voice: input.voice ?? 1,
    ...(isPhraseMark(input.tie) ? { tie: input.tie } : {}),
    ...(isPhraseMark(input.slur) ? { slur: input.slur } : {}),
    ...(isBeamMark(input.beam) ? { beam: input.beam } : {})
  };
}

function replaceMeasures(score: Score, operation: Extract<ScoreOperation, { type: "replace_measures" }>): Score {
  const part = findPart(score, operation.partId);
  if (!part) return score;
  const from = operation.range.fromMeasure;
  const to = operation.range.toMeasure;
  const template = part.measures.find((measure) => measure.number >= from && measure.number <= to) ?? part.measures[0];
  const defaults = {
    divisions: template?.divisions ?? 1,
    key: template?.key,
    timeSignature: template?.timeSignature ?? { beats: 4, beatType: 4 }
  };
  const replacements = operation.params.measures.map((measure, index) =>
    materializeMeasure(
      {
        ...measure,
        number: measure.number ?? from + index
      },
      {
        fallbackNumber: from + index,
        ...defaults
      }
    )
  );
  part.measures = [...part.measures.filter((measure) => measure.number < from || measure.number > to), ...replacements].sort(
    (a, b) => a.number - b.number
  );
  return score;
}

function copyMeasure(score: Score, operation: Extract<ScoreOperation, { type: "copy_measure" }>): Score {
  const part = findPart(score, operation.partId);
  if (!part) return score;
  const source = part.measures.find((measure) => measure.number === operation.fromMeasure);
  if (!source) return score;

  const copied = cloneMeasureForNumber(source, operation.toMeasure);
  part.measures = [...part.measures.filter((measure) => measure.number !== operation.toMeasure), copied].sort((a, b) => a.number - b.number);
  return score;
}

function clearStaffInMeasure(score: Score, operation: Extract<ScoreOperation, { type: "clear_staff_in_measure" }>): Score {
  const part = findPart(score, operation.partId);
  const measure = part?.measures.find((candidate) => candidate.number === operation.measureNumber);
  if (!measure) return score;
  measure.events = measure.events.filter((event) => (event.staff ?? 1) !== operation.staff);
  return score;
}

function cloneMeasureForNumber(source: Measure, measureNumber: number): Measure {
  return {
    ...source,
    number: measureNumber,
    harmonies: source.harmonies ? source.harmonies.map((harmony) => ({ ...harmony, bass: harmony.bass ? { ...harmony.bass } : undefined })) : undefined,
    tempos: source.tempos ? source.tempos.map((tempo) => ({ ...tempo })) : undefined,
    dynamics: source.dynamics ? source.dynamics.map((dynamic) => ({ ...dynamic })) : undefined,
    events: source.events.map((event, index) => ({
      ...event,
      id: `n_${measureNumber}_${index}_${cryptoRandom()}`,
      measureNumber,
      pitches: event.pitches.map((pitch) => ({ ...pitch }))
    }))
  };
}

function insertEvent(score: Score, partId: string | undefined, measureNumber: number, input: NoteInput, pitches: Pitch[]): Score {
  const part = findPart(score, partId);
  const measure = part?.measures.find((candidate) => candidate.number === measureNumber);
  if (!measure) return score;
  const event = noteInputToEvent({ ...input, pitches }, measureNumber, measure.events.length);
  measure.events = [...measure.events, event].sort(compareEventsForLayout);
  return score;
}

function setHarmony(score: Score, partId: string | undefined, measureNumber: number, input: Partial<HarmonyEvent> & { startBeat: number; text?: string | null }): Score {
  const part = findPart(score, partId);
  const measure = part?.measures.find((candidate) => candidate.number === measureNumber);
  if (!measure) return score;
  const harmonies = (measure.harmonies ?? []).filter((harmony) => Math.abs(harmony.startBeat - input.startBeat) > 0.001);

  const harmony = normalizeHarmonyInput(input);
  if (harmony) {
    harmonies.push(harmony);
  }

  measure.harmonies = harmonies.sort((a, b) => a.startBeat - b.startBeat);
  return score;
}

function setTempo(score: Score, partId: string | undefined, measureNumber: number, input: { startBeat: number; bpm?: number | null; beatUnit?: TempoEvent["beatUnit"] }): Score {
  const part = findPart(score, partId);
  const measure = part?.measures.find((candidate) => candidate.number === measureNumber);
  if (!measure) return score;
  const tempos = (measure.tempos ?? []).filter((tempo) => Math.abs(tempo.startBeat - input.startBeat) > 0.001);

  if (typeof input.bpm === "number" && Number.isFinite(input.bpm) && input.bpm > 0) {
    tempos.push({ startBeat: input.startBeat, bpm: input.bpm, beatUnit: input.beatUnit ?? "quarter" });
  }

  measure.tempos = tempos.sort((a, b) => a.startBeat - b.startBeat);
  return score;
}

function setDynamic(score: Score, partId: string | undefined, measureNumber: number, input: { startBeat: number; mark?: DynamicEvent["mark"] | null; staff?: number }): Score {
  const part = findPart(score, partId);
  const measure = part?.measures.find((candidate) => candidate.number === measureNumber);
  if (!measure) return score;
  const dynamics = (measure.dynamics ?? []).filter(
    (dynamic) => Math.abs(dynamic.startBeat - input.startBeat) > 0.001 || (input.staff !== undefined && dynamic.staff !== input.staff)
  );

  if (input.mark) {
    dynamics.push({ startBeat: input.startBeat, mark: input.mark, ...(input.staff ? { staff: input.staff } : {}) });
  }

  measure.dynamics = dynamics.sort((a, b) => a.startBeat - b.startBeat || (a.staff ?? 0) - (b.staff ?? 0));
  return score;
}

function normalizeHarmonyInput(input: Partial<HarmonyEvent> & { startBeat: number; text?: string | null }): HarmonyEvent | undefined {
  if (input.text === "" || input.text === null) return undefined;
  if (input.root) {
    return {
      startBeat: input.startBeat,
      root: input.root,
      ...(input.alter ? { alter: input.alter } : {}),
      ...(input.kind ? { kind: normalizeHarmonyKind(input.kind) } : {}),
      ...(input.text ? { text: normalizeHarmonyText(input.text) } : {}),
      ...(input.bass ? { bass: input.bass } : {})
    };
  }
  if (!input.text) return undefined;
  return parseHarmonyText(input.startBeat, normalizeHarmonyText(input.text));
}

function parseHarmonyText(startBeat: number, text: string): HarmonyEvent | undefined {
  const match = text.trim().match(/^([A-G])([#b♯♭]?)(.*?)(?:\/([A-G])([#b♯♭]?))?$/);
  if (!match) return undefined;
  const [, root, accidental, rawKind, bassStep, bassAccidental] = match;
  return {
    startBeat,
    root: root as HarmonyEvent["root"],
    ...(accidentalToAlter(accidental) ? { alter: accidentalToAlter(accidental) } : {}),
    kind: harmonyKindFromSuffix(rawKind),
    text: text.trim(),
    ...(bassStep ? { bass: { step: bassStep as HarmonyEvent["root"], ...(accidentalToAlter(bassAccidental) ? { alter: accidentalToAlter(bassAccidental) } : {}) } } : {})
  };
}

function accidentalToAlter(value: string | undefined): number | undefined {
  if (value === "#" || value === "♯") return 1;
  if (value === "b" || value === "♭") return -1;
  return undefined;
}

function harmonyKindFromSuffix(value: string): string {
  const suffix = value.trim().toLowerCase().replace(/\s+/g, "");
  return normalizeHarmonyKind(suffix);
}

function normalizeHarmonyKind(value: string): string {
  const suffix = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!suffix) return "major";
  if (suffix === "m" || suffix === "min") return "minor";
  if (suffix === "m7" || suffix === "min7") return "minor-seventh";
  if (suffix === "maj7" || suffix === "ma7" || suffix === "major7") return "major-seventh";
  if (suffix === "7") return "dominant";
  if (suffix === "dim") return "diminished";
  if (suffix === "aug") return "augmented";
  if (suffix === "sus2" || suffix === "suspended-second") return "suspended-second";
  if (suffix === "sus4" || suffix === "sus" || suffix === "suspended-fourth") return "suspended-fourth";
  return "other";
}

function normalizeHarmonyText(text: string): string {
  return text
    .trim()
    .replace(/\bflat\b/gi, "b")
    .replace(/\bsharp\b/gi, "#")
    .replace(/^([A-G])\s+([b#♭♯])\s*/i, "$1$2")
    .replace(/\bsus\s+([24])\b/gi, "sus$1")
    .replace(/\s+/g, "");
}

function rewritePhrase(score: Score, operation: Extract<ScoreOperation, { type: "rewrite_phrase" }>): Score {
  if (operation.params.strategy === "simpler") {
    return simplifyLeftHand(score, {
      type: "simplify_left_hand",
      range: operation.range,
      params: { strategy: "root_notes", rhythmDensity: "low", preserveRightHand: false }
    });
  }

  const part = findPart(score, operation.partId);
  if (!part) return score;
  for (const measure of part.measures) {
    if (measure.number < operation.range.fromMeasure || measure.number > operation.range.toMeasure) continue;
    const editable = measure.events.filter((event) => event.pitches.length > 0);
    if (!editable.length) continue;
    if (operation.params.strategy === "block_chords") {
      measure.events = blockChordPhrase(measure, editable);
    }
    if (operation.params.strategy === "more_motion") {
      measure.events = addPassingMotion(measure, editable);
    }
    if (operation.params.strategy === "arpeggio") {
      measure.events = arpeggiatePhrase(measure, editable);
    }
  }
  return score;
}

function findPart(score: Score, partId?: string) {
  return partId ? score.parts.find((part) => part.id === partId) : score.parts[0];
}

function normalizeKey(input: string): string {
  return input
    .toLowerCase()
    .replace("major", "")
    .replace("调", "")
    .replace("大", "")
    .replace(/\s+/g, "")
    .trim();
}

function keyFifths(input: string): number {
  const key = normalizeKey(input);
  if (!(key in KEY_TO_FIFTHS)) throw new Error(`Unsupported target key: ${input}`);
  return KEY_TO_FIFTHS[key];
}

function transposeScore(score: Score, targetKey: string): Score {
  const targetFifths = keyFifths(targetKey);
  const currentFifths = score.parts[0]?.measures.find((measure) => measure.key)?.key?.fifths ?? 0;
  const currentTonic = FIFTHS_TO_TONIC[currentFifths] ?? 0;
  const targetTonic = FIFTHS_TO_TONIC[targetFifths] ?? 0;
  let semitones = targetTonic - currentTonic;
  if (semitones > 6) semitones -= 12;
  if (semitones < -6) semitones += 12;

  for (const part of score.parts) {
    for (const measure of part.measures) {
      measure.key = { fifths: targetFifths };
      for (const event of measure.events) {
        event.pitches = event.pitches.map((pitch) => midiToPitch(pitchToMidi(pitch) + semitones, targetFifths));
      }
      for (const harmony of measure.harmonies ?? []) {
        const root = transposePitch({ step: harmony.root, alter: harmony.alter, octave: 4 }, semitones, targetFifths);
        harmony.root = root.step;
        harmony.alter = root.alter;
        if (harmony.bass) {
          const bass = transposePitch({ ...harmony.bass, octave: 4 }, semitones, targetFifths);
          harmony.bass = { step: bass.step, alter: bass.alter };
        }
        if (harmony.text) {
          const name = (pitch: { step: string; alter?: number }) => pitch.step + (pitch.alter === 1 ? "#" : pitch.alter === -1 ? "b" : "");
          harmony.text = harmony.text.replace(/^[A-G](?:#|b|♭|♯)?/, name(root));
          if (harmony.bass) harmony.text = harmony.text.replace(/\/[A-G](?:#|b|♭|♯)?$/, `/${name(harmony.bass)}`);
        }
      }
    }
  }
  return score;
}

function midiToPitch(midi: number, targetFifths = 0): Pitch {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = ((midi % 12) + 12) % 12;
  const [step, alter] = (targetFifths < 0 ? FLAT_NAMES : SHARP_NAMES)[semitone];
  return { step, octave, ...(alter ? { alter } : {}) };
}

function updateNote(
  score: Score,
  noteId: string,
  params: {
    pitch?: Pitch;
    pitches?: Pitch[];
    startBeat?: number;
    durationBeats?: number;
    reflowFollowing?: boolean;
    voice?: number;
    splitPitch?: Pitch;
    tie?: PhraseMark | null;
    slur?: PhraseMark | null;
    beam?: BeamMark | null;
  }
): Score {
  if (params.splitPitch !== undefined && params.voice !== undefined) {
    return splitPitchToVoice(score, noteId, params.splitPitch, params.voice);
  }

  for (const part of score.parts) {
    for (const measure of part.measures) {
      const event = measure.events.find((candidate) => candidate.id === noteId);
      if (!event) continue;

      if (params.pitches?.length) event.pitches = params.pitches;
      if (params.pitch) event.pitches = [params.pitch];
      if (params.startBeat !== undefined) event.startBeat = params.startBeat;
      if (params.durationBeats !== undefined) event.durationBeats = params.durationBeats;
      if (params.voice !== undefined) event.voice = params.voice;
      if (params.tie !== undefined) {
        if (isPhraseMark(params.tie)) event.tie = params.tie;
        else delete event.tie;
      }
      if (params.slur !== undefined) {
        if (isPhraseMark(params.slur)) event.slur = params.slur;
        else delete event.slur;
      }
      if (params.beam !== undefined) {
        if (isBeamMark(params.beam)) event.beam = params.beam;
        else delete event.beam;
      }
      if (params.reflowFollowing) reflowFollowingEvents(measure, event);
      measure.events.sort(compareEventsForLayout);
    }
  }
  return score;
}

function reflowFollowingEvents(measure: Measure, anchor: NoteEvent): void {
  const staff = validationStaff(anchor);
  const voice = anchor.voice ?? 1;
  let nextStartBeat = anchor.startBeat + anchor.durationBeats;
  const following = measure.events
    .filter(
      (event) =>
        event.id !== anchor.id &&
        validationStaff(event) === staff &&
        (event.voice ?? 1) === voice &&
        event.startBeat > anchor.startBeat
    )
    .sort((left, right) => left.startBeat - right.startBeat || left.durationBeats - right.durationBeats);

  for (const event of following) {
    event.startBeat = roundBeat(nextStartBeat);
    nextStartBeat = event.startBeat + event.durationBeats;
  }
}

function roundBeat(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pitchesEqual(left: Pitch, right: Pitch): boolean {
  return left.step === right.step && left.octave === right.octave && (left.alter ?? 0) === (right.alter ?? 0);
}

function beatsNear(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.001;
}

function splitPitchToVoice(score: Score, noteId: string, pitch: Pitch, targetVoice: number): Score {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      const eventIndex = measure.events.findIndex((candidate) => candidate.id === noteId);
      if (eventIndex < 0) continue;

      const source = measure.events[eventIndex];
      if (!source.pitches.some((candidate) => pitchesEqual(candidate, pitch))) return score;

      const staff = validationStaff(source);
      const remaining = source.pitches.filter((candidate) => !pitchesEqual(candidate, pitch));
      const targetAtBeat = measure.events.find(
        (candidate) =>
          candidate.id !== noteId &&
          validationStaff(candidate) === staff &&
          (candidate.voice ?? 1) === targetVoice &&
          beatsNear(candidate.startBeat, source.startBeat) &&
          candidate.pitches.length > 0
      );

      if (targetAtBeat) {
        if (!targetAtBeat.pitches.some((candidate) => pitchesEqual(candidate, pitch))) {
          targetAtBeat.pitches.push(pitch);
        }
      } else {
        const blocked = measure.events.some(
          (candidate) =>
            candidate.id !== noteId &&
            candidate.pitches.length > 0 &&
            validationStaff(candidate) === staff &&
            (candidate.voice ?? 1) === targetVoice &&
            candidate.startBeat < source.startBeat + source.durationBeats - 0.001 &&
            candidate.startBeat + candidate.durationBeats > source.startBeat + 0.001
        );
        if (blocked) return score;

        measure.events.push(
          noteInputToEvent(
            {
              startBeat: source.startBeat,
              durationBeats: source.durationBeats,
              ...(source.staff ? { staff: source.staff } : {}),
              voice: targetVoice,
              pitches: [pitch]
            },
            measure.number,
            measure.events.length
          )
        );
      }

      if (remaining.length === 0) {
        measure.events.splice(eventIndex, 1);
      } else {
        measure.events[eventIndex] = { ...source, pitches: remaining };
      }

      measure.events.sort(compareEventsForLayout);
      return score;
    }
  }

  return score;
}

function compareEventsForLayout(left: NoteEvent, right: NoteEvent): number {
  return (
    validationStaff(left) - validationStaff(right) ||
    (left.voice ?? 1) - (right.voice ?? 1) ||
    left.startBeat - right.startBeat ||
    left.durationBeats - right.durationBeats
  );
}

function deleteNote(score: Score, noteId: string): Score {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      measure.events = measure.events.filter((event) => event.id !== noteId);
    }
  }
  return score;
}

function blockChordPhrase(measure: Measure, editable: NoteEvent[]): NoteEvent[] {
  const first = editable[0];
  const root = lowestPitch(first);
  if (!root) return measure.events;
  const chord: NoteEvent = {
    ...first,
    id: `rewrite_block_${measure.number}_${cryptoRandom()}`,
    startBeat: 0,
    durationBeats: measureDurationBeats(measure),
    pitches: simplifyPitches(root, "block_chords", measure)
  };
  return [...measure.events.filter((event) => !editable.includes(event)), chord].sort((a, b) => a.startBeat - b.startBeat);
}

function addPassingMotion(measure: Measure, editable: NoteEvent[]): NoteEvent[] {
  const expanded: NoteEvent[] = [];
  for (const event of editable) {
    const pitch = event.pitches[0];
    if (!pitch || event.durationBeats < 1) {
      expanded.push(event);
      continue;
    }
    const firstDuration = event.durationBeats / 2;
    expanded.push({
      ...event,
      id: `rewrite_motion_a_${event.id}_${cryptoRandom()}`,
      durationBeats: firstDuration
    });
    expanded.push({
      ...event,
      id: `rewrite_motion_b_${event.id}_${cryptoRandom()}`,
      startBeat: event.startBeat + firstDuration,
      durationBeats: event.durationBeats - firstDuration,
      pitches: [midiToPitch(pitchToMidi(pitch) + 2, measure.key?.fifths ?? 0)]
    });
  }
  return [...measure.events.filter((event) => !editable.includes(event)), ...expanded].sort((a, b) => a.startBeat - b.startBeat);
}

function arpeggiatePhrase(measure: Measure, editable: NoteEvent[]): NoteEvent[] {
  const expanded: NoteEvent[] = [];
  for (const event of editable) {
    if (event.pitches.length < 2 || event.durationBeats < event.pitches.length * 0.25) {
      expanded.push(event);
      continue;
    }
    const duration = event.durationBeats / event.pitches.length;
    event.pitches.forEach((pitch, index) => {
      expanded.push({
        ...event,
        id: `rewrite_arp_${event.id}_${index}_${cryptoRandom()}`,
        startBeat: event.startBeat + duration * index,
        durationBeats: duration,
        pitches: [pitch]
      });
    });
  }
  return [...measure.events.filter((event) => !editable.includes(event)), ...expanded].sort((a, b) => a.startBeat - b.startBeat);
}

function simplifyLeftHand(score: Score, operation: Extract<ScoreOperation, { type: "simplify_left_hand" }>): Score {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      if (measure.number < operation.range.fromMeasure || measure.number > operation.range.toMeasure) continue;
      const eligible = measure.events.filter((event) => isLeftHandEvent(event));
      if (!eligible.length) continue;

      const keptIds = new Set(selectRhythmEvents(eligible, operation.params.rhythmDensity ?? "medium").map((event) => event.id));
      let previousMidi: number | undefined;

      measure.events = measure.events
        .filter((event) => !eligible.includes(event) || keptIds.has(event.id))
        .map((event) => {
          if (!keptIds.has(event.id)) return event;
          const root = lowestPitch(event);
          if (!root) return event;
          const rootMidi = limitJump(pitchToMidi(root), previousMidi, operation.params.maxJumpSemitones);
          previousMidi = rootMidi;
          const rootPitch = midiToPitch(rootMidi, measure.key?.fifths ?? 0);
          return {
            ...event,
            pitches: simplifyPitches(rootPitch, operation.params.strategy, measure),
            staff: event.staff ?? 2
          };
        });
    }
  }
  return score;
}

function allEvents(score: Score): NoteEvent[] {
  return score.parts.flatMap((part) => part.measures.flatMap((measure) => measure.events));
}

function isLeftHandEvent(event: NoteEvent): boolean {
  if (event.staff === 2) return true;
  if (event.staff !== undefined) return false;
  const lowest = lowestPitch(event);
  return lowest ? pitchToMidi(lowest) < 60 : false;
}

function lowestPitch(event: NoteEvent): Pitch | undefined {
  return event.pitches.reduce<Pitch | undefined>((lowest, pitch) => {
    if (!lowest) return pitch;
    return pitchToMidi(pitch) < pitchToMidi(lowest) ? pitch : lowest;
  }, undefined);
}

function selectRhythmEvents(events: NoteEvent[], density: "low" | "medium" | "high"): NoteEvent[] {
  const sorted = [...events].sort((a, b) => a.startBeat - b.startBeat);
  if (density === "high") return sorted;
  if (density === "low") return sorted.slice(0, 1);
  return sorted.filter((_, index) => index < 2);
}

function limitJump(midi: number, previousMidi: number | undefined, maxJump?: number): number {
  if (previousMidi === undefined || maxJump === undefined) return midi;
  let next = midi;
  while (Math.abs(next - previousMidi) > maxJump && next > previousMidi) next -= 12;
  while (Math.abs(next - previousMidi) > maxJump && next < previousMidi) next += 12;
  return next;
}

function simplifyPitches(root: Pitch, strategy: "root_notes" | "root_and_fifth" | "block_chords", measure: Measure): Pitch[] {
  const rootMidi = pitchToMidi(root);
  if (strategy === "root_notes") return [root];
  if (strategy === "root_and_fifth") return [root, midiToPitch(rootMidi + 7, measure.key?.fifths ?? 0)];
  return [
    root,
    midiToPitch(rootMidi + 7, measure.key?.fifths ?? 0),
    midiToPitch(rootMidi + 12, measure.key?.fifths ?? 0)
  ];
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}
