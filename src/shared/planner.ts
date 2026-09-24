import type { Pitch, ScoreOperation, Selection } from "./types";

export type PlannerContext = {
  scoreTitle?: string;
  measureCount?: number;
  noteCount?: number;
  targetRange?: Selection;
  selectedNotes?: Array<{
    id: string;
    measureNumber: number;
    startBeat: number;
    durationBeats: number;
    pitches: Pitch[];
    staff?: number;
    voice?: number;
    beam?: "begin" | "continue" | "end" | "none";
  }>;
};

export type PlannerHistoryMessage = {
  role: "assistant" | "user";
  content: string;
};

export type PlanScoreEditInput = {
  message: string;
  selection?: Selection;
  context?: PlannerContext;
  history?: PlannerHistoryMessage[];
};

export async function planScoreEdit(input: PlanScoreEditInput): Promise<{ operations: ScoreOperation[]; assistantText: string }> {
  const rawMessage = input.message ?? "";
  const message = rawMessage.toLowerCase();
  const fromMeasure = input.selection?.fromMeasure ?? 1;
  const toMeasure = input.selection?.toMeasure ?? input.context?.measureCount ?? fromMeasure;

  if (message.includes("create") || message.includes("generate") || message.includes("new sheet") || rawMessage.includes("生成")) {
    return {
      operations: [
        {
          type: "create_score",
          params: {
            title: titleFromMessage(rawMessage),
            partName: "Piano",
            key: { fifths: 0 },
            timeSignature: { beats: 4, beatType: 4 },
            divisions: 1,
            measures: beginnerPhraseMeasures()
          }
        }
      ],
      assistantText: "I created a short beginner piano phrase."
    };
  }

  if (message.includes("replace") || message.includes("rewrite measure") || rawMessage.includes("替换")) {
    return {
      operations: [
        {
          type: "replace_measures",
          range: { fromMeasure, toMeasure },
          params: { measures: beginnerPhraseMeasures(fromMeasure) }
        }
      ],
      assistantText: `I replaced measures ${fromMeasure}-${toMeasure}.`
    };
  }

  if (message.includes("rest") || rawMessage.includes("休止")) {
    return {
      operations: [
        {
          type: "insert_rest",
          measureNumber: fromMeasure,
          params: { startBeat: 0, durationBeats: 1 }
        }
      ],
      assistantText: `I inserted a rest in measure ${fromMeasure}.`
    };
  }

  if (message.includes("chord") || rawMessage.includes("和弦")) {
    return {
      operations: [
        {
          type: "insert_chord",
          measureNumber: fromMeasure,
          params: {
            startBeat: 0,
            durationBeats: 1,
            pitches: [
              { step: "C", octave: 4 },
              { step: "E", octave: 4 },
              { step: "G", octave: 4 }
            ]
          }
        }
      ],
      assistantText: `I inserted a C major chord in measure ${fromMeasure}.`
    };
  }

  if (message.includes("insert note") || rawMessage.includes("加一个音")) {
    return {
      operations: [
        {
          type: "insert_note",
          measureNumber: fromMeasure,
          params: {
            startBeat: 0,
            durationBeats: 1,
            pitch: { step: "C", octave: 4 }
          }
        }
      ],
      assistantText: `I inserted a note in measure ${fromMeasure}.`
    };
  }

  if (message.includes("arpeggio") || rawMessage.includes("琶音")) {
    return {
      operations: [
        {
          type: "rewrite_phrase",
          range: { fromMeasure, toMeasure },
          params: { strategy: "arpeggio" }
        }
      ],
      assistantText: `I rewrote measures ${fromMeasure}-${toMeasure} as an arpeggio.`
    };
  }

  if (message.includes("block chord")) {
    return {
      operations: [
        {
          type: "rewrite_phrase",
          range: { fromMeasure, toMeasure },
          params: { strategy: "block_chords" }
        }
      ],
      assistantText: `I rewrote measures ${fromMeasure}-${toMeasure} as block chords.`
    };
  }

  if (message.includes("more motion") || message.includes("more moving")) {
    return {
      operations: [
        {
          type: "rewrite_phrase",
          range: { fromMeasure, toMeasure },
          params: { strategy: "more_motion" }
        }
      ],
      assistantText: `I added more motion in measures ${fromMeasure}-${toMeasure}.`
    };
  }

  if (rawMessage.includes("左手") || message.includes("simple left hand")) {
    return {
      operations: [
        {
          type: "simplify_left_hand",
          range: { fromMeasure, toMeasure },
          params: {
            strategy: "root_and_fifth",
            rhythmDensity: "medium",
            maxJumpSemitones: 12,
            preserveRightHand: true
          }
        }
      ],
      assistantText: `I simplified the left hand in measures ${fromMeasure}-${toMeasure}.`
    };
  }

  if (rawMessage.includes("C 调") || message.includes("c major")) {
    return {
      operations: [{ type: "transpose", params: { targetKey: "C" } }],
      assistantText: "I transposed the score to C major."
    };
  }

  return {
    operations: [],
    assistantText: "I can generate a short phrase, replace measures, insert notes/rests/chords, rewrite a phrase, simplify the left hand, or transpose to C major."
  };
}

function titleFromMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Sheet";
  return cleaned.length > 42 ? `${cleaned.slice(0, 39)}...` : cleaned;
}

function beginnerPhraseMeasures(startNumber = 1) {
  return [
    {
      number: startNumber,
      events: [
        { startBeat: 0, durationBeats: 1, pitches: [{ step: "C" as const, octave: 4 }] },
        { startBeat: 1, durationBeats: 1, pitches: [{ step: "D" as const, octave: 4 }] },
        { startBeat: 2, durationBeats: 1, pitches: [{ step: "E" as const, octave: 4 }] },
        { startBeat: 3, durationBeats: 1, pitches: [{ step: "G" as const, octave: 4 }] }
      ]
    },
    {
      number: startNumber + 1,
      events: [
        { startBeat: 0, durationBeats: 2, pitches: [{ step: "F" as const, octave: 4 }] },
        { startBeat: 2, durationBeats: 1, pitches: [{ step: "E" as const, octave: 4 }] },
        { startBeat: 3, durationBeats: 1, pitches: [{ step: "C" as const, octave: 4 }] }
      ]
    }
  ];
}
