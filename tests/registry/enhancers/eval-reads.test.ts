// The four dataset reads and the run read: what each one shows, and the two
// rules that hold across all of them — an absent value never renders as zero or
// as a blank, and a page that is not the whole result set says so.
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import {
  renderVersion,
  versionLabel,
} from "../../../src/registry/enhancers/dataset-versions-get.js";
import { renderVersionList } from "../../../src/registry/enhancers/dataset-versions-list.js";
import { renderDataset } from "../../../src/registry/enhancers/datasets-get.js";
import { renderDatasetList } from "../../../src/registry/enhancers/datasets-list.js";
import { limitBounds } from "../../../src/registry/enhancers/eval-reads.js";
import { renderRun, resultsLine } from "../../../src/registry/enhancers/eval-runs-get.js";
import { renderRunList } from "../../../src/registry/enhancers/eval-runs-list.js";
import { latestRun, renderEvaluationList } from "../../../src/registry/enhancers/evals-list.js";
import { createFakeFetch, jsonResponse } from "../../helpers/fakeFetch.js";
import { StringSink } from "../../helpers/stringSink.js";

function sinks() {
  const out = new StringSink();
  const err = new StringSink();
  return { w: { out, err }, out, err };
}

describe("limit bounds", () => {
  it("come from the registry, with no default where the tool declares none", () => {
    expect(limitBounds("list_datasets")).toEqual({ serverDefault: 50, max: 200 });
    // Without a limit this read returns the whole version: no page size describes that.
    expect(limitBounds("get_dataset_version")).toEqual({ serverDefault: undefined, max: 1000 });
  });

  it("throw for a tool with no limit instead of inventing numbers", () => {
    expect(() => limitBounds("list_datsets")).toThrow(/declares no limit ceiling/);
    expect(() => limitBounds("get_dataset")).toThrow(/declares no limit ceiling/);
  });
});

describe("datasets list", () => {
  it("renders a table and says how many", () => {
    const { w, out, err } = sinks();
    renderDatasetList(
      {
        datasets: [
          {
            dataset_id: "ds_2a97",
            name: "support-triage",
            key: "support-triage",
            current_dataset_version_id: "dsv_01JG8Z",
            updated_at: "2026-09-01T23:30:00Z",
          },
        ],
        next_cursor: null,
      },
      {},
      w,
      "Asia/Tokyo",
    );
    expect(out.data).toContain("DATASET ID");
    expect(out.data).toContain("support-triage");
    expect(out.data).toContain("dsv_01JG8Z");
    expect(err.data).toContain("1 dataset");
    // Last updated, in local time like every other timestamp the CLI prints.
    expect(out.data).toContain("UPDATED");
    expect(out.data).toContain("2026-09-02 08:30:00");
  });

  it("says (none) for a dataset with nothing published", () => {
    // Not an error and not a blank: the dataset exists, and no version has been published.
    const { w, out } = sinks();
    renderDatasetList({ datasets: [{ dataset_id: "ds_9f04", name: "tool-selection" }] }, {}, w);
    expect(out.data).toContain("(none)");
  });

  it("warns when the page is not the whole result set", () => {
    const { w, err } = sinks();
    renderDatasetList(
      { datasets: [{ dataset_id: "ds_1", name: "a" }], next_cursor: "more" },
      {},
      w,
    );
    expect(err.data).toContain("there are more");
    expect(err.data).toContain("--limit");
  });

  it("pluralises by the count, and gives no advice to raise a --limit already at its maximum", () => {
    const { w, err } = sinks();
    renderDatasetList(
      { datasets: [{ dataset_id: "ds_1", name: "a" }], next_cursor: "more" },
      { limit: 200 },
      w,
    );
    expect(err.data).toContain("showing 1 dataset (--limit 200)");
    expect(err.data).not.toContain("raise --limit");
    expect(err.data).toContain("200 is the most a page holds");
  });

  it("trusts a null next_cursor over an exactly full page", () => {
    // 50 is the server's default page size: a full page with no cursor is the
    // last page, not a truncated one.
    const { w, err } = sinks();
    const datasets = Array.from({ length: 50 }, (_, i) => ({
      dataset_id: `ds_${i}`,
      name: `d${i}`,
    }));
    renderDatasetList({ datasets, next_cursor: null }, {}, w);
    expect(err.data).toContain("50 datasets");
    expect(err.data).not.toContain("there are more");
  });

  it("falls back to page size only when the server sends no cursor field", () => {
    const { w, err } = sinks();
    const datasets = Array.from({ length: 50 }, (_, i) => ({
      dataset_id: `ds_${i}`,
      name: `d${i}`,
    }));
    renderDatasetList({ datasets }, {}, w);
    expect(err.data).toContain("there are more");
  });

  it("stays quiet when the server reports no next page", () => {
    const { w, err } = sinks();
    renderDatasetList({ datasets: [{ dataset_id: "ds_1", name: "a" }], next_cursor: null }, {}, w);
    expect(err.data).not.toContain("there are more");
  });
});

