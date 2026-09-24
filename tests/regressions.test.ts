import test from "node:test";
import "./midi.test";
import "./generationStream.test";
import assert from "node:assert/strict";
import { applyOperations, exportMusicXML, parseMusicXML, validateScore } from "../src/shared";
import { ScoreSaveQueue, type SavedScore } from "../src/frontend/scoreSaveQueue";
import { readProjectStream } from "../src/frontend/projectStream";
import { updateProjectStorage } from "../src/worker/index";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const fixture = `<score-partwise version="3.1"><work><work-title>Study</work-title></work><identification><creator type="composer">Composer</creator></identification><part-list><score-part id="P1"><part-name>Cello</part-name><score-instrument id="I1"><instrument-name>Cello</instrument-name></score-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>${["C", "D", "E"].map((step) => `<note><pitch><step>${step}</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type><notations><articulations><staccato/></articulations></notations><lyric><text>${step}</text></lyric></note>`).join("")}<direction><direction-type><words>Fine</words></direction-type><offset>-1</offset></direction><barline location="right"><repeat direction="backward"/></barline></measure></part></score-partwise>`;
const events = (score: ReturnType<typeof parseMusicXML>) => score.parts[0].measures[0].events;
const reload = (score: ReturnType<typeof parseMusicXML>) => parseMusicXML(exportMusicXML(score));

test("deletion followed by another edit targets the same note after saving", () => {
  const score = parseMusicXML(fixture);
  const afterDelete = applyOperations(score, [{ type: "delete_note", noteId: events(score)[0].id }]);
  const target = events(afterDelete)[0].id;
  const edited = applyOperations(reload(afterDelete), [{ type: "update_note", noteId: target, params: { pitch: { step: "G", octave: 3 } } }]);
  assert.deepEqual(events(reload(edited)).map((event) => event.pitches[0].step), ["G", "E"]);
});

test("inserted notes keep their identities through repeated saves", () => {
  const score = applyOperations(parseMusicXML(fixture), [{ type: "insert_note", measureNumber: 1, params: { startBeat: 3, durationBeats: 1, pitch: { step: "F", octave: 3 }, staff: 1 } }]);
  assert.deepEqual(events(reload(reload(score))).map((event) => event.id), events(score).map((event) => event.id));
});

test("fractional durations and starts survive low-division XML round trips", () => {
  for (const duration of [0.5, 0.25, 0.125, 1 / 3, 0.375]) {
    const score = parseMusicXML(fixture);
    const next = applyOperations(score, [{ type: "update_note", noteId: events(score)[0].id, params: { startBeat: duration, durationBeats: duration } }]);
    assert.equal(validateScore(next).valid, true);
    const stored = reload(next);
    assert.ok(Math.abs(events(stored)[0].durationBeats - duration) < 1e-9);
    assert.ok(Math.abs(events(stored)[0].startBeat - duration) < 1e-9);
  }
});

test("triplet durations export an appropriate note type and time modification", () => {
  const score = parseMusicXML(fixture);
  const next = applyOperations(score, [{ type: "update_note", noteId: events(score)[0].id, params: { durationBeats: 1 / 3 } }]);
  const xml = exportMusicXML(next);
  assert.ok(xml.includes("<type>eighth</type>"));
  assert.ok(xml.includes("<actual-notes>3</actual-notes>"));
  assert.ok(xml.includes("<normal-notes>2</normal-notes>"));
});

test("local edits retain clefs, repeats, text, lyrics and articulations", () => {
  const score = parseMusicXML(fixture);
  const next = applyOperations(score, [{ type: "update_note", noteId: events(score)[0].id, params: { durationBeats: 0.5 } }]);
  const xml = exportMusicXML(reload(next));
  for (const fragment of ["<sign>F</sign>", '<repeat direction="backward"', "<creator", "<instrument-name>Cello</instrument-name>", "<words>Fine</words>", "<lyric>", "<staccato"]) assert.ok(xml.includes(fragment), fragment);
  assert.ok(!xml.includes("<sign>G</sign>"));
  assert.ok(!xml.includes("<staves>2</staves>"));
  assert.ok(xml.includes("<offset>-2</offset>"));
});

test("mixed tempo and textual directions retain both components", () => {
  const xml = fixture.replace("<direction-type><words>Fine</words></direction-type>", "<direction-type><words>Fine</words><metronome><beat-unit>quarter</beat-unit><per-minute>80</per-minute></metronome></direction-type>");
  const stored = exportMusicXML(reload(parseMusicXML(xml)));
  assert.ok(stored.includes("<words>Fine</words>"));
  assert.ok(stored.includes("<per-minute>80</per-minute>"));
});

