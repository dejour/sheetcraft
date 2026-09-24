import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { LandingScore } from "./LandingScore";
import { prefersReducedMotion } from "./useScrollReveal";
import "./landing.css";

const LANDING_OSMD_OPTIONS = {
  autoResize: true, backend: "svg" as const, drawTitle: false,
  drawComposer: false, drawCredits: false, disableCursor: true
};

export function Landing() {
  return <div className="landing" id="top">
    <header className="landing-nav"><Link className="landing-brand" to="/"><span aria-hidden="true">♮</span>SheetCraft</Link>
      <nav aria-label="Page sections"><a href="#how-it-works">How it works</a><a href="#examples">Examples</a><a href="#playback">Playback</a></nav>
      <Link className="landing-signin" to="/login">Sign in</Link>
    </header>
    <main>
      <section className="landing-hero" id="how-it-works">
        <div className="landing-hero-head"><div className="landing-hero-title"><span className="landing-eyebrow">A NEW WAY TO WORK WITH NOTATION</span><h1>Your music.<br/>A conversation away.</h1></div>
          <div className="landing-hero-copy"><p>Bring a score. Describe a change.<br/>Shape every phrase in plain language,<br/>then hear it come to life.</p><a href="#examples">Explore examples ↓</a></div>
        </div>
        <div className="landing-stage"><div className="landing-stage-meta"><span>IN THE EDITOR</span><span>Piano study · D major · 4/4</span><span>✓ Changes applied</span></div>
          <div className="landing-score-paper"><div className="landing-score-heading"><h3>A little change in direction</h3><span>Andante · ♩ = 96</span></div><LandingScore/></div>
          <div className="landing-prompt"><div><span aria-hidden="true">✳</span><span>Transpose to D major and simplify the left hand</span></div><span aria-hidden="true">↵</span></div>
        </div>
      </section>
      <CapabilitiesSection/>
      <PlaybackSection/>
      <section className="landing-closing"><div><h2>Start with a phrase.<br/>See where it takes you.</h2><p>Upload a score or begin with a blank page.</p></div><span>Your scores, saved to your account.</span></section>
    </main>
    <footer className="landing-footer"><Link to="/">SheetCraft</Link><span>Score editing in conversation.</span><a href="#top">Back to top ↑</a></footer>
  </div>;
}

function CapabilitiesSection() {
  const [active, setActive] = useState<CapabilityId>("transpose");
  const example = CAPABILITIES.find(item => item.id === active)!;
  return <section className="landing-examples" id="examples">
    <div className="landing-section-head"><div><span className="landing-eyebrow">SMALL EDITS. NEW POSSIBILITIES.</span><h2>Keep the idea. Change the phrase.</h2></div><p>From a different key to a simpler part.<br/>See exactly what your words change.</p></div>
    <div className="landing-tabs" role="tablist" aria-label="Edit examples">{CAPABILITIES.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={active === item.id} aria-controls="example-panel" tabIndex={active === item.id ? 0 : -1} onClick={() => setActive(item.id)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % CAPABILITIES.length : event.key === "ArrowLeft" ? (index + CAPABILITIES.length - 1) % CAPABILITIES.length : event.key === "Home" ? 0 : event.key === "End" ? CAPABILITIES.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); setActive(CAPABILITIES[next].id); document.getElementById(`tab-${CAPABILITIES[next].id}`)?.focus();
    }}>{item.label}</button>)}</div>
    <div className="landing-example-panel" id="example-panel" role="tabpanel" aria-labelledby={`tab-${active}`}>
      <p className="landing-command">“{example.command}.”</p>
      <div className="landing-comparison">{([false, true] as const).map(after => <div className={`landing-comparison-score${after ? " is-after" : ""}`} key={`${active}-${after}`}>
        <div className="landing-comparison-label"><span>{after ? "AFTER" : "BEFORE"}</span><span>{active === "transpose" ? after ? "D major · 2 sharps" : "C major" : after ? "Revised phrase" : "Original phrase"}</span></div>
        {active === "transpose" ? <LandingScore before={!after}/> : <div className="landing-live-score"><LandingOsmdScore source={after ? example.after : example.before} visible compact/></div>}
      </div>)}</div>
    </div>
  </section>;
}