describe("datasets get", () => {
  it("points at the next step when there is no published version", () => {
    const { w, out, err } = sinks();
    renderDataset({ dataset_id: "ds_9f04", name: "tool-selection" }, w);
    expect(out.data).toContain("current version");
    expect(out.data).toContain("(none)");
    expect(err.data).toContain("nothing to read yet");
  });

  it("shows when the dataset was last updated, and a dash when the server does not say", () => {
    const { w, out } = sinks();
    renderDataset(
      { dataset_id: "ds_1", name: "a", updated_at: "2026-09-01T23:30:00Z" },
      w,
      "Asia/Tokyo",
    );
    expect(out.data).toMatch(/updated\s+2026-09-02 08:30:00/);
    const bare = sinks();
    renderDataset({ dataset_id: "ds_1", name: "a" }, bare.w);
    expect(bare.out.data).toMatch(/updated\s+—/);
  });

  it("says nothing extra once a version exists", () => {
    const { w, err } = sinks();
    renderDataset(
      { dataset_id: "ds_2a97", name: "support-triage", current_dataset_version_id: "dsv_1" },
      w,
    );
    expect(err.data).not.toContain("nothing to read yet");
  });
});

describe("datasets versions list", () => {
  it("marks the current version and never prints 0 for an unknown count", () => {
    const { w, out } = sinks();
    renderVersionList(
      {
        versions: [
          {
            dataset_version_id: "dsv_1",
            version_number: 3,
            label: "v3",
            case_count: 120,
            created_at: "2026-09-01T10:00:00Z",
            is_current: true,
          },
          {
            dataset_version_id: "dsv_2",
            version_number: 2,
            label: "v2",
            case_count: 118,
            created_at: "2026-08-01T10:00:00Z",
            is_current: false,
          },
          { dataset_version_id: "dsv_0", version_number: 2, label: null, case_count: null },
        ],
      },
      {},
      w,
    );
    expect(out.data).toContain("*");
    expect(out.data).toContain("120");
    // An absent count renders as an em dash — "not reported" is not "zero cases".
    // Checked cell by cell on that row, so a regression to 0 cannot hide behind
    // an em dash printed elsewhere. The last cell is CURRENT: this row says
    // nothing about it, which is not the same as saying it is not current.
    const row = out.data.split("\n").find((line) => line.startsWith("dsv_0"));
    expect(row?.trim().split(/\s+/)).toEqual(["dsv_0", "2", "—", "—", "—", "—"]);
    // A reported `false` keeps the blank cell: there, the server did say.
    const reported = out.data.split("\n").find((line) => line.startsWith("dsv_2"));
    expect(reported?.trim()).toMatch(/118/);
    expect(reported?.trim().endsWith("—")).toBe(false);
  });

  it("shows when a version was created in local time, not the UTC date", () => {
    // 23:30 UTC on 1 September is already 2 September in Tokyo.
    const { w, out } = sinks();
    renderVersionList(
      { versions: [{ dataset_version_id: "dsv_1", created_at: "2026-09-01T23:30:00Z" }] },
      {},
      w,
      "Asia/Tokyo",
    );
    expect(out.data).toContain("2026-09-02 08:30:00");
    expect(out.data).not.toContain("2026-09-01");
  });

  it("says so when a dataset has published nothing", () => {
    const { w, err } = sinks();
    renderVersionList({ versions: [] }, {}, w);
    expect(err.data).toContain("no versions published");
  });
});

