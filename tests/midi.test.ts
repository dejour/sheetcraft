import test from "node:test";
import assert from "node:assert/strict";
import { exportMidi, type Score } from "../src/shared";

// Independent reader checks the actual SMF bytes, chunk boundaries and delta times.
function readMidi(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, length: number) => new TextDecoder().decode(bytes.slice(at, at + length));
  assert.equal(text(0, 4), "MThd");
  assert.equal(view.getUint32(4), 6);
  assert.equal(view.getUint16(8), 1);
  const count = view.getUint16(10);
  const ppq = view.getUint16(12);
  let position = 14;
  const tracks: Array<Array<{ tick: number; status: number; type?: number; data: number[] }>> = [];
  const vlq = () => {
    let value = 0;
    let byte: number;
    do { byte = bytes[position++]; value = value * 128 + (byte & 127); } while (byte & 128);
    return value;
  };
  for (let i = 0; i < count; i++) {
    assert.equal(text(position, 4), "MTrk");
    const end = position + 8 + view.getUint32(position + 4);
    position += 8;
    let tick = 0;
    const events = [];
    while (position < end) {
      tick += vlq();
      const status = bytes[position++];
      const type = status === 255 ? bytes[position++] : undefined;
      const length = status === 255 ? vlq() : (status & 0xf0) === 0xc0 ? 1 : 2;
      const data = Array.from(bytes.slice(position, position + length));
      position += length;
      events.push({ tick, status, type, data });
    }
    assert.equal(position, end);
    assert.equal(events.at(-1)?.type, 0x2f);
    tracks.push(events);
  }
  assert.equal(position, bytes.length);
  return { ppq, tracks };
}

function score(): Score {
  return { id: "test", title: "Test", parts: [{ id: "P1", name: "Piano", measures: [{
    number: 1, divisions: 1, timeSignature: { beats: 4, beatType: 4 },
    dynamics: [{ startBeat: 0, mark: "p" }],
    events: [
      { id: "rest", measureNumber: 1, startBeat: 0, durationBeats: 1, pitches: [] },
      { id: "chord", measureNumber: 1, startBeat: 1, durationBeats: 0.5, pitches: [{ step: "C", octave: 4 }, { step: "E", octave: 4 }] },
      { id: "triplet", measureNumber: 1, startBeat: 2, durationBeats: 1 / 3, pitches: [{ step: "G", alter: 1, octave: 4 }] }
    ]
  }] }] };
}

test("MIDI exports rests as silence, chords, fractions, velocities and trailing silence", () => {
  const midi = readMidi(exportMidi(score()));
  assert.equal(midi.ppq, 960);
  assert.equal(midi.tracks.length, 2);
  const notes = midi.tracks[1].filter((event) => (event.status & 0xe0) === 0x80);
  assert.deepEqual(notes.map((event) => [event.tick, event.status, ...event.data]), [
    [960, 0x90, 60, 61], [960, 0x90, 64, 61],
    [1440, 0x80, 60, 0], [1440, 0x80, 64, 0],
    [1920, 0x90, 68, 61], [2240, 0x80, 68, 0]
  ]);
  assert.equal(midi.tracks[1].at(-1)?.tick, 3840);
});

test("MIDI writes tempo maps, beat units and time signature changes", () => {
  const input = score();
  const measure = input.parts[0].measures[0];
  measure.tempos = [{ startBeat: 0, bpm: 60, beatUnit: "half" }, { startBeat: 2, bpm: 90 }];
  input.parts[0].measures.push({ ...measure, number: 2, timeSignature: { beats: 3, beatType: 8 }, tempos: [], events: [] });
  const conductor = readMidi(exportMidi(input)).tracks[0];
  assert.deepEqual(conductor.filter((event) => event.type === 0x51).map((event) => [event.tick, event.data.reduce((n, byte) => n * 256 + byte, 0)]), [[0, 500000], [1920, 666667]]);
  assert.deepEqual(conductor.filter((event) => event.type === 0x58).map((event) => [event.tick, ...event.data]), [[0, 4, 2, 24, 8], [3840, 3, 3, 24, 8]]);
  const override = readMidi(exportMidi(input, { bpm: 100 })).tracks[0].filter((event) => event.type === 0x51);
  assert.equal(override.length, 1);
  assert.deepEqual(override[0].data, [9, 39, 192]);
});

test("MIDI creates separate named instrument tracks and skips the percussion channel", () => {
  const input = score();
  input.parts = Array.from({ length: 11 }, (_, index) => ({ ...structuredClone(input.parts[0]), id: `P${index}`, name: `Part ${index}` }));
  const midi = readMidi(exportMidi(input));
  assert.equal(midi.tracks.length, 12);
  const last = midi.tracks[11];
  assert.equal(new TextDecoder().decode(Uint8Array.from(last[0].data)), "Part 10");
  assert.equal(last.find((event) => (event.status & 0xf0) === 0x90)?.status, 0x9b);
  assert.ok(midi.tracks.every((track) => track.every((event) => event.status !== 0x99)));
});

test("MIDI ties sustain across barlines and repeated notes release before retriggering", () => {
  const input = score();
  const measure = input.parts[0].measures[0];
  measure.events = [{ id: "a", measureNumber: 1, startBeat: 3, durationBeats: 1, pitches: [{ step: "C", octave: 4 }], tie: "start" }];
  input.parts[0].measures.push({ ...measure, number: 2, events: [
    { ...measure.events[0], id: "b", measureNumber: 2, startBeat: 0, tie: "stop" },
    { ...measure.events[0], id: "c", measureNumber: 2, startBeat: 1, tie: undefined }
  ] });
  const notes = readMidi(exportMidi(input)).tracks[1].filter((event) => (event.status & 0xe0) === 0x80);
  assert.deepEqual(notes.map((event) => [event.tick, event.status]), [[2880, 0x90], [4800, 0x80], [4800, 0x90], [5760, 0x80]]);
});

test("MIDI rejects invalid pitches and tempos rather than producing corrupt files", () => {
  const input = score();
  input.parts[0].measures[0].events[1].pitches[0].octave = 20;
  assert.throws(() => exportMidi(input), /pitch.*MIDI range/);
  assert.throws(() => exportMidi(score(), { bpm: 0 }), /tempo/);
  assert.throws(() => exportMidi({ id: "empty", parts: [] }), /no parts/);
});
