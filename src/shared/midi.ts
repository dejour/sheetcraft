import { generateTimeline, pitchToMidi } from "./operations";
import type { Measure, Score } from "./types";

const PPQ = 960;
type MidiEvent = { tick: number; order: number; bytes: number[] };

function integerBytes(value: number, length: number): number[] {
  return Array.from({ length }, (_, index) => Math.floor(value / 256 ** (length - index - 1)) & 255);
}

function variableLength(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) throw new Error("The score is too long to export as MIDI.");
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 127) | 128);
  return bytes;
}

function tick(beat: number): number {
  if (!Number.isFinite(beat) || beat < 0) throw new Error("The score contains invalid MIDI timing.");
  return Math.round(beat * PPQ);
}

function meta(type: number, data: number[], at = 0): MidiEvent {
  return { tick: at, order: 0, bytes: [255, type, ...variableLength(data.length), ...data] };
}

function trackName(name: string): MidiEvent {
  return meta(3, Array.from(new TextEncoder().encode(name)));
}

function tempo(bpm: number, at: number): MidiEvent {
  const microseconds = Math.round(60000000 / bpm);
  if (!Number.isFinite(bpm) || bpm <= 0 || microseconds < 1 || microseconds > 0xffffff) throw new Error("The tempo is outside the MIDI range.");
  return meta(0x51, integerBytes(microseconds, 3), at);
}

function measureLength(measure: Measure): number {
  return measure.durationBeats ?? measure.timeSignature.beats * 4 / measure.timeSignature.beatType;
}

function encodeTrack(events: MidiEvent[], end: number): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes: number[] = [];
  let previous = 0;
  for (const event of events) {
    bytes.push(...variableLength(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  bytes.push(...variableLength(Math.max(previous, end) - previous), 255, 0x2f, 0);
  return [77, 84, 114, 107, ...integerBytes(bytes.length, 4), ...bytes];
}

/** Standard MIDI File, format 1: conductor track followed by one piano track per part. */
export function exportMidi(score: Score, options: { bpm?: number } = {}): Uint8Array<ArrayBuffer> {
  if (!score.parts.length) throw new Error("There are no parts to export.");
  if (score.parts.length > 15) throw new Error("MIDI export supports up to 15 instrument parts.");
  const conductor: MidiEvent[] = [trackName(score.title ?? "Score")];
  const tempos = new Map<number, number>([[0, options.bpm ?? 96]]);
  let end = 0;
  score.parts.forEach((part, partIndex) => {
    let offset = 0;
    let previousTime = "";
    for (const measure of part.measures) {
      const at = tick(offset);
      if (partIndex === 0) {
        const { beats, beatType } = measure.timeSignature;
        const power = Math.log2(beatType);
        if (!Number.isInteger(beats) || beats < 1 || beats > 255 || !Number.isInteger(power) || power < 0 || power > 7) {
          throw new Error("The time signature cannot be represented in MIDI.");
        }
        const time = `${beats}/${beatType}`;
        if (time !== previousTime) conductor.push(meta(0x58, [beats, power, 24, 8], at));
        previousTime = time;
      }
      if (options.bpm === undefined) {
        for (const mark of measure.tempos ?? []) {
          const unit = mark.beatUnit === "half" ? 2 : mark.beatUnit === "eighth" ? 0.5 : 1;
          tempos.set(tick(offset + mark.startBeat), mark.bpm * unit);
        }
      }
      const length = measureLength(measure);
      if (!Number.isFinite(length) || length <= 0) throw new Error("The score contains an invalid measure length.");
      offset += length;
    }
    end = Math.max(end, tick(offset));
  });
  for (const [at, bpm] of tempos) conductor.push(tempo(bpm, at));

  const tracks = score.parts.map((part, index) => {
    // MIDI channel 10 is reserved for percussion.
    const channel = index < 9 ? index : index + 1;
    const events: MidiEvent[] = [trackName(part.name || `Part ${index + 1}`), { tick: 0, order: 0, bytes: [0xc0 | channel, 0] }];
    // Keep ties in separate voices/staves from merging with each other.
    const layers = new Set(part.measures.flatMap((measure) => measure.events.map((event) => `${event.staff ?? 1}:${event.voice ?? 1}`)));
    for (const layer of layers) {
      const scoped = { ...part, measures: part.measures.map((measure) => ({ ...measure,
        events: measure.events.filter((event) => `${event.staff ?? 1}:${event.voice ?? 1}` === layer)
      })) };
      for (const note of generateTimeline({ ...score, parts: [scoped] })) {
        const start = tick(note.startBeat);
        const stop = tick(note.startBeat + note.durationBeats);
        if (stop <= start) throw new Error("A note is too short to export as MIDI.");
        const velocity = Math.max(1, Math.min(127, Math.round((note.velocity ?? 0.75) * 127)));
        for (const pitch of note.pitches) {
          const midi = pitchToMidi(pitch);
          if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error("A pitch is outside the MIDI range (0–127).");
          events.push({ tick: start, order: 2, bytes: [0x90 | channel, midi, velocity] });
          events.push({ tick: stop, order: 1, bytes: [0x80 | channel, midi, 0] });
        }
        end = Math.max(end, stop);
      }
    }
    return events;
  });
  const chunks = [encodeTrack(conductor, end), ...tracks.map((events) => encodeTrack(events, end))];
  const header = [77, 84, 104, 100, 0, 0, 0, 6, 0, 1, ...integerBytes(chunks.length, 2), ...integerBytes(PPQ, 2)];
  const result = new Uint8Array(header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  result.set(header);
  let position = header.length;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
  return result;
}