describe("datasets versions get", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    test_case_id: `tc_${i}`,
    input: { ticket: "card declined" },
    expected: "billing",
  }));

  it("shows the version, then its cases, then how many", () => {
    const { w, out, err } = sinks();
    renderVersion(
      {
        dataset_id: "ds_2a97",
        dataset_version_id: "dsv_1",
        version_number: 3,
        label: "golden",
        items: many.slice(0, 2),
        next_cursor: null,
      },
      {},
      w,
    );
    expect(out.data).toContain("v3 (golden)");
    expect(out.data).toContain("CASE ID");
    expect(err.data).toContain("2 cases");
  });

  it("says out loud that a capped page has an unreachable tail", () => {
    const { w, err } = sinks();
    renderVersion(
      { dataset_version_id: "dsv_1", items: many, next_cursor: "more" },
      { limit: 25 },
      w,
    );
    expect(err.data).toContain("there are more");
    expect(err.data).toContain("--limit 25");
  });

  it("labels a version without repeating a label that is already the derived name", () => {
    expect(versionLabel(3, "v3")).toBe("v3");
    expect(versionLabel(3, "golden")).toBe("v3 (golden)");
    expect(versionLabel(3, null)).toBe("v3");
    expect(versionLabel(null, "golden")).toBe("golden");
    expect(versionLabel(null, null)).toBeNull();
  });
});

describe("evals runs get", () => {
  const base = {
    evaluation_name: "support-triage",
    run_number: 12,
    status: "completed",
    candidate_version: "git:9f2a1c",
    environment: "ci",
    dataset_id: "ds_2a97",
    dataset_version_id: "dsv_1",
    scored_count: 25,
    task_error_count: 1,
    not_scored_count: 0,
  };

  it("labels derived metrics as per-case means", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        scores: [{ name: "accuracy", value: 0.84 }],
        metrics: [
          { name: "duration", value: 1204.5, unit: "ms" },
          { name: "cost", value: 0.0123, unit: "$" },
        ],
      },
      w,
    );
    expect(out.data).toMatch(/duration\s+1,205\s+ms\s+—\s+\(mean per case\)/);
    // The run total and the per-case mean are different numbers; the label is
    // what stops the smaller one being read as the larger.
    expect(out.data).toMatch(/cost\s+0\.0123\s+\$\s+—\s+\(mean per case\)/);
  });

  it("prints an absent count as an em dash, never 0", () => {
    expect(resultsLine({ evaluation_name: "e", status: "running" })).toBe(
      "— reported · — scored · — task errors · — scorer errors · — errored · — not scored",
    );
  });

  it("counts the cases that errored, separately from the SDK's own error tallies", () => {
    // errored_count is derived from the stored results' statuses, while the task
    // and scorer tallies are what the SDK reported; a run can carry both, and the
    // errored cases must not vanish into "not scored".
    const line = resultsLine({
      evaluation_name: "e",
      status: "completed",
      result_count: 10,
      scored_count: 7,
      task_error_count: 0,
      scorer_error_count: 0,
      errored_count: 3,
      not_scored_count: 0,
    });
    expect(line).toContain("3 errored");
    expect(line).toContain("0 not scored");
  });

  it("shows passed and failed when results carry them, and leaves them out otherwise", () => {
    const counts = { result_count: 25, scored_count: 25, task_error_count: 0 };
    const legacy = resultsLine({
      evaluation_name: "e",
      status: "completed",
      ...counts,
      passed_count: 5,
      failed_count: 20,
    });
    expect(legacy).toContain("25 reported");
    expect(legacy).toContain("5 passed · 20 failed");
    const current = resultsLine({
      evaluation_name: "e",
      status: "completed",
      ...counts,
      passed_count: 0,
      failed_count: 0,
    });
    expect(current).not.toMatch(/passed|failed/);
  });

  it("never rounds a small mean to 0, and never prints -0", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        metrics: [
          { name: "cost", value: 0.00004, unit: "$" },
          { name: "drift", value: -0.00001 },
          { name: "idle", value: -0 },
        ],
      },
      w,
    );
    expect(out.data).toMatch(/cost\s+0\.00004\s/);
    expect(out.data).toMatch(/drift\s+-0\.00001\s/);
    expect(out.data).toMatch(/idle\s+0\s/);
    expect(out.data).not.toMatch(/\s-0\s/);
  });

  it("says nothing about coverage: the run read does not carry it", () => {
    const { w, out } = sinks();
    renderRun({ ...base, scores: [{ name: "accuracy", value: 0.9 }] }, w);
    expect(out.data).not.toMatch(/coverage|NOT FINAL/);
  });

  it("counts every way a case can fail to score", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        task_error_count: 2,
        scorer_error_count: 1,
        not_scored_count: 3,
        scores: [{ name: "accuracy", value: 0.9 }],
      },
      w,
    );
    expect(out.data).toContain("2 task errors");
    expect(out.data).toContain("1 scorer error");
    expect(out.data).toContain("3 not scored");
  });

  it("tells a categorical score apart from one nothing reported", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        scores: [
          { name: "accuracy", value: 0.9, observed_count: 25, value_type: "numeric" },
          { name: "verdict", value: null, observed_count: 25, value_type: "categorical" },
          { name: "judge", value: null, observed_count: 0, value_type: "numeric" },
          { name: "grounded", value: 0.8, observed_count: 25, value_type: "boolean" },
          { name: "legacy", value: null, observed_count: 3 },
          // Booleans stored beside plain numbers: observed, but no single mean.
          { name: "hybrid", value: null, observed_count: 5, value_type: "numeric" },
          // Declared categorical, but this run has not scored a case yet.
          { name: "unrun", value: null, observed_count: 0, value_type: "categorical" },
        ],
      },
      w,
    );
    expect(out.data).toMatch(/verdict\s+categorical/);
    expect(out.data).toMatch(/grounded\s+0\.8\s+—\s+25\s+\(share true\)/);
    // A server without value_type still never prints an observed score as absent.
    expect(out.data).toMatch(/legacy\s+non-numeric/);
    expect(out.data).toMatch(/hybrid\s+mixed\s+—\s+5/);
    expect(out.data).toMatch(/unrun\s+—\s+—\s+0/);
    expect(out.data).toMatch(/judge\s+—/);
    expect(out.data).toContain("CASES");
    expect(out.data).toMatch(/accuracy\s+0\.9\s+—\s+25/);
  });

  it("says nothing about comparing: evals runs get reads a run, it does not compare two", () => {
    const { w, out, err } = sinks();
    renderRun({ ...base, scores: [{ name: "accuracy", value: 1 }] }, w);
    expect(`${out.data}${err.data}`).not.toMatch(/baseline|compar/i);
  });
});

