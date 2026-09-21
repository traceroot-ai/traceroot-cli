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
import { coverageLine, renderRun } from "../../../src/registry/enhancers/eval-runs-get.js";
import { createFakeFetch, jsonResponse } from "../../helpers/fakeFetch.js";
import { StringSink } from "../../helpers/stringSink.js";

function sinks() {
  const out = new StringSink();
  const err = new StringSink();
  return { w: { out, err }, out, err };
}

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
          },
        ],
        next_cursor: null,
      },
      {},
      w,
    );
    expect(out.data).toContain("DATASET ID");
    expect(out.data).toContain("support-triage");
    expect(out.data).toContain("dsv_01JG8Z");
    expect(err.data).toContain("1 dataset");
    // No UPDATED column: the delivered dataset read carries no `updated_at`, and a
    // column of em dashes would imply the data exists and is missing.
    expect(out.data).not.toContain("UPDATED");
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
          { dataset_version_id: "dsv_0", version_number: 2, label: null, case_count: null },
        ],
      },
      {},
      w,
    );
    expect(out.data).toContain("*");
    expect(out.data).toContain("120");
    // An absent count renders as an em dash — "not reported" is not "zero cases".
    expect(out.data).toContain("—");
    expect(out.data).not.toMatch(/\s0\s+\d{4}-/);
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

  it("never promotes an undeclared coverage to full", () => {
    expect(coverageLine({ mode: "unknown" })).toContain("did not declare");
    expect(coverageLine({ mode: "full", selected_case_count: 120, dataset_case_count: 120 })).toBe(
      "full — 120 of 120 cases",
    );
    expect(
      coverageLine({
        mode: "sample",
        selected_case_count: 25,
        dataset_case_count: 120,
        sample_seed: 7,
      }),
    ).toBe("sample — 25 of 120 cases (seed 7)");
  });

  it("marks a subset run NOT FINAL and labels derived metrics as per-case means", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        coverage: { mode: "first_n", selected_case_count: 25, dataset_case_count: 120 },
        scores: [{ name: "accuracy", value: 0.84 }],
        metrics: [{ name: "tokens", value: 1204.5, unit: "tok" }],
        comparison: null,
      },
      w,
    );
    expect(out.data).toContain("NOT FINAL");
    expect(out.data).toContain("(mean per case)");
    // The run total and the per-case mean are different numbers; the label is
    // what stops the smaller one being read as the larger.
    expect(out.data).toContain("1,205");
  });

  it("counts every way a case can fail to score", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        coverage: { mode: "full" },
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
    expect(out.data).not.toContain("NOT FINAL");
  });

  it("shows how many cases each score covered", () => {
    const { w, out } = sinks();
    renderRun(
      {
        ...base,
        coverage: { mode: "full" },
        scores: [{ name: "accuracy", value: 0.9, observed_count: 25 }],
      },
      w,
    );
    expect(out.data).toContain("CASES");
    expect(out.data).toMatch(/accuracy\s+0\.9\s+—\s+25/);
  });

  it("says nothing about comparing: v0.5 reads a run, it does not compare two", () => {
    const { w, out, err } = sinks();
    renderRun({ ...base, coverage: { mode: "full" }, scores: [{ name: "accuracy", value: 1 }] }, w);
    expect(`${out.data}${err.data}`).not.toMatch(/baseline|compar/i);
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

  it("'evals runs get' sends the run id and nothing else", async () => {
    const h = harness({ evaluation_name: "e", status: "completed", coverage: { mode: "full" } });
    await h.run("evals", "runs", "get", "r_1");
    expect(h.fake.calls[0].url).toBe("https://api.test/api/v1/public/evaluation-runs/r_1");
  });

  it("'evals runs get' has no --baseline: comparison is not part of the read", async () => {
    const h = harness({ evaluation_name: "e", status: "completed", coverage: { mode: "full" } });
    await expect(h.run("evals", "runs", "get", "r_1", "--baseline", "r_0")).rejects.toThrow(
      /unknown option '--baseline'/,
    );
    expect(h.fake.calls).toHaveLength(0);
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