function PlaybackSection() {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0.417);
  const [loop, setLoop] = useState(true);
  useEffect(() => {
    if (!playing || prefersReducedMotion()) return;
    const timer = window.setInterval(() => setProgress(value => {
      if (value + 0.0125 < 1) return value + 0.0125;
      if (!loop) setPlaying(false);
      return loop ? 0 : 1;
    }), 100);
    return () => window.clearInterval(timer);
  }, [playing, loop]);
  return <section className="landing-playback" id="playback"><div className="landing-playback-copy"><span className="landing-eyebrow">MAKE ROOM FOR LISTENING</span><h2>The next edit<br/>starts with a listen.</h2><p>Slow it down. Loop a measure.<br/>Hear how each revision feels before<br/>moving on to the next phrase.</p><button onClick={() => setPlaying(value => !value)}>Explore playback ↗</button></div>
    <div className="landing-playback-demo"><div className="landing-playback-heading"><span>Piano study</span><span>Measures 1–4 · Loop {loop ? "on" : "off"}</span></div><LandingScore cursor={playing ? 20 + progress * 960 : 520}/>
      <div className="landing-playback-controls"><button className="landing-play-toggle" aria-label={playing ? "Pause playback preview" : "Play playback preview"} onClick={() => { if (progress >= 1) setProgress(0); setPlaying(value => !value); }}>{playing ? "Ⅱ" : "▶"}</button><span>0:{String(Math.floor(progress * 8)).padStart(2, "0")}</span><div className="landing-playback-track"><span style={{width: `${progress * 100}%`}}/></div><span>96 BPM</span><button className="landing-loop" aria-label="Loop playback preview" aria-pressed={loop} onClick={() => setLoop(value => !value)}>↻</button></div>
    </div>
  </section>;
}

type CapabilityId = "transpose" | "simplify" | "rewrite" | "chord";

const CAPABILITIES: Array<{
  id: CapabilityId;
  label: string;
  command: string;
  before: string;
  after: string;
}> = [
  {
    id: "transpose",
    label: "Transpose",
    command: "Move the whole piece to D major",
    before: "/sample.musicxml",
    after: "/landing-transposed.musicxml"
  },
  {
    id: "simplify",
    label: "Simplify left hand",
    command: "Reduce the bass to root notes",
    before: "/landing-simplify-before.musicxml",
    after: "/landing-simplify-after.musicxml"
  },
  {
    id: "rewrite",
    label: "Rewrite phrase",
    command: "Make this phrase calmer, same contour",
    before: "/landing-rewrite-before.musicxml",
    after: "/landing-rewrite-after.musicxml"
  },
  {
    id: "chord",
    label: "Insert chord",
    command: "Turn the opening note into a triad",
    before: "/landing-chord-before.musicxml",
    after: "/landing-chord-after.musicxml"
  }
];


function LandingOsmdScore({
  source,
  visible,
  enabled = true,
  compact = false
}: {
  source: string;
  visible: boolean;
  enabled?: boolean;
  compact?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    let cancelled = false;
    const osmd = new OpenSheetMusicDisplay(
      container,
      compact
        ? {
            ...LANDING_OSMD_OPTIONS,
            drawPartNames: false,
            drawMeasureNumbers: false,
            renderSingleHorizontalStaffline: true
          }
        : LANDING_OSMD_OPTIONS
    );
    osmd.setLogLevel("error");
    osmdRef.current = osmd;

    void fetch(source)
      .then((response) => response.text())
      .then(async (musicxml) => {
        if (cancelled) return;
        await osmd.load(musicxml);
        if (cancelled) return;
        osmd.render();
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      osmdRef.current = null;
    };
  }, [source, enabled, compact]);

  return (
    <div
      ref={containerRef}
      className="landing-osmd-render"
      aria-hidden={!visible}
      data-visible={visible || undefined}
    />
  );
}