describe("evals list", () => {
  it("shows how many runs each evaluation has and how the latest one ended", () => {
    const { w, out, err } = sinks();
    renderEvaluationList(
      {
        evaluations: [
          {
            evaluation_id: "ev_1",
            name: "support-triage-quality",
            dataset_id: "ds_1",
            run_count: 12,
            latest_run: {
              evaluation_run_id: "run_9",
              run_number: 12,
              status: "completed",
              started_at: "2026-09-01T23:30:00Z",
            },
          },
        ],
        next_cursor: null,
      },
      {},
      w,
      "Asia/Tokyo",
    );
    expect(out.data).toContain("EVALUATION ID");
    expect(out.data).toMatch(
      /support-triage-quality\s+ds_1\s+12\s+#12 completed\s+2026-09-02 08:30:00/,
    );
    expect(err.data).toContain("1 evaluation");
  });

  it("says (none) for an evaluation that has never run", () => {
    expect(latestRun(null)).toBe("(none)");
    expect(latestRun({ run_number: 3, status: "failed" })).toBe("#3 failed");
    // A run the server reported without a number is not the same as no run at all.
    expect(latestRun({ status: "running" })).toBe("#— running");
    // Nor is a server that said nothing about the lineage: null is the read
    // stating there are no runs, undefined is the field never arriving.
    expect(latestRun(undefined)).toBe("—");
  });

  it("says so when the project has no evaluations", () => {
    const { w, err } = sinks();
    renderEvaluationList({ evaluations: [] }, {}, w);
    expect(err.data).toContain("no evaluations");
  });

  it("does not call an empty page an empty project when a cursor says there is more", () => {
    const { w, err } = sinks();
    renderEvaluationList({ evaluations: [], next_cursor: "ev_9" }, { limit: 2 }, w);
    expect(err.data).toContain("no evaluations on this page");
    // The same response already warns in --json; the table must not stay silent.
    expect(err.data).toContain("there are more");
  });

  it("warns when the page is not every evaluation", () => {
    const { w, err } = sinks();
    renderEvaluationList(
      { evaluations: [{ evaluation_id: "ev_1", name: "a" }], next_cursor: "more" },
      { limit: 1 },
      w,
    );
    expect(err.data).toContain("showing 1 evaluation (--limit 1) and there are more");
  });
});

