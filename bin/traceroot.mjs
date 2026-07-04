#!/usr/bin/env node
import("../dist/cli.js")
  .then((m) => m.run(process.argv))
  .catch((err) => {
    process.stderr.write(`traceroot: ${err?.message ?? err}\n`);
    process.exit(1);
  });
