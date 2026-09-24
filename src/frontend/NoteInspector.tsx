import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { transposePitch } from "../shared";
import type { BeamMark, PhraseMark, Pitch, ScoreOperation } from "../shared";
import { DURATION_OPTIONS, formatChordLabel, formatPitchLabel, pitchesEqual, replacePitchWithoutDuplicates, startBeatOptions } from "./scoreEditingUtils";
import { durationLabel, type SelectedNoteState } from "./useScoreEditing";

type NoteInspectorProps = {
  selectedNote: SelectedNoteState;
  docked?: boolean;
  anchorRect?: InspectorAnchorRect | null;
  onApply: (operation: ScoreOperation, options?: { clearSelection?: boolean; resyncPitch?: Pitch }) => void;
  onFocusPitch: (pitch: Pitch) => void;
  chordToneMode?: boolean;
  onBeginChordToneAdd: () => void;
  onCancelChordToneAdd: () => void;
  keyFifths?: number;
};

type SelectOption = {
  label: string;
  value: string;
};

export type InspectorAnchorRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function InspectorSelect({
  id,
  label,
  value,
  options,
  onValueChange,
  triggerClassName
}: {
  id: string;
  label: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  triggerClassName?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className={triggerClassName}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const TIE_OPTIONS: SelectOption[] = [
  { value: "none", label: "None" },
  { value: "start", label: "Start" },
  { value: "continue", label: "Continue" },
  { value: "stop", label: "Stop" }
];

const SLUR_OPTIONS = TIE_OPTIONS;

const BEAM_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto" },
  { value: "none", label: "None" },
  { value: "begin", label: "Begin" },
  { value: "continue", label: "Continue" },
  { value: "end", label: "End" }
];

const VOICE_OPTIONS: SelectOption[] = [
  { value: "1", label: "Voice 1" },
  { value: "2", label: "Voice 2" },
  { value: "3", label: "Voice 3" },
  { value: "4", label: "Voice 4" }
];

let persistedInspectorPosition: { left: number; top: number } | null = null;

const INSPECTOR_MARGIN = 16;
const INSPECTOR_ANCHOR_GAP = 18;

function clampInspectorPosition(left: number, top: number, card: HTMLElement, parent: HTMLElement) {
  const minLeft = parent.scrollLeft + INSPECTOR_MARGIN;
  const minTop = parent.scrollTop + INSPECTOR_MARGIN;
  const maxLeft = parent.scrollLeft + parent.clientWidth - card.offsetWidth - INSPECTOR_MARGIN;
  const maxTop = parent.scrollTop + parent.clientHeight - card.offsetHeight - INSPECTOR_MARGIN;
  return {
    left: Math.max(minLeft, Math.min(left, maxLeft)),
    top: Math.max(minTop, Math.min(top, maxTop))
  };
}

function inspectorAnchorCenter(anchor: InspectorAnchorRect) {
  return { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 };
}

function positionIntersectsAnchor(
  position: { left: number; top: number },
  card: HTMLElement,
  anchor: InspectorAnchorRect,
  gap = INSPECTOR_ANCHOR_GAP
) {
  return (
    position.left < anchor.left + anchor.width + gap &&
    position.left + card.offsetWidth > anchor.left - gap &&
    position.top < anchor.top + anchor.height + gap &&
    position.top + card.offsetHeight > anchor.top - gap
  );
}

function smartInspectorPosition(anchor: InspectorAnchorRect, card: HTMLElement, parent: HTMLElement) {
  const center = inspectorAnchorCenter(anchor);
  const rawCandidates = [
    { left: anchor.left + anchor.width + INSPECTOR_ANCHOR_GAP, top: center.y - card.offsetHeight / 2 },
    { left: anchor.left - card.offsetWidth - INSPECTOR_ANCHOR_GAP, top: center.y - card.offsetHeight / 2 },
    { left: center.x - card.offsetWidth / 2, top: anchor.top + anchor.height + INSPECTOR_ANCHOR_GAP },
    { left: center.x - card.offsetWidth / 2, top: anchor.top - card.offsetHeight - INSPECTOR_ANCHOR_GAP }
  ];
  const candidates = rawCandidates.map((candidate) => clampInspectorPosition(candidate.left, candidate.top, card, parent));
  const nonOverlapping = candidates.find((candidate) => !positionIntersectsAnchor(candidate, card, anchor));
  return nonOverlapping ?? candidates[0];
}

export function NoteInspector({
  selectedNote,
  docked = false,
  anchorRect,
  onApply,
  onFocusPitch,
  chordToneMode = false,
  onBeginChordToneAdd,
  onCancelChordToneAdd,
  keyFifths = 0
}: NoteInspectorProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(
    null
  );
  const [position, setPosition] = useState<{ left: number; top: number } | null>(() => persistedInspectorPosition);
  const [dragging, setDragging] = useState(false);
  const [positioned, setPositioned] = useState(() => persistedInspectorPosition !== null);
  const autoPositionedAnchorRef = useRef<string | null>(null);

  const clampPosition = useCallback((left: number, top: number) => {
    const card = cardRef.current;
    const parent = card?.offsetParent as HTMLElement | null;
    if (!card || !parent) return { left, top };
    return clampInspectorPosition(left, top, card, parent);
  }, []);

  useLayoutEffect(() => {
    if (position !== null) return;
    const card = cardRef.current;
    const parent = card?.offsetParent as HTMLElement | null;
    if (!card || !parent) return;

    const next = clampInspectorPosition(
      parent.clientWidth - card.offsetWidth - INSPECTOR_MARGIN,
      parent.clientHeight - card.offsetHeight - INSPECTOR_MARGIN,
      card,
      parent
    );
    setPosition(next);
    persistedInspectorPosition = next;
    setPositioned(true);
  }, [position]);

  useLayoutEffect(() => {
    if (!anchorRect) return;
    const anchorKey = `${selectedNote.noteId}:${Math.round(anchorRect.left)}:${Math.round(anchorRect.top)}:${Math.round(anchorRect.width)}:${Math.round(anchorRect.height)}`;
    if (autoPositionedAnchorRef.current === anchorKey) return;
    const card = cardRef.current;
    const parent = card?.offsetParent as HTMLElement | null;
    if (!card || !parent) return;

    const next = smartInspectorPosition(anchorRect, card, parent);
    autoPositionedAnchorRef.current = anchorKey;
    setPosition(next);
    persistedInspectorPosition = next;
    setPositioned(true);
  }, [anchorRect, selectedNote.noteId]);

  useLayoutEffect(() => {
    if (position === null) return;
    persistedInspectorPosition = position;
  }, [position]);

  useLayoutEffect(() => {
    if (position === null) return;

    const onResize = () => {
      setPosition((current) => (current ? clampPosition(current.left, current.top) : current));
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [position, clampPosition]);

  function handleDragPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (position === null) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: position.left,
      startTop: position.top
    };
    setDragging(true);
  }

  function handleDragPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const next = clampPosition(
      dragState.startLeft + event.clientX - dragState.startX,
      dragState.startTop + event.clientY - dragState.startY
    );
    setPosition(next);
  }

  function handleDragPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragStateRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const { pitches, pitch: focusedPitch } = selectedNote;
  const isChord = pitches.length > 1;
  const isRest = pitches.length === 0;
  const startBeatChoices = startBeatOptions(selectedNote.measureCapacityBeats, selectedNote.durationBeats, selectedNote.startBeat);
  const startBeatValue = String(
    startBeatChoices.find((option) => Math.abs(option.value - selectedNote.startBeat) < 0.001)?.value ?? selectedNote.startBeat
  );
  const durationValue = String(
    DURATION_OPTIONS.find((option) => Math.abs(option.value - selectedNote.durationBeats) < 0.001)?.value ?? selectedNote.durationBeats
  );

  function nudgePitch(semitones: number) {
    if (!focusedPitch || pitches.length === 0) return;
    const nextPitch = transposePitch(focusedPitch, semitones, keyFifths);
    onApply({
      type: "update_note",
      noteId: selectedNote.noteId,
      params: {
        pitches: replacePitchWithoutDuplicates(pitches, focusedPitch, nextPitch)
      }
    }, { resyncPitch: nextPitch });
  }

  function updateSlur(value: string) {
    onApply({
      type: "update_note",
      noteId: selectedNote.noteId,
      params: { slur: value === "none" ? null : (value as PhraseMark) }
    });
  }

  function updateTie(value: string) {
    onApply({
      type: "update_note",
      noteId: selectedNote.noteId,
      params: { tie: value === "none" ? null : (value as PhraseMark) }
    });
  }

  function updateBeam(value: string) {
    onApply({
      type: "update_note",
      noteId: selectedNote.noteId,
      params: { beam: value === "auto" ? null : (value as BeamMark) }
    });
  }

  function updateVoice(value: string) {
    const voice = Number(value);
    if (voice === selectedNote.voice) return;

    if (isChord && focusedPitch) {
      onApply({
        type: "update_note",
        noteId: selectedNote.noteId,
        params: { splitPitch: focusedPitch, voice }
      });
      return;
    }

    onApply({
      type: "update_note",
      noteId: selectedNote.noteId,
      params: { voice }
    });
  }

  function deleteSelection() {
    if (isChord && focusedPitch) {
      onApply({
        type: "update_note",
        noteId: selectedNote.noteId,
        params: {
          pitches: pitches.filter((candidate) => !pitchesEqual(candidate, focusedPitch))
        }
      });
      return;
    }

    onApply({ type: "delete_note", noteId: selectedNote.noteId }, { clearSelection: true });
  }

  if (docked) {
    const changePitch = (change: Partial<Pitch>) => {
      if (!focusedPitch) return;
      const nextPitch = { ...focusedPitch, ...change };
      onApply({ type: "update_note", noteId: selectedNote.noteId,
        params: { pitches: replacePitchWithoutDuplicates(pitches, focusedPitch, nextPitch) }
      }, { resyncPitch: nextPitch });
    };
    return <section className="docked-inspector" aria-label="Selected note inspector">
      <header className="docked-note-heading"><div><h2>{isRest ? "Rest" : focusedPitch ? formatPitchLabel(focusedPitch) : "Chord"}</h2><span>{isRest ? "Rest" : "Note"} selected</span></div><p>Staff {selectedNote.staff} · Measure {selectedNote.measureNumber} · Beat {selectedNote.startBeat + 1}</p></header>
      {isChord && <div className="docked-chord-tones">{pitches.map(pitch => <Button key={formatPitchLabel(pitch)} variant="ghost" aria-pressed={focusedPitch ? pitchesEqual(pitch, focusedPitch) : false} onClick={() => onFocusPitch(pitch)}>{formatPitchLabel(pitch)}</Button>)}</div>}
      <div className="docked-note-fields">
        {!isRest && <>
          <InspectorSelect id="note-pitch" label="Pitch" value={focusedPitch?.step || "C"} options={["C", "D", "E", "F", "G", "A", "B"].map(step => ({label: step, value: step}))} onValueChange={step => changePitch({step: step as Pitch["step"]})} />
          <InspectorSelect id="note-octave" label="Octave" value={String(focusedPitch?.octave ?? 4)} options={Array.from({length: 9}, (_, octave) => ({label: String(octave), value: String(octave)}))} onValueChange={octave => changePitch({octave: Number(octave)})} />
          <InspectorSelect id="note-accidental" label="Accidental" value={String(focusedPitch?.alter ?? 0)} options={[{label:"Double flat",value:"-2"},{label:"Flat",value:"-1"},{label:"Natural",value:"0"},{label:"Sharp",value:"1"},{label:"Double sharp",value:"2"}]} onValueChange={alter => changePitch({alter:Number(alter)})} />
        </>}
        <InspectorSelect id="note-duration" label="Duration" value={durationValue} options={DURATION_OPTIONS.map(option => ({value: String(option.value), label: option.label}))} onValueChange={value => onApply({type:"update_note",noteId:selectedNote.noteId,params:{durationBeats:Number(value),reflowFollowing:true}})} />
        <InspectorSelect id="note-start-beat" label="Start beat" value={startBeatValue} options={startBeatChoices.map(option => ({value:String(option.value),label:option.label}))} onValueChange={value => onApply({type:"update_note",noteId:selectedNote.noteId,params:{startBeat:Number(value)}})} />
        <InspectorSelect id="note-voice" label="Voice" value={String(selectedNote.voice)} options={VOICE_OPTIONS} onValueChange={updateVoice} />
      </div>
      {!isRest && <div className="docked-chord-action"><Button variant="ghost" aria-pressed={chordToneMode} onClick={chordToneMode ? onCancelChordToneAdd : onBeginChordToneAdd}>{chordToneMode ? "Cancel chord tone" : "＋ Add chord tone"}</Button><p>{chordToneMode ? "Click the score to place the new chord tone." : "Build a chord on this note without changing its rhythm."}</p></div>}
      <details className="docked-notation"><summary>Notation &amp; voice</summary><p>Ties, slurs, beams and voice assignment</p><div className="docked-note-fields">
        <InspectorSelect id="note-tie" label="Tie" value={selectedNote.tie ?? "none"} options={TIE_OPTIONS} onValueChange={updateTie} />
        <InspectorSelect id="note-slur" label="Slur" value={selectedNote.slur ?? "none"} options={SLUR_OPTIONS} onValueChange={updateSlur} />
        <InspectorSelect id="note-beam" label="Beam" value={selectedNote.beam ?? "auto"} options={BEAM_OPTIONS} onValueChange={updateBeam} />
      </div></details>
      <footer className="docked-note-footer"><p>Changes save automatically.</p><Button variant="ghost" onClick={deleteSelection}>{isChord && focusedPitch ? "Remove tone" : "Delete note"}</Button></footer>
    </section>;
  }

  return (
    <Card
      ref={cardRef}
      className={cn(
        "absolute z-[4] w-[min(300px,calc(100%-32px))] gap-0 p-3.5",
        !positioned && "pointer-events-none opacity-0",
        dragging && "select-none"
      )}
      style={position ? { left: position.left, top: position.top } : { right: INSPECTOR_MARGIN, bottom: INSPECTOR_MARGIN }}
      aria-label="Selected note inspector"
    >
      <CardHeader className="gap-0">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={cn("note-inspector-drag-handle shrink-0", dragging && "note-inspector-drag-handle-active")}
              aria-label="Drag inspector panel"
              onPointerDown={handleDragPointerDown}
              onPointerMove={handleDragPointerMove}
              onPointerUp={handleDragPointerUp}
              onPointerCancel={handleDragPointerUp}
            >
              <GripHorizontal aria-hidden="true" />
            </button>
            <div className="flex min-h-7 min-w-0 flex-1 items-center justify-between gap-2">
              <span className="text-[11px] tracking-[0.04em] text-[var(--muted)] uppercase">
                {isRest ? "Rest" : isChord ? "Chord" : "Note"}
              </span>
              {isRest ? (
                <CardTitle>Rest</CardTitle>
              ) : isChord ? (
                <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1.5">
                  {pitches.map((candidate) => {
                    const active = focusedPitch ? pitchesEqual(candidate, focusedPitch) : false;
                    return (
                      <Button
                        key={formatPitchLabel(candidate)}
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-7 px-2 text-sm font-semibold",
                          active
                            ? "border-[var(--teal)] bg-[var(--teal-soft)] text-[var(--teal-dark)]"
                            : "text-[var(--ink)]"
                        )}
                        aria-pressed={active}
                        onClick={() => onFocusPitch(candidate)}
                      >
                        {formatPitchLabel(candidate)}
                      </Button>
                    );
                  })}
                </div>
              ) : (
                <CardTitle>{formatPitchLabel(pitches[0])}</CardTitle>
              )}
            </div>
          </div>
          <CardDescription
            className="pl-8"
            title={isChord ? formatChordLabel(pitches) : undefined}
          >
            <span>{durationLabel(selectedNote.durationBeats)}</span>
            <span className="note-inspector-dot" aria-hidden="true" />
            <span>Measure {selectedNote.measureNumber}</span>
            <span className="note-inspector-dot" aria-hidden="true" />
            <span>Staff {selectedNote.staff}</span>
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="pt-3">
        {!isRest && (
          <div className="grid gap-1.5">
            <Label>{isChord ? `Pitch · ${focusedPitch ? formatPitchLabel(focusedPitch) : ""}` : "Pitch"}</Label>
            <div className="flex gap-1.5 [&_button]:min-w-0 [&_button]:flex-1">
              <Button type="button" variant="ghost" size="sm" aria-label="Lower pitch" onClick={() => nudgePitch(-1)}>
                <ChevronDown />
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label="Raise pitch" onClick={() => nudgePitch(1)}>
                <ChevronUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(chordToneMode && "border-[var(--teal)] bg-[var(--teal-soft)] text-[var(--teal-dark)]")}
                aria-label="Add chord tone"
                aria-pressed={chordToneMode}
                title="Add chord tone"
                onClick={chordToneMode ? onCancelChordToneAdd : onBeginChordToneAdd}
              >
                <Plus />
              </Button>
            </div>
          </div>
        )}

        <InspectorSelect
          id="note-start-beat"
          label="Start beat"
          value={startBeatValue}
          options={startBeatChoices.map((option) => ({ value: String(option.value), label: option.label }))}
          onValueChange={(value) =>
            onApply({
              type: "update_note",
              noteId: selectedNote.noteId,
              params: { startBeat: Number(value) }
            })
          }
        />

        <InspectorSelect
          id="note-duration"
          label="Duration"
          value={durationValue}
          options={DURATION_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
          onValueChange={(value) =>
            onApply({
              type: "update_note",
              noteId: selectedNote.noteId,
              params: { durationBeats: Number(value), reflowFollowing: true }
            })
          }
        />

        <InspectorSelect
          id="note-voice"
          label={isChord && focusedPitch ? `Voice · ${formatPitchLabel(focusedPitch)}` : "Voice"}
          value={String(selectedNote.voice)}
          options={VOICE_OPTIONS}
          onValueChange={updateVoice}
        />

        <div className="grid grid-cols-2 gap-2">
          <InspectorSelect
            id="note-tie"
            label="Tie"
            value={selectedNote.tie ?? "none"}
            options={TIE_OPTIONS}
            onValueChange={updateTie}
            triggerClassName="text-xs"
          />
          <InspectorSelect
            id="note-slur"
            label="Slur"
            value={selectedNote.slur ?? "none"}
            options={SLUR_OPTIONS}
            onValueChange={updateSlur}
            triggerClassName="text-xs"
          />
          <div className="col-span-2 mt-1.5">
            <InspectorSelect
              id="note-beam"
              label="Beam"
              value={selectedNote.beam ?? "auto"}
              options={BEAM_OPTIONS}
              onValueChange={updateBeam}
            />
          </div>
        </div>
      </CardContent>

      <CardFooter className="pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-[var(--red-dark)] hover:border-[var(--red-border)] hover:bg-[var(--red-soft)]"
          aria-label={isChord && focusedPitch ? `Remove ${formatPitchLabel(focusedPitch)} from chord` : "Delete note"}
          onClick={deleteSelection}
        >
          <Trash2 />
          {isChord && focusedPitch ? "Remove tone" : "Delete"}
        </Button>
      </CardFooter>
    </Card>
  );
}