describe("evals runs list", () => {
  it("lists runs newest first with the id each is read by", () => {
    const { w, out, err } = sinks();
    renderRunList(
      {
        runs: [
          {
            evaluation_run_id: "run_9",
            evaluation_name: "support-triage-quality",
            run_number: 12,
            status: "completed",
            candidate_version: "git:9f2a1c",
            started_at: "2026-09-01T23:30:00Z",
          },
          {
            evaluation_run_id: "run_8",
            evaluation_name: "support-triage-quality",
            status: "running",
          },
        ],
        next_cursor: null,
      },
      {},
      w,
      "Asia/Tokyo",
    );
    expect(out.data).toContain("RUN ID");
    expect(out.data).toMatch(
      /run_9\s+support-triage-quality\s+12\s+completed\s+git:9f2a1c\s+2026-09-02 08:30:00/,
    );
    // A run with no number or candidate yet reads as absent, never as 0 or blank.
    expect(out.data).toMatch(/run_8\s+support-triage-quality\s+—\s+running\s+—\s+—/);
    expect(err.data).toContain("2 runs");
  });

  it("carries no scores or costs: those are per-run aggregates", () => {
    const { w, out } = sinks();
    renderRunList({ runs: [{ evaluation_run_id: "run_9", status: "completed" }] }, {}, w);
    expect(out.data).not.toMatch(/COST|SCORE|CASES|mean per case/i);
  });

  it("says so when nothing has run", () => {
    const { w, err } = sinks();
    renderRunList({ runs: [] }, {}, w);
    expect(err.data).toContain("no evaluation runs");
  });
});

