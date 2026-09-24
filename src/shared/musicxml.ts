import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { BeamMark, DynamicEvent, HarmonyEvent, Measure, NoteEvent, Part, PhraseMark, Pitch, Score, TempoEvent } from "./types";

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true
});

const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true,
  preserveOrder: true
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true
});

const orderedBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  preserveOrder: true,
  suppressEmptyNode: true
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && "#text" in (value as XmlNode)) {
    return String((value as XmlNode)["#text"]);
  }
  return String(value);
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasTag(node: XmlNode, tag: string): boolean {
  return Object.prototype.hasOwnProperty.call(node, tag);
}

function getPitch(note: XmlNode): Pitch | undefined {
  const pitch = note.pitch as XmlNode | undefined;
  if (!pitch) return undefined;
  const step = text(pitch.step) as Pitch["step"] | undefined;
  const octave = numberValue(pitch.octave, Number.NaN);
  if (!step || !Number.isFinite(octave)) return undefined;
  const alter = pitch.alter === undefined ? undefined : numberValue(pitch.alter, 0);
  return normalizePitch({ step, octave, ...(alter ? { alter } : {}) });
}

function normalizePitch(pitch: Pitch): Pitch {
  const rawStep = String(pitch.step);
  const match = rawStep.match(/^([A-G])([#b])?$/);
  if (!match) return { step: "C", octave: pitch.octave, ...(pitch.alter ? { alter: pitch.alter } : {}) };
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const alter = (pitch.alter ?? 0) + accidental;
  return { step: match[1] as Pitch["step"], octave: pitch.octave, ...(alter ? { alter } : {}) };
}

function xmlId(prefix: string, parts: Array<string | number>): string {
  return `${prefix}_${parts.join("_")}`;
}

type OrderedItem = {
  [tag: string]: unknown;
  ":@"?: XmlNode;
};

function orderedContent(item: OrderedItem, tag: string): OrderedItem[] {
  const content = item[tag];
  return Array.isArray(content) ? (content as OrderedItem[]) : [];
}

function orderedFind(items: OrderedItem[], tag: string): OrderedItem | undefined {
  return items.find((item) => Object.prototype.hasOwnProperty.call(item, tag));
}

function orderedChildren(items: OrderedItem[], tag: string): OrderedItem[] {
  return items.filter((item) => Object.prototype.hasOwnProperty.call(item, tag));
}

function orderedText(items: OrderedItem[], tag: string): string | undefined {
  const item = orderedFind(items, tag);
  if (!item) return undefined;
  const content = orderedContent(item, tag);
  const textItem = orderedFind(content, "#text");
  return text((textItem?.["#text"] as string | number | undefined) ?? item[tag]);
}

function orderedNumber(items: OrderedItem[], tag: string, fallback: number): number {
  const parsed = Number(orderedText(items, tag));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function orderedHas(items: OrderedItem[], tag: string): boolean {
  return Boolean(orderedFind(items, tag));
}

function getOrderedPitch(noteItems: OrderedItem[]): Pitch | undefined {
  const pitchItem = orderedFind(noteItems, "pitch");
  if (!pitchItem) return undefined;
  const pitchItems = orderedContent(pitchItem, "pitch");
  const step = orderedText(pitchItems, "step") as Pitch["step"] | undefined;
  const octave = orderedNumber(pitchItems, "octave", Number.NaN);
  if (!step || !Number.isFinite(octave)) return undefined;
  const alterText = orderedText(pitchItems, "alter");
  const alter = alterText === undefined ? undefined : Number(alterText);
  return normalizePitch({ step, octave, ...(alter ? { alter } : {}) });
}

function getOrderedHarmony(harmonyItems: OrderedItem[], startBeat: number): HarmonyEvent | undefined {
  const root = orderedFind(harmonyItems, "root");
  if (!root) return undefined;
  const rootItems = orderedContent(root, "root");
  const rootStep = orderedText(rootItems, "root-step") as HarmonyEvent["root"] | undefined;
  if (!rootStep) return undefined;
  const rootAlterText = orderedText(rootItems, "root-alter");
  const rootAlter = rootAlterText === undefined ? undefined : Number(rootAlterText);
  const kindItem = orderedFind(harmonyItems, "kind");
  const kindItems = kindItem ? orderedContent(kindItem, "kind") : [];
  const kind = kindItem ? String(orderedText(kindItems, "#text") ?? text(kindItem["kind"]) ?? "major") : "major";
  const displayText = kindItem?.[":@"]?.["@_text"] === undefined ? undefined : String(kindItem[":@"]?.["@_text"]);
  const bass = orderedFind(harmonyItems, "bass");
  const bassItems = bass ? orderedContent(bass, "bass") : [];
  const bassStep = orderedText(bassItems, "bass-step") as HarmonyEvent["root"] | undefined;
  const bassAlterText = orderedText(bassItems, "bass-alter");
  const bassAlter = bassAlterText === undefined ? undefined : Number(bassAlterText);
  return {
    startBeat,
    root: rootStep,
    ...(rootAlter ? { alter: rootAlter } : {}),
    kind,
    ...(displayText ? { text: displayText } : {}),
    ...(bassStep ? { bass: { step: bassStep, ...(bassAlter ? { alter: bassAlter } : {}) } } : {})
  };
}

function getOrderedDirection(directionItems: OrderedItem[], startBeat: number): { tempo?: TempoEvent; dynamic?: DynamicEvent } {
  const result: { tempo?: TempoEvent; dynamic?: DynamicEvent } = {};
  const typeItems = orderedChildren(directionItems, "direction-type").flatMap((item) => orderedContent(item, "direction-type"));
  const metronome = orderedFind(typeItems, "metronome");
  const sound = orderedFind(directionItems, "sound");
  const soundTempo = sound?.[":@"]?.["@_tempo"] === undefined ? undefined : Number(sound[":@"]?.["@_tempo"]);

  if (metronome || Number.isFinite(soundTempo)) {
    const metronomeItems = metronome ? orderedContent(metronome, "metronome") : [];
    const perMinute = orderedNumber(metronomeItems, "per-minute", Number.isFinite(soundTempo) ? Number(soundTempo) : Number.NaN);
    const beatUnit = orderedText(metronomeItems, "beat-unit") as TempoEvent["beatUnit"] | undefined;
    if (Number.isFinite(perMinute)) result.tempo = { startBeat, bpm: perMinute, beatUnit: beatUnit ?? "quarter" };
  }

  const dynamics = orderedFind(typeItems, "dynamics");
  if (dynamics) {
    const dynamicItems = orderedContent(dynamics, "dynamics");
    const mark = dynamicItems.map((item) => Object.keys(item).find((key) => key !== ":@")).find(Boolean) as DynamicEvent["mark"] | undefined;
    if (isDynamicMark(mark)) {
      const staff = orderedNumber(directionItems, "staff", Number.NaN);
      result.dynamic = { startBeat, mark, ...(Number.isFinite(staff) ? { staff } : {}) };
    }
  }

  return result;
}

function isDynamicMark(value: unknown): value is DynamicEvent["mark"] {
  return value === "pp" || value === "p" || value === "mp" || value === "mf" || value === "f" || value === "ff";
}

function orderedMark(noteItems: OrderedItem[], tag: "tie" | "tied" | "slur"): PhraseMark | undefined {
  const sourceItems =
    tag === "tie"
      ? orderedChildren(noteItems, "tie")
      : orderedChildren(noteItems, "notations").flatMap((notations) => orderedChildren(orderedContent(notations, "notations"), tag));
  const types = sourceItems.map((item) => String(item[":@"]?.["@_type"] ?? "")).filter(isPhraseMarkType);
  if (types.includes("start") && types.includes("stop")) return "continue";
  if (types.includes("continue")) return "continue";
  if (types.includes("start")) return "start";
  if (types.includes("stop")) return "stop";
  return undefined;
}

const BEAM_NONE_NOTATION = "aisheet-beam-none";

function orderedBeam(noteItems: OrderedItem[]): BeamMark | undefined {
  const value = orderedText(noteItems, "beam");
  if (isBeamValue(value)) return value;
  const otherNotation = orderedChildren(noteItems, "notations")
    .flatMap((notations) => orderedChildren(orderedContent(notations, "notations"), "other-notation"))
    .find((item) => orderedText([item], "other-notation") === BEAM_NONE_NOTATION);
  return otherNotation ? "none" : undefined;
}

function isPhraseMarkType(value: string): value is PhraseMark {
  return value === "start" || value === "stop" || value === "continue";
}

function isBeamValue(value: unknown): value is Exclude<BeamMark, "none"> {
  return value === "begin" || value === "continue" || value === "end";
}

export function parseMusicXML(xml: string): Score {
  const doc = parser.parse(xml) as XmlNode;
  const orderedDoc = orderedParser.parse(xml) as OrderedItem[];
  const root = (doc["score-partwise"] ?? doc["score-timewise"]) as XmlNode | undefined;
  if (!root || !doc["score-partwise"]) throw new Error("Only score-partwise MusicXML is supported.");
  const orderedRootItem = orderedFind(orderedDoc, "score-partwise");
  const orderedRoot = orderedRootItem ? orderedContent(orderedRootItem, "score-partwise") : [];

  const title =
    text(root["movement-title"]) ??
    text((root.work as XmlNode | undefined)?.["work-title"]) ??
    "Untitled score";
  const partList = (root["part-list"] as XmlNode | undefined) ?? {};
  const scoreParts = asArray(partList["score-part"] as XmlNode | XmlNode[] | undefined);
  const partNames = new Map<string, string>();
  for (const scorePart of scoreParts) {
    const id = String(scorePart["@_id"] ?? "");
    if (id) partNames.set(id, text(scorePart["part-name"]) ?? id);
  }

  const orderedParts = orderedChildren(orderedRoot, "part");
  const fallbackParts = asArray(root.part as XmlNode | XmlNode[] | undefined);
  const sourceParts = orderedParts.length ? orderedParts : fallbackParts.map((part) => ({ part, ":@": { "@_id": part["@_id"] } }));

  const usedNoteIds = new Set<string>();
  const parts = sourceParts.map((partNode, partIndex): Part => {
    const partId = String(partNode[":@"]?.["@_id"] ?? `P${partIndex + 1}`);
    const partItems = orderedContent(partNode, "part");
    let currentDivisions = 1;
    let currentTime = { beats: 4, beatType: 4 };
    let currentKey: { fifths: number } | undefined;

    const measures = orderedChildren(partItems, "measure").map((measureNode, measureIndex): Measure => {
      const number = Number(measureNode[":@"]?.["@_number"] ?? measureIndex + 1);
      const measureItems = orderedContent(measureNode, "measure");

      let cursorDivisions = 0;
      const events: NoteEvent[] = [];
      const harmonies: HarmonyEvent[] = [];
      const tempos: TempoEvent[] = [];
      const dynamics: DynamicEvent[] = [];
      let eventIndex = 0;
      const xmlAttributes: OrderedItem[] = [];
      const xmlExtras: Array<{ startBeat: number; node: OrderedItem }> = [];

      for (const item of measureItems) {
        if (hasTag(item, "attributes")) {
          const attributes = orderedContent(item, "attributes");
          if (cursorDivisions !== 0) throw new Error("Mid-measure attribute changes are not supported for editing.");
          xmlAttributes.push(...attributes.filter((child) => !hasTag(child, "divisions") && !hasTag(child, "key") && !hasTag(child, "time")));
          const divisions = orderedText(attributes, "divisions");
          if (divisions !== undefined) currentDivisions = Math.max(1, Number(divisions));
          const key = orderedFind(attributes, "key");
          if (key) currentKey = { fifths: orderedNumber(orderedContent(key, "key"), "fifths", 0) };
          const time = orderedFind(attributes, "time");
          if (time) {
            const timeItems = orderedContent(time, "time");
            currentTime = {
              beats: orderedNumber(timeItems, "beats", currentTime.beats),
              beatType: orderedNumber(timeItems, "beat-type", currentTime.beatType)
            };
          }
          continue;
        }

        if (hasTag(item, "backup")) {
          cursorDivisions = Math.max(0, cursorDivisions - orderedNumber(orderedContent(item, "backup"), "duration", 0));
          continue;
        }

        if (hasTag(item, "forward")) {
          cursorDivisions += orderedNumber(orderedContent(item, "forward"), "duration", 0);
          continue;
        }

        if (hasTag(item, "harmony")) {
          const harmonyItems = orderedContent(item, "harmony");
          const offsetDivisions = orderedNumber(harmonyItems, "offset", 0);
          const harmony = getOrderedHarmony(harmonyItems, (cursorDivisions + offsetDivisions) / currentDivisions);
          if (harmony) harmonies.push(harmony);
          continue;
        }

        if (hasTag(item, "direction")) {
          const directionItems = orderedContent(item, "direction");
          const offsetDivisions = orderedNumber(directionItems, "offset", 0);
          const direction = getOrderedDirection(directionItems, (cursorDivisions + offsetDivisions) / currentDivisions);
          if (direction.tempo) tempos.push(direction.tempo);
          if (direction.dynamic) dynamics.push(direction.dynamic);
          const remaining = structuredClone(item);
          remaining.direction = orderedContent(remaining, "direction").filter((child) => {
            if (hasTag(child, "direction-type")) {
              child["direction-type"] = orderedContent(child, "direction-type").filter((mark) =>
                !(direction.tempo && hasTag(mark, "metronome")) && !(direction.dynamic && hasTag(mark, "dynamics")));
              return (child["direction-type"] as unknown[]).length > 0;
            }
            if (direction.tempo && hasTag(child, "sound")) {
              delete child[":@"]?.["@_tempo"];
              return Object.keys(child[":@"] ?? {}).length > 0;
            }
            return true;
          });
          if (orderedContent(remaining, "direction").some((child) => hasTag(child, "direction-type") || hasTag(child, "sound"))) {
            xmlExtras.push({ startBeat: cursorDivisions / currentDivisions, node: remaining });
          }
          continue;
        }

        if (!hasTag(item, "note")) {
          xmlExtras.push({ startBeat: cursorDivisions / currentDivisions, node: item });
          continue;
        }
        if (orderedHas(orderedContent(item, "note"), "grace")) {
          throw new Error("Grace notes are not supported for editing yet.");
        }
        const noteItems = orderedContent(item, "note");
        const durationDivisions = orderedNumber(noteItems, "duration", 0);
        const isChord = orderedHas(noteItems, "chord");
        const voiceText = orderedText(noteItems, "voice");
        const staffText = orderedText(noteItems, "staff");
        const voice = voiceText === undefined ? undefined : Number(voiceText);
        const staff = staffText === undefined ? 1 : Number(staffText);
        const pitch = getOrderedPitch(noteItems);
        const tie = orderedMark(noteItems, "tie") ?? orderedMark(noteItems, "tied");
        const slur = orderedMark(noteItems, "slur");
        const beam = orderedBeam(noteItems);

        if (isChord) {
          const previous = [...events]
            .reverse()
            .find((event) => (staff === undefined || event.staff === staff) && (voice === undefined || event.voice === voice) && event.pitches.length > 0);
          if (previous && pitch) {
            previous.pitches.push(pitch);
            previous.xmlNotes?.push(item);
            previous.durationBeats = Math.max(previous.durationBeats, durationDivisions / currentDivisions);
            if (tie) previous.tie = tie;
            if (slur) previous.slur = slur;
            if (beam) previous.beam = beam;
          }
          continue;
        }

        const fallbackId = xmlId("n", [partId, number, eventIndex++]);
        const sourceId = String(item[":@"]?.["@_id"] ?? fallbackId);
        const id = usedNoteIds.has(sourceId) ? `${fallbackId}_${crypto.randomUUID()}` : sourceId;
        usedNoteIds.add(id);
        const event: NoteEvent = {
          id,
          xmlNotes: [item],
          xmlDurationBeats: durationDivisions / currentDivisions,
          measureNumber: number,
          startBeat: cursorDivisions / currentDivisions,
          durationBeats: durationDivisions / currentDivisions,
          pitches: pitch ? [pitch] : [],
          ...(staff ? { staff } : {}),
          ...(voice ? { voice } : {}),
          ...(tie ? { tie } : {}),
          ...(slur ? { slur } : {}),
          ...(beam ? { beam } : {})
        };
        events.push(event);
        cursorDivisions += durationDivisions;
      }

      return {
        number,
        xmlAttributes,
        xmlExtras,
        divisions: currentDivisions,
        timeSignature: currentTime,
        ...(measureNode[":@"]?.["@_implicit"] === "yes" ? { implicit: true } : {}),
        ...(measureNode[":@"]?.["@_implicit"] === "yes" ? { durationBeats: cursorDivisions / currentDivisions } : {}),
        ...(currentKey ? { key: currentKey } : {}),
        ...(harmonies.length ? { harmonies } : {}),
        ...(tempos.length ? { tempos } : {}),
        ...(dynamics.length ? { dynamics } : {}),
        events
      };
    });

    return {
      id: partId,
      xmlDefinition: orderedContent(orderedChildren(orderedContent(orderedFind(orderedRoot, "part-list") ?? {}, "part-list"), "score-part").find((item) => item[":@"]?.["@_id"] === partId) ?? {}, "score-part"),
      name: partNames.get(partId) ?? partId,
      measures
    };
  });

  return {
    id: xmlId("score", [Date.now().toString(36)]),
    title,
    xmlHeaders: orderedRoot.filter((item) => !["movement-title", "part-list", "part"].some((tag) => hasTag(item, tag))),
    parts
  };
}

function pitchToXml(pitch: Pitch): XmlNode {
  const normalized = normalizePitch(pitch);
  return {
    step: normalized.step,
    ...(normalized.alter ? { alter: normalized.alter } : {}),
    octave: normalized.octave
  };
}

function durationDivisions(event: NoteEvent, measure: Measure): number {
  return Math.max(1, Math.round(event.durationBeats * measure.divisions));
}

function noteToXml(event: NoteEvent, measure: Measure, pitch?: Pitch, chord = false): XmlNode {
  const notation = durationNotation(event.durationBeats);
  const notations = notationToXml(event, chord);
  const staff = event.staff ?? displayStaff(event);
  return {
    ...(chord ? { chord: "" } : {}),
    ...(pitch ? { pitch: pitchToXml(pitch) } : { rest: restDisplay(staff) }),
    duration: durationDivisions(event, measure),
    voice: event.voice ?? 1,
    type: notation.type,
    ...(notation.dots ? { dot: notation.dots === 1 ? "" : Array.from({ length: notation.dots }, () => "") } : {}),
    ...(event.tie ? { tie: markTypes(event.tie).map((type) => ({ "@_type": type })) } : {}),
    ...(notations ? { notations } : {}),
    ...(event.staff ? { staff: event.staff } : {})
  };
}

function notationToXml(event: NoteEvent, chord: boolean): XmlNode | undefined {
  const tied = event.tie ? markTypes(event.tie).map((type) => ({ "@_type": type })) : [];
  const slur = event.slur && !chord ? markTypes(event.slur).map((type) => ({ "@_type": type })) : [];
  if (!tied.length && !slur.length) return undefined;
  return {
    ...(tied.length ? { tied } : {}),
    ...(slur.length ? { slur } : {})
  };
}

function markTypes(mark: PhraseMark): Array<"start" | "stop"> {
  return mark === "continue" ? ["stop", "start"] : [mark];
}

function durationType(beats: number): string {
  return durationNotation(beats).type;
}

function durationNotation(beats: number): { type: string; dots: number; timeModification?: { actual: number; normal: number } } {
  const durations = [
    { type: "whole", beats: 4 },
    { type: "half", beats: 2 },
    { type: "quarter", beats: 1 },
    { type: "eighth", beats: 0.5 },
    { type: "16th", beats: 0.25 },
    { type: "32nd", beats: 0.125 }
  ];

  for (const duration of durations) {
    if (Math.abs(beats - duration.beats) < 1e-9) return { type: duration.type, dots: 0 };
    if (Math.abs(beats - duration.beats * 1.5) < 1e-9) return { type: duration.type, dots: 1 };
    if (Math.abs(beats - duration.beats * 1.75) < 1e-9) return { type: duration.type, dots: 2 };
  }

  const base = [...durations].reverse().find((duration) => duration.beats >= beats) ?? durations[0];
  for (let actual = 1; actual <= 128; actual++) {
    const normal = Math.round(beats / base.beats * actual);
    if (normal > 0 && Math.abs(base.beats * normal / actual - beats) < 1e-9) {
      return { type: base.type, dots: 0, timeModification: { actual, normal } };
    }
  }
  throw new Error("This note duration cannot be notated accurately.");
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

type OrderedXmlNode = Record<string, unknown>;

function orderedElement(tag: string, children: OrderedXmlNode[] = [], attributes?: XmlNode): OrderedXmlNode {
  return attributes ? { [tag]: children, ":@": attributes } : { [tag]: children };
}

function orderedTextElement(tag: string, value: string | number, attributes?: XmlNode): OrderedXmlNode {
  return orderedElement(tag, [{ "#text": value }], attributes);
}

function orderedPitch(pitch: Pitch): OrderedXmlNode {
  const normalized = normalizePitch(pitch);
  return orderedElement("pitch", [
    orderedTextElement("step", normalized.step),
    ...(normalized.alter ? [orderedTextElement("alter", normalized.alter)] : []),
    orderedTextElement("octave", normalized.octave)
  ]);
}

function orderedAttributes(measure: Measure, staves: number): OrderedXmlNode {
  return orderedElement("attributes", [
    orderedTextElement("divisions", measure.divisions),
    ...(staves > 1 && !measure.xmlAttributes?.some((item) => hasTag(item, "staves")) ? [orderedTextElement("staves", staves)] : []),
    ...(measure.key ? [orderedElement("key", [orderedTextElement("fifths", measure.key.fifths)])] : []),
    orderedElement("time", [
      orderedTextElement("beats", measure.timeSignature.beats),
      orderedTextElement("beat-type", measure.timeSignature.beatType)
    ]),
    ...(measure.xmlAttributes ?? []),
    ...(!measure.xmlAttributes ? [
      orderedElement("clef", [orderedTextElement("sign", "G"), orderedTextElement("line", 2)], { "@_number": "1" }),
      ...(staves > 1 ? [orderedElement("clef", [orderedTextElement("sign", "F"), orderedTextElement("line", 4)], { "@_number": "2" })] : [])
    ] : [])
  ]);
}

type BeamValue = Exclude<BeamMark, "none">;

function orderedNote(
  event: NoteEvent,
  measure: Measure,
  pitch: Pitch | undefined,
  staff: number,
  chord = false,
  beam?: BeamValue,
  stem?: "up" | "down",
  pitchIndex = 0
): OrderedXmlNode {
  const notation = durationNotation(event.durationBeats);
  const notations = orderedNotations(event, chord);
  const generated = orderedElement("note", [
    ...(chord ? [orderedTextElement("chord", "")] : []),
    pitch ? orderedPitch(pitch) : orderedRest(staff),
    orderedTextElement("duration", durationDivisions(event, measure)),
    ...(event.tie ? markTypes(event.tie).map((type) => orderedElement("tie", [], { "@_type": type })) : []),
    orderedTextElement("voice", event.voice ?? 1),
    orderedTextElement("type", notation.type),
    ...Array.from({ length: notation.dots }, () => orderedTextElement("dot", "")),
    ...(notation.timeModification ? [orderedElement("time-modification", [
      orderedTextElement("actual-notes", notation.timeModification.actual),
      orderedTextElement("normal-notes", notation.timeModification.normal)
    ])] : []),
    ...(stem && !chord && notation.type !== "whole" ? [orderedTextElement("stem", stem)] : []),
    orderedTextElement("staff", staff),
    ...(beam && !chord ? [orderedTextElement("beam", beam, { "@_number": "1" })] : []),
    ...(notations ? [notations] : [])
  ], { "@_id": chord ? `${event.id}_chord_${pitchIndex}` : event.id });
  const original = event.xmlNotes?.[pitchIndex] as OrderedItem | undefined;
  if (original) {
    const originalItems = orderedContent(original, "note");
    const generatedItems = generated.note as OrderedXmlNode[];
    const replaced = new Set(["chord", "pitch", "rest", "duration", "tie", "voice", "type", "dot", "stem", "staff", "beam", "notations", "accidental", "time-modification"]);
    generatedItems.push(...originalItems.filter((item) => !Object.keys(item).some((tag) => replaced.has(tag))));
    const unchangedRhythm = Math.abs((event.xmlDurationBeats ?? -1) - event.durationBeats) < 1e-9;
    if (unchangedRhythm && orderedHas(originalItems, "type")) {
      const rhythmTags = ["type", "dot", "time-modification"];
      generated.note = generatedItems.filter((item) => !rhythmTags.some((tag) => hasTag(item, tag)));
      (generated.note as OrderedXmlNode[]).push(...originalItems.filter((item) => rhythmTags.some((tag) => hasTag(item, tag))));
    }
    const extras = orderedChildren(originalItems, "notations").flatMap((item) => orderedContent(item, "notations"))
      .filter((item) => !["tied", "slur"].some((tag) => hasTag(item, tag)) && orderedText([item], "other-notation") !== BEAM_NONE_NOTATION);
    if (extras.length) {
      const items = generated.note as OrderedXmlNode[];
      const existing = items.find((item) => hasTag(item, "notations"));
      if (existing) (existing.notations as OrderedXmlNode[]).push(...extras);
      else items.push(orderedElement("notations", extras));
    }
    generated[":@"] = { ...original[":@"], ...(generated[":@"] as XmlNode) };
  }
  const noteOrder = ["chord", "pitch", "rest", "duration", "tie", "instrument", "footnote", "level", "voice", "type", "dot", "accidental", "time-modification", "stem", "notehead", "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen"];
  (generated.note as OrderedXmlNode[]).sort((a, b) => {
    const rank = (item: OrderedXmlNode) => {
      const index = noteOrder.findIndex((tag) => hasTag(item, tag));
      return index < 0 ? noteOrder.length : index;
    };
    return rank(a) - rank(b);
  });
  return generated;
}

function orderedHarmony(harmony: HarmonyEvent, measure: Measure): OrderedXmlNode {
  const kind = harmony.kind ?? harmonyKindFromText(harmony.text);
  return orderedElement("harmony", [
    orderedElement("root", [
      orderedTextElement("root-step", harmony.root),
      ...(harmony.alter ? [orderedTextElement("root-alter", harmony.alter)] : [])
    ]),
    orderedTextElement("kind", kind, harmony.text && harmony.text !== harmony.root ? { "@_text": harmonyKindText(harmony) } : undefined),
    ...(harmony.bass
      ? [
          orderedElement("bass", [
            orderedTextElement("bass-step", harmony.bass.step),
            ...(harmony.bass.alter ? [orderedTextElement("bass-alter", harmony.bass.alter)] : [])
          ])
        ]
      : []),
    ...(harmony.startBeat ? [orderedTextElement("offset", Math.round(harmony.startBeat * measure.divisions))] : [])
  ]);
}

function orderedTempo(tempo: TempoEvent, measure: Measure): OrderedXmlNode {
  return orderedElement(
    "direction",
    [
      orderedElement("direction-type", [
        orderedElement("metronome", [
          orderedTextElement("beat-unit", tempo.beatUnit ?? "quarter"),
          orderedTextElement("per-minute", tempo.bpm)
        ])
      ]),
      ...(tempo.startBeat ? [orderedTextElement("offset", Math.round(tempo.startBeat * measure.divisions))] : []),
      orderedTextElement("sound", "", { "@_tempo": tempo.bpm })
    ],
    { "@_placement": "above" }
  );
}

function orderedDynamic(dynamic: DynamicEvent, measure: Measure): OrderedXmlNode {
  return orderedElement(
    "direction",
    [
      orderedElement("direction-type", [orderedElement("dynamics", [orderedTextElement(dynamic.mark, "")])]),
      ...(dynamic.startBeat ? [orderedTextElement("offset", Math.round(dynamic.startBeat * measure.divisions))] : []),
      ...(dynamic.staff ? [orderedTextElement("staff", dynamic.staff)] : [])
    ],
    { "@_placement": "below" }
  );
}

function harmonyKindText(harmony: HarmonyEvent): string {
  const textValue = harmony.text ?? "";
  const bassIndex = textValue.indexOf("/");
  const withoutBass = bassIndex >= 0 ? textValue.slice(0, bassIndex) : textValue;
  return withoutBass.replace(/^[A-G](?:#|b|♯|♭)?/, "");
}

function harmonyKindFromText(textValue: string | undefined): string {
  if (!textValue) return "major";
  const match = textValue.match(/^[A-G](?:#|b|♯|♭)?(.*?)(?:\/[A-G](?:#|b|♯|♭)?)?$/);
  const suffix = (match?.[1] ?? "").trim().toLowerCase();
  if (!suffix) return "major";
  if (suffix === "m" || suffix === "min") return "minor";
  if (suffix === "m7" || suffix === "min7") return "minor-seventh";
  if (suffix === "maj7" || suffix === "ma7" || suffix === "major7") return "major-seventh";
  if (suffix === "7") return "dominant";
  if (suffix === "dim") return "diminished";
  if (suffix === "aug") return "augmented";
  if (suffix === "sus2") return "suspended-second";
  if (suffix === "sus4" || suffix === "sus") return "suspended-fourth";
  return "other";
}

function restDisplay(staff: number): XmlNode {
  return staff === 2 ? { "display-step": "D", "display-octave": 3 } : { "display-step": "B", "display-octave": 4 };
}

function orderedRest(staff: number): OrderedXmlNode {
  const display = restDisplay(staff);
  return orderedElement("rest", [
    orderedTextElement("display-step", display["display-step"] as string),
    orderedTextElement("display-octave", display["display-octave"] as number)
  ]);
}

function orderedNotations(event: NoteEvent, chord: boolean): OrderedXmlNode | undefined {
  const children = [
    ...(event.tie ? markTypes(event.tie).map((type) => orderedElement("tied", [], { "@_type": type })) : []),
    ...(event.slur && !chord ? markTypes(event.slur).map((type) => orderedElement("slur", [], { "@_type": type })) : []),
    ...(event.beam === "none" && !chord ? [orderedTextElement("other-notation", BEAM_NONE_NOTATION, { "@_type": "single", "@_number": "1" })] : [])
  ];
  return children.length ? orderedElement("notations", children) : undefined;
}

function orderedForward(duration: number): OrderedXmlNode {
  return orderedElement("forward", [orderedTextElement("duration", duration)]);
}

function orderedBackup(duration: number): OrderedXmlNode {
  return orderedElement("backup", [orderedTextElement("duration", duration)]);
}

function lowestPitch(event: NoteEvent): Pitch | undefined {
  return event.pitches.reduce<Pitch | undefined>((lowest, pitch) => {
    if (!lowest) return pitch;
    return pitchToMidi(pitch) < pitchToMidi(lowest) ? pitch : lowest;
  }, undefined);
}

function pitchToMidi(pitch: Pitch): number {
  const semitones: Record<Pitch["step"], number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (pitch.octave + 1) * 12 + semitones[pitch.step] + (pitch.alter ?? 0);
}

function displayStaff(event: NoteEvent): number {
  if (event.staff) return event.staff;
  const lowest = lowestPitch(event);
  return lowest && pitchToMidi(lowest) < 60 ? 2 : 1;
}

function needsGrandStaff(part: Part): boolean {
  if (part.measures.some((measure) => measure.xmlAttributes !== undefined)) {
    return part.measures.some((measure) => measure.events.some((event) => (event.staff ?? 1) > 1) ||
      orderedNumber(measure.xmlAttributes ?? [], "staves", 1) > 1);
  }
  const partName = part.name ?? "";
  return partName.toLowerCase().includes("piano") || part.measures.some((measure) => measure.events.some((event) => displayStaff(event) === 2));
}

function measureLengthDivisions(measure: Measure): number {
  return Math.round((measure.durationBeats ?? measure.timeSignature.beats * (4 / measure.timeSignature.beatType)) * measure.divisions);
}

function sameAttributes(previous: Measure | undefined, current: Measure): boolean {
  return Boolean(
    previous &&
      previous.divisions === current.divisions &&
      previous.timeSignature.beats === current.timeSignature.beats &&
      previous.timeSignature.beatType === current.timeSignature.beatType &&
      (previous.key?.fifths ?? 0) === (current.key?.fifths ?? 0) &&
      !(current.xmlAttributes?.length)
  );
}

function orderedMeasureNotes(measure: Measure): OrderedXmlNode[] {
  const result: OrderedXmlNode[] = [];
  for (const tempo of measure.tempos ?? []) {
    result.push(orderedTempo(tempo, measure));
  }
  for (const dynamic of measure.dynamics ?? []) {
    result.push(orderedDynamic(dynamic, measure));
  }
  for (const harmony of measure.harmonies ?? []) {
    result.push(orderedHarmony(harmony, measure));
  }

  const events = mergeChordEvents(measure.events).sort((a, b) => displayStaff(a) - displayStaff(b) || (a.voice ?? 1) - (b.voice ?? 1) || a.startBeat - b.startBeat);
  const multiVoiceStaffs = stavesWithMultipleVoices(events);
  const layers = new Map<string, NoteEvent[]>();

  for (const event of events) {
    const staff = displayStaff(event);
    const voice = event.voice ?? 1;
    const key = `${staff}:${voice}`;
    layers.set(key, [...(layers.get(key) ?? []), event]);
  }

  let previousCursor = 0;
  for (const layerEvents of layers.values()) {
    if (previousCursor > 0) result.push(orderedBackup(previousCursor));
    let cursor = 0;
    const beams = beamValues(layerEvents);

    for (const event of layerEvents) {
      const start = Math.max(0, Math.round(event.startBeat * measure.divisions));
      if (start > cursor) {
        result.push(orderedForward(start - cursor));
        cursor = start;
      }

      const staff = displayStaff(event);
      const stem = stemDirection(event, staff, multiVoiceStaffs);
      const pitches = event.pitches.length ? event.pitches : [undefined];
      pitches.forEach((pitch, index) => {
        result.push(orderedNote(event, measure, pitch, staff, index > 0, beams.get(event.id), stem, index));
      });
      cursor = Math.max(cursor, start + durationDivisions(event, measure));
    }

    previousCursor = Math.min(cursor, measureLengthDivisions(measure));
  }

  if (measure.xmlExtras?.length) {
    if (previousCursor > 0) result.push(orderedBackup(previousCursor));
    let cursor = 0;
    for (const extra of measure.xmlExtras) {
      const position = Math.round(extra.startBeat * measure.divisions);
      if (position > cursor) result.push(orderedForward(position - cursor));
      if (position < cursor) result.push(orderedBackup(cursor - position));
      result.push(extra.node);
      cursor = position;
    }
  }
  return result;
}

function stavesWithMultipleVoices(events: NoteEvent[]): Set<number> {
  const voicesByStaff = new Map<number, Set<number>>();
  for (const event of events) {
    if (!event.pitches.length) continue;
    const staff = displayStaff(event);
    const voices = voicesByStaff.get(staff) ?? new Set<number>();
    voices.add(event.voice ?? 1);
    voicesByStaff.set(staff, voices);
  }
  return new Set([...voicesByStaff.entries()].filter(([, voices]) => voices.size > 1).map(([staff]) => staff));
}

function stemDirection(event: NoteEvent, staff: number, multiVoiceStaffs: Set<number>): "up" | "down" | undefined {
  if (!multiVoiceStaffs.has(staff) || !event.pitches.length) return undefined;
  return (event.voice ?? 1) % 2 === 1 ? "up" : "down";
}

function beamValues(events: NoteEvent[]): Map<string, BeamValue> {
  const beams = new Map<string, BeamValue>();
  let group: NoteEvent[] = [];

  function flushGroup() {
    if (group.length < 2) {
      group = [];
      return;
    }

    group.forEach((event, index) => {
      if (index === 0) beams.set(event.id, "begin");
      else if (index === group.length - 1) beams.set(event.id, "end");
      else beams.set(event.id, "continue");
    });
    group = [];
  }

  for (const event of events) {
    if (event.beam) {
      flushGroup();
      if (event.beam !== "none") beams.set(event.id, event.beam);
      continue;
    }

    if (!isBeamable(event)) {
      flushGroup();
      continue;
    }

    const previous = group.at(-1);
    if (previous && !near(previous.startBeat + previous.durationBeats, event.startBeat)) {
      flushGroup();
    }
    group.push(event);
  }

  flushGroup();
  return beams;
}

function isBeamable(event: NoteEvent): boolean {
  return event.pitches.length > 0 && (near(event.durationBeats, 0.5) || near(event.durationBeats, 0.25));
}

function mergeChordEvents(events: NoteEvent[]): NoteEvent[] {
  const merged = new Map<string, NoteEvent>();

  for (const event of events) {
    const staff = displayStaff(event);
    const voice = event.voice ?? 1;
    const key = `${staff}:${voice}:${beatKey(event.startBeat)}:${beatKey(event.durationBeats)}`;
    const existing = merged.get(key);

    if (existing && existing.pitches.length > 0 && event.pitches.length > 0) {
      existing.pitches = [...existing.pitches, ...event.pitches];
      continue;
    }

    merged.set(key, { ...event, staff, voice, pitches: [...event.pitches] });
  }

  return [...merged.values()];
}

function beatKey(value: number): string {
  return Math.round(value * 1000).toString();
}

function preciseMeasure(measure: Measure): Measure {
  const values = [measure.durationBeats ?? measure.timeSignature.beats * 4 / measure.timeSignature.beatType,
    ...measure.events.flatMap((event) => [event.startBeat, event.durationBeats]),
    ...(measure.harmonies ?? []).map((event) => event.startBeat),
    ...(measure.tempos ?? []).map((event) => event.startBeat),
    ...(measure.dynamics ?? []).map((event) => event.startBeat),
    ...(measure.xmlExtras ?? []).map((event) => event.startBeat)];
  let divisions = measure.divisions;
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("Invalid rhythmic value.");
    let denominator = 1;
    while (denominator <= 10000 && Math.abs(value * denominator - Math.round(value * denominator)) > 1e-7) denominator++;
    if (denominator > 10000) throw new Error("Rhythmic value is too precise to export safely.");
    divisions = divisions / gcd(divisions, denominator) * denominator;
    if (!Number.isSafeInteger(divisions) || divisions > 10000000) throw new Error("MusicXML timing precision exceeds the supported limit.");
  }
  const scale = divisions / measure.divisions;
  const xmlExtras = measure.xmlExtras ? structuredClone(measure.xmlExtras) : undefined;
  const rescale = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [tag, value] of Object.entries(node)) {
      if ((tag === "offset" || tag === "duration") && Array.isArray(value)) {
        for (const child of value) if (child["#text"] !== undefined) child["#text"] = Number(child["#text"]) * scale;
      } else rescale(value);
    }
  };
  rescale(xmlExtras);
  return { ...measure, divisions, xmlExtras };
}

export function exportMusicXML(score: Score): string {
  const root = [
    orderedTextElement("?xml", "", { "@_version": "1.0", "@_encoding": "UTF-8" }),
    orderedElement(
      "score-partwise",
      [
        ...(score.xmlHeaders ?? []),
        ...(score.xmlHeaders?.some((item) => orderedText(orderedContent(item, "work"), "work-title") === score.title)
          ? [] : [orderedTextElement("movement-title", score.title ?? "Untitled score")]),
        orderedElement(
          "part-list",
          score.parts.map((part) =>
            orderedElement("score-part", [orderedTextElement("part-name", part.name ?? "Piano"), ...(part.xmlDefinition ?? []).filter((item) => !hasTag(item, "part-name"))], { "@_id": part.id })
          )
        ),
        ...score.parts.map((part) => {
          const staves = needsGrandStaff(part) ? 2 : 1;
          let previousMeasure: Measure | undefined;
          return orderedElement(
            "part",
            part.measures.map((sourceMeasure) => {
              const measure = preciseMeasure(sourceMeasure);
              const includeAttributes = !sameAttributes(previousMeasure, measure);
              previousMeasure = measure;
              return orderedElement(
                "measure",
                [
                  ...(includeAttributes ? [orderedAttributes(measure, staves)] : []),
                  ...orderedMeasureNotes(measure)
                ],
                { "@_number": String(measure.number), ...(measure.implicit ? { "@_implicit": "yes" } : {}) }
              );
            }),
            { "@_id": part.id }
          );
        })
      ],
      { "@_version": "3.1" }
    )
  ];

  return orderedBuilder.build(root);
}