test("transpose updates chord roots, slash bass and text", () => {
  const score = parseMusicXML(fixture);
  score.parts[0].measures[0].harmonies = [{ startBeat: 0, root: "C", kind: "major-seventh", text: "Cmaj7/E", bass: { step: "E" } }];
  const next = applyOperations(score, [{ type: "transpose", params: { targetKey: "D" } }]);
  const harmony = next.parts[0].measures[0].harmonies![0];
  assert.equal(harmony.root, "D");
  assert.deepEqual(harmony.bass, { step: "F", alter: 1 });
  assert.equal(harmony.text, "Dmaj7/F#");
  assert.equal(reload(next).parts[0].measures[0].harmonies![0].root, "D");
});

const saved = (revision: string, musicxml = fixture): SavedScore => ({ project: { id: "project", r2_key: revision }, musicxml, score: parseMusicXML(fixture) });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};

test("rapid saves are serialized and use the last confirmed revision", async () => {
  const first = deferred();
  const requests: Array<{ musicxml: string; expectedR2Key: string }> = [];
  const queue = new ScoreSaveQueue(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return first.promise;
    return Response.json(saved("v3", "second"));
  });
  const a = queue.save(saved("v1"), "first");
  const b = queue.save(saved("v1"), "second");
  await Promise.resolve();
  assert.equal(requests.length, 1);
  first.resolve(Response.json(saved("v2", "first")));
  await Promise.all([a, b]);
  assert.deepEqual(requests, [{ musicxml: "first", expectedR2Key: "v1" }, { musicxml: "second", expectedR2Key: "v2" }]);
});

test("a failed save cancels dependent queued snapshots", async () => {
  let calls = 0;
  const queue = new ScoreSaveQueue(async () => { calls++; return new Response("Conflict", { status: 409 }); });
  const results = await Promise.allSettled([queue.save(saved("v1"), "first"), queue.save(saved("v1"), "second")]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.equal(queue.confirmed("project")?.project.r2_key, "v1");
  await assert.rejects(queue.flush("project"), /previous edit/);
});

test("stream EOF without a final acknowledgement is a failure", async () => {
  await assert.rejects(readProjectStream(new Response('{"done":false}\n'), () => {}), /interrupted/);
});

test("stream server errors and transport errors are failures", async () => {
  await assert.rejects(readProjectStream(new Response('{"error":"Save conflict"}\n'), () => {}), /Save conflict/);
  const stream = new ReadableStream({ start(controller) { controller.error(new Error("Disconnected")); } });
  await assert.rejects(readProjectStream(new Response(stream), () => {}), /Disconnected/);
});

test("stream parser handles split UTF-8 and a final line without newline", async () => {
  const data = new TextEncoder().encode('{"done":false,"text":"乐谱"}\n{"done":true}');
  let index = 0;
  const stream = new ReadableStream({ pull(controller) { if (index === data.length) controller.close(); else controller.enqueue(data.slice(index, ++index)); } });
  const chunks: unknown[] = [];
  await readProjectStream(new Response(stream), (chunk) => chunks.push(chunk));
  assert.deepEqual(chunks, [{ done: false, text: "乐谱" }, { done: true }]);
});

test("database compare-and-swap rejects a second writer with the old revision", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("create table projects (id text, r2_key text, musicxml_text text, updated_at text); insert into projects (id, r2_key) values ('project', 'v1');");
  const db = {
    prepare(sql: string) {
      return { bind(...params: string[]) { return { async run() {
        const result = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes) } };
      } }; } };
    }
  } as unknown as D1Database;
  try {
    const results = await Promise.allSettled([
      updateProjectStorage({ DB: db }, "project", "v2", "first score", "v1"),
      updateProjectStorage({ DB: db }, "project", "v3", "second score", "v1")
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 409);
    assert.equal(sqlite.prepare("select musicxml_text from projects").get()?.musicxml_text, "first score");
  } finally { sqlite.close(); }
});

test("bundled example scores retain notes and timings after two saves", () => {
  const musicalEvents = (score: ReturnType<typeof parseMusicXML>) => score.parts.flatMap((part) => part.measures.flatMap((measure) => measure.events.map((event) => ({
    id: event.id, measure: measure.number, start: event.startBeat, duration: event.durationBeats, pitches: event.pitches
  }))));
  for (const file of readdirSync("public").filter((file) => file.endsWith(".musicxml"))) {
    const score = parseMusicXML(readFileSync(`public/${file}`, "utf8"));
    assert.deepEqual(musicalEvents(reload(reload(score))), musicalEvents(score), file);
  }
});