describe("wiring", () => {
  function harness(payload: unknown) {
    const fake = createFakeFetch(() => jsonResponse(payload));
    const out = new StringSink();
    const err = new StringSink();
    const program = buildProgram({
      registry: { fetchImpl: fake.fetchImpl, writers: { out, err } },
    });
    const run = (...argv: string[]) =>
      program.parseAsync(["--api-key", "k", "--host", "https://api.test", ...argv], {
        from: "user",
      });
    return { fake, out, err, run };
  }

  it("nests three deep: 'datasets versions get' maps its id onto the path parameter", async () => {
    const h = harness({ dataset_version_id: "dsv_1", items: [] });
    await h.run("datasets", "versions", "get", "dsv_1", "--limit", "10");
    expect(h.fake.calls[0].url).toBe(
      "https://api.test/api/v1/public/dataset-versions/dsv_1?limit=10",
    );
  });

  it("'datasets versions get' sends a bounded page even without --limit", async () => {
    // Without a limit the server returns the whole version; the CLI reads one page.
    const h = harness({ dataset_version_id: "dsv_1", items: [], next_cursor: null });
    await h.run("datasets", "versions", "get", "dsv_1");
    expect(h.fake.calls[0].url).toBe(
      "https://api.test/api/v1/public/dataset-versions/dsv_1?limit=200",
    );
  });

  it("'datasets versions get' help describes the page it reads, not a cursor it lacks", () => {
    const program = buildProgram({
      registry: {
        fetchImpl: createFakeFetch(() => jsonResponse({})).fetchImpl,
        writers: sinks().w,
      },
    });
    const get = program.commands
      .find((c) => c.name() === "datasets")
      ?.commands.find((c) => c.name() === "versions")
      ?.commands.find((c) => c.name() === "get");
    expect(get?.description()).toContain("--limit");
    expect(get?.description()).not.toMatch(/cursor/i);
  });

  it("no evaluation read takes --project-id: the project comes from the global --project", async () => {
    for (const argv of [
      ["datasets", "list"],
      ["datasets", "get", "ds_1"],
      ["datasets", "versions", "list", "ds_1"],
      ["datasets", "versions", "get", "dsv_1"],
      ["evals", "list"],
      ["evals", "runs", "list"],
      ["evals", "runs", "get", "r_1"],
    ]) {
      const h = harness({});
      await expect(h.run(...argv, "--project-id", "p")).rejects.toThrow(
        /unknown option '--project-id'/,
      );
      expect(h.fake.calls).toHaveLength(0);
    }
  });

  it("'evals list' filters by name and sends the limit", async () => {
    const h = harness({ evaluations: [], next_cursor: null });
    await h.run("evals", "list", "--name", "triage", "--limit", "5");
    expect(h.fake.calls[0].url).toBe(
      "https://api.test/api/v1/public/evaluations?limit=5&name=triage",
    );
  });

  it("'evals runs list' filters by evaluation and status", async () => {
    const h = harness({ runs: [], next_cursor: null });
    await h.run("evals", "runs", "list", "--evaluation-id", "ev_1", "--status", "completed");
    const url = new URL(h.fake.calls[0].url);
    expect(url.pathname).toBe("/api/v1/public/evaluation-runs");
    expect(url.searchParams.get("evaluation_id")).toBe("ev_1");
    expect(url.searchParams.get("status")).toBe("completed");
  });

  it("'evals runs list' rejects a status the contract does not define, before any request", async () => {
    const h = harness({ runs: [] });
    await expect(h.run("evals", "runs", "list", "--status", "finished")).rejects.toThrow(
      /--status must be one of: .*completed/,
    );
    expect(h.fake.calls).toHaveLength(0);
  });

  it("'evals runs get' sends the run id and nothing else", async () => {
    const h = harness({ evaluation_name: "e", status: "completed" });
    await h.run("evals", "runs", "get", "r_1");
    expect(h.fake.calls[0].url).toBe("https://api.test/api/v1/public/evaluation-runs/r_1");
  });

  it("'evals runs get' has no --baseline: comparison is not part of the read", async () => {
    const h = harness({ evaluation_name: "e", status: "completed" });
    await expect(h.run("evals", "runs", "get", "r_1", "--baseline", "r_0")).rejects.toThrow(
      /unknown option '--baseline'/,
    );
    expect(h.fake.calls).toHaveLength(0);
  });

  it("--json says on stderr when a page is not the whole version, and keeps stdout verbatim", async () => {
    const payload = {
      dataset_version_id: "dsv_1",
      items: Array.from({ length: 200 }, (_, i) => ({ test_case_id: `tc_${i}` })),
      next_cursor: "more",
    };
    const h = harness(payload);
    await h.run("datasets", "versions", "get", "dsv_1", "--json");
    expect(JSON.parse(h.out.data)).toEqual(payload);
    expect(h.err.data).toContain("there are more");
  });

  it("--json stays silent on stderr when the page is the whole result", async () => {
    const payload = { datasets: [{ dataset_id: "ds_1", name: "a" }], next_cursor: null };
    const h = harness(payload);
    await h.run("datasets", "list", "--json");
    expect(JSON.parse(h.out.data)).toEqual(payload);
    expect(h.err.data).toBe("");
  });

  it("--json emits the response verbatim, with nothing derived added", async () => {
    const payload = { dataset_id: "ds_1", name: "a", current_dataset_version_id: null };
    const h = harness(payload);
    await h.run("datasets", "get", "ds_1", "--json");
    expect(JSON.parse(h.out.data)).toEqual(payload);
  });

  it("rejects an over-max --limit before the request, not as a server error", async () => {
    const h = harness({ datasets: [] });
    await expect(h.run("datasets", "list", "--limit", "5000")).rejects.toThrow(/at most 200/);
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe("server text with control characters", () => {
  // A dataset name or a case captured from a trace can hold anything. ESC and OSC
  // sequences sent raw would clear the screen or retitle the terminal.
  const hostile = "\u001b[2J\u001b]0;pwned\u0007x";

  it("escapes them in every read instead of sending them to the terminal", () => {
    const { w, out } = sinks();
    renderDatasetList(
      { datasets: [{ dataset_id: "ds_1", name: hostile }], next_cursor: null },
      {},
      w,
    );
    renderDataset({ dataset_id: "ds_1", name: hostile, description: hostile }, w);
    renderVersionList({ versions: [{ dataset_version_id: "dsv_1", label: hostile }] }, {}, w);
    renderVersion(
      { dataset_version_id: "dsv_1", items: [{ test_case_id: "tc_1", input: hostile }] },
      {},
      w,
    );
    renderRun(
      {
        evaluation_name: hostile,
        status: "completed",
        scores: [{ name: hostile, value: 1 }],
        run_url: `https://app.test/run${hostile}`,
      },
      w,
    );
    expect(out.data).not.toContain("\u001b");
    expect(out.data).not.toContain("\u0007");
    expect(out.data).toContain("\\u001b[2J");
  });
});
