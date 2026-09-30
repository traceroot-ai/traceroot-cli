import { describe, expect, it } from "vitest";
import type { Writers } from "../../src/output.js";
import { type SetupEvent, jsonEmitter, stageLineEmitter } from "../../src/setup/events.js";
import { StringSink } from "../helpers/stringSink.js";
import { plain } from "./colour.js";

function writers(): { writers: Writers; out: StringSink; err: StringSink } {
  const out = new StringSink();
  const err = new StringSink();
  return { writers: { out, err }, out, err };
}

const start = (stage: string): SetupEvent =>
  ({ event: "stage", stage, status: "start" }) as SetupEvent;
const settled = (stage: string, status = "ok"): SetupEvent =>
  ({ event: "stage", stage, status, durationMs: 10 }) as SetupEvent;

/** Non-empty lines, so the blank rail rows between steps do not clutter assertions. */
function lines(sink: StringSink): string[] {
  return plain(sink.data)
    .split("\n")
    .filter((line) => line.trim() !== "" && line.trim() !== "│");
}

describe("the human stage renderer", () => {
  it("leaves a section to the prompt that owns it", () => {
    // Every stage that asks a question already heads its own section with that
    // question. "Work out what to instrument" printed above a prompt asking
    // which language is the same sentence twice, and the run reads twice as
    // long as it is. What the user typed survives; the heading does not.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(start("detect_stack"));
    err.write("Language: python\n");
    emit(settled("detect_stack"));

    expect(lines(err)).toEqual(["Language: python"]);
  });

  it("says nothing for a step that was already done", () => {
    // "Choose the project — already done" is the heading this set exists to
    // remove, wearing a different hat.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(start("precheck"));
    emit(settled("precheck"));
    emit(start("select_context"));
    emit(settled("select_context", "skipped"));

    expect(err.data).toBe("");
  });

  it("stays quiet for a step that heads its own section", () => {
    // Signing in opens with a sentence naming which of its four routes is
    // happening and what the user has to do — "Sign in to TraceRoot" directly
    // above that is a second heading for one section.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(start("authenticate"));
    emit(settled("authenticate"));

    expect(err.data).toBe("");
  });

  it("still names a self-announcing step that never got to speak", () => {
    // Satisfied before it ran means no block was printed, so the label is once
    // again the only account of the step.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(settled("authenticate", "skipped"));

    expect(lines(err)).toEqual(["◇  Sign in to TraceRoot — already done"]);
  });

  it("marks the point a run broke, even in a step that stays quiet", () => {
    // Silence is for a step that worked. A stage that fails is the one thing
    // the user needs named, so the label comes back for that case alone.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(start("detect_stack"));
    emit(settled("detect_stack", "failed"));

    expect(lines(err)).toEqual(["▲  Work out what to instrument"]);
  });

  it("says nothing at all for a step that is not a section", () => {
    // Installing the skill, running the agent, running the checks, waiting for
    // the trace, finishing. All five happen; none of them is a thing to attend
    // to while it does, and a heading over each was five promises the run did
    // not keep.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    for (const stage of [
      "install_agent_context",
      "instrument",
      "verify_application",
      "verify_trace",
      "complete",
    ]) {
      emit(start(stage));
      emit(settled(stage));
    }

    expect(err.data).toBe("");
  });

  it("does not announce one of those as already done either", () => {
    // The same heading wearing a different hat. A `--resume` run that had
    // already instrumented used to reprint the whole tail of the wizard as five
    // "— already done" lines.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(settled("instrument", "skipped"));
    emit(settled("verify_trace", "skipped"));

    expect(err.data).toBe("");
  });

  it("still names one of those when it is where the run broke", () => {
    // Silence is for work going to plan. A run that stopped has to say where.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    emit(start("verify_trace"));
    emit(settled("verify_trace", "failed"));

    expect(lines(err)).toEqual(["▲  Wait for the first trace"]);
  });

  it("keeps every line on the rail or on a step marker", () => {
    // A line that carries neither falls visibly outside the wizard's frame.
    const { writers: w, err } = writers();
    const emit = stageLineEmitter(w);

    for (const stage of ["precheck", "authenticate", "complete"]) {
      emit(start(stage));
      emit(settled(stage));
    }
    emit(settled("select_agent", "skipped"));

    for (const line of plain(err.data)
      .split("\n")
      .filter((l) => l !== "")) {
      expect(line.startsWith("│") || line.startsWith("◇") || line.startsWith("▲")).toBe(true);
    }
  });

  it("writes nothing to stdout, which belongs to results", () => {
    const { writers: w, out } = writers();
    const emit = stageLineEmitter(w);
    emit(start("precheck"));
    emit(settled("precheck"));
    emit({ event: "result", ok: true, data: {} });

    expect(out.data).toBe("");
  });
});

describe("the machine contract", () => {
  it("emits one compact JSON line per event on stdout, and nothing on stderr", () => {
    const { writers: w, out, err } = writers();
    const emit = jsonEmitter(w);

    emit(start("precheck"));
    emit(settled("precheck"));
    emit({ event: "result", ok: true, data: { project_id: "p_1" } });

    const parsed = out.data.trim().split("\n").map(JSON.parse);
    expect(parsed).toEqual([
      { event: "stage", stage: "precheck", status: "start" },
      { event: "stage", stage: "precheck", status: "ok", durationMs: 10 },
      { event: "result", ok: true, data: { project_id: "p_1" } },
    ]);
    // No rail glyph, no chrome: a consumer parses these lines.
    expect(out.data).not.toContain("│");
    expect(err.data).toBe("");
  });
});
