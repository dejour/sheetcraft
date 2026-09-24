export type Step = "A" | "B" | "C" | "D" | "E" | "F" | "G";

// Ordered XML fragments preserve notation outside the editable score model.
export type MusicXmlNode = Record<string, unknown>;

export type Pitch = {
  step: Step;
  alter?: number;
  octave: number;
};

export type PhraseMark = "start" | "stop" | "continue";
export type BeamMark = "begin" | "continue" | "end" | "none";

export type HarmonyEvent = {
  startBeat: number;
  root: Step;
  alter?: number;
  kind?: string;
  text?: string;
  bass?: { step: Step; alter?: number };
};

export type TempoEvent = {
  startBeat: number;
  bpm: number;
  beatUnit?: "quarter" | "eighth" | "half";
};

export type DynamicMark = "pp" | "p" | "mp" | "mf" | "f" | "ff";

export type DynamicEvent = {
  startBeat: number;
  mark: DynamicMark;
  staff?: number;
};

export type NoteEvent = {
  xmlNotes?: MusicXmlNode[];
  xmlDurationBeats?: number;
  id: string;
  measureNumber: number;
  startBeat: number;
  durationBeats: number;
  pitches: Pitch[];
  staff?: number;
  voice?: number;
  tie?: PhraseMark;
  slur?: PhraseMark;
  beam?: BeamMark;
};

export type Measure = {
  xmlAttributes?: MusicXmlNode[];
  xmlExtras?: Array<{ startBeat: number; node: MusicXmlNode }>;
  number: number;
  divisions: number;
  timeSignature: { beats: number; beatType: number };
  durationBeats?: number;
  implicit?: boolean;
  key?: { fifths: number };
  harmonies?: HarmonyEvent[];
  tempos?: TempoEvent[];
  dynamics?: DynamicEvent[];
  events: NoteEvent[];
};

export type Part = {
  xmlDefinition?: MusicXmlNode[];
  id: string;
  name: string;
  measures: Measure[];
};

export type Score = {
  xmlHeaders?: MusicXmlNode[];
  id: string;
  title?: string;
  parts: Part[];
};

export type NoteInput = {
  startBeat: number;
  durationBeats: number;
  pitches?: Pitch[];
  staff?: number;
  voice?: number;
  tie?: PhraseMark;
  slur?: PhraseMark;
  beam?: BeamMark;
};

export type MeasureInput = {
  number?: number;
  divisions?: number;
  timeSignature?: { beats: number; beatType: number };
  durationBeats?: number;
  implicit?: boolean;
  key?: { fifths: number };
  harmonies?: HarmonyEvent[];
  tempos?: TempoEvent[];
  dynamics?: DynamicEvent[];
  events: NoteInput[];
};

export type ScoreOperation =
  | {
      type: "create_score";
      params: {
        title?: string;
        partName?: string;
        measures: MeasureInput[];
        key?: { fifths: number };
        timeSignature?: { beats: number; beatType: number };
        divisions?: number;
      };
    }
  | {
      type: "replace_measures";
      partId?: string;
      range: { fromMeasure: number; toMeasure: number };
      params: { measures: MeasureInput[] };
    }
  | {
      type: "copy_measure";
      partId?: string;
      fromMeasure: number;
      toMeasure: number;
    }
  | {
      type: "clear_staff_in_measure";
      partId?: string;
      measureNumber: number;
      staff: number;
    }
  | {
      type: "insert_note";
      partId?: string;
      measureNumber: number;
      params: NoteInput & { pitch: Pitch };
    }
  | {
      type: "insert_rest";
      partId?: string;
      measureNumber: number;
      params: Omit<NoteInput, "pitches">;
    }
  | {
      type: "insert_chord";
      partId?: string;
      measureNumber: number;
      params: NoteInput & { pitches: Pitch[] };
    }
  | {
      type: "set_harmony";
      partId?: string;
      measureNumber: number;
      params: Partial<HarmonyEvent> & { startBeat: number; text?: string | null };
    }
  | {
      type: "set_tempo";
      partId?: string;
      measureNumber: number;
      params: { startBeat: number; bpm?: number | null; beatUnit?: "quarter" | "eighth" | "half" };
    }
  | {
      type: "set_dynamic";
      partId?: string;
      measureNumber: number;
      params: { startBeat: number; mark?: DynamicMark | null; staff?: number };
    }
  | {
      type: "rewrite_phrase";
      partId?: string;
      range: { fromMeasure: number; toMeasure: number };
      params: {
        strategy: "simpler" | "more_motion" | "block_chords" | "arpeggio";
        preserveContour?: boolean;
      };
    }
  | { type: "transpose"; params: { targetKey: string } }
  | {
      type: "simplify_left_hand";
      range: { fromMeasure: number; toMeasure: number };
      params: {
        strategy: "root_notes" | "root_and_fifth" | "block_chords";
        maxJumpSemitones?: number;
        rhythmDensity?: "low" | "medium" | "high";
        preserveRightHand?: boolean;
      };
    }
  | {
      type: "update_note";
      noteId: string;
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
      };
    }
  | { type: "delete_note"; noteId: string };

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type PlaybackEvent = {
  id: string;
  partId: string;
  measureNumber: number;
  startBeat: number;
  durationBeats: number;
  pitches: Pitch[];
  staff?: number;
  velocity?: number;
  tie?: PhraseMark;
  slur?: PhraseMark;
};

export type Selection = {
  fromMeasure?: number;
  toMeasure?: number;
  noteIds?: string[];
};
