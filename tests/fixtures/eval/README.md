# Recorded eval runner output

Each `<sdk>-<version>/<scenario>/` directory holds what a released SDK's eval runner wrote for one
scenario:

- `events.jsonl`: the event stream;
- `runs/<run id>.json` and `runs/<run id>.cases.jsonl`: the run the runner saved, if it saved one;
- `exit-status`: the runner's exit status.

`scripts/record-eval-fixtures.sh` rebuilds every directory from the evaluation files in
`scripts/eval-fixtures`. It replaces run ids, timestamps, durations and absolute paths with fixed
values (`<project>`, `<site-packages>`, `<stdlib>`, `<node_modules>`), so recording again gives the
same files. Everything else is byte for byte what the runner wrote.

Every scenario is recorded on traceroot 0.5.1 and on @traceroot-ai/traceroot 0.8.1 (run through
tsx). traceroot 0.3.0 and @traceroot-ai/traceroot 0.8.0 record only `all-pass` and `import-error`:
their eval code is the same as in the newest release.

Every runner runs with `{"max_concurrency": 1}`, no API key and `TRACEROOT_ENABLED=false`, except
where the scenario says otherwise.

| Scenario | What the runner was given |
|---|---|
| `all-pass` | An evaluation named `uppercase` over a three-case `Dataset`. Every case passes an unversioned scorer, `exact_match`, and a versioned one, `not_empty` (version 2). |
| `one-fails` | The same evaluation after a change that makes `exact_match` fail on `beta`. |
| `task-error` | The same evaluation with a task that raises on `beta`. |
| `scorer-error-unversioned` | The same evaluation with `exact_match` raising on `beta`. |
| `scorer-error-versioned` | The same evaluation with `not_empty` raising on `beta`. Its function has a different name. |
| `numeric-no-threshold` | The same evaluation plus `output_length`, a numeric scorer with no threshold. |
| `sampled` | The `all-pass` file, with `{"sample": 1}`. |
| `interrupted` | The same evaluation, sent SIGINT while its second case runs. traceroot drops the case in flight, and @traceroot-ai/traceroot finishes it. |
| `import-error` | A file that fails to import. |
| `no-evaluations` | A file that builds its evaluation inside a function, so none exists at module level. |
| `inline-rows-a` | An inline dataset: a plain list of two rows without ids. |
| `inline-rows-b` | An inline dataset of the same size as `inline-rows-a`, with a different second row. |
| `upload-plain-list` | The `inline-rows-a` file, with `{"reporting": true}`, a fake API key and a TraceRoot host that refuses connections. |
