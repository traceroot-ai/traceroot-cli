import type { Sink } from "../../src/output.js";

/** In-memory {@link Sink} that accumulates everything written to it. */
export class StringSink implements Sink {
  data = "";
  readonly isTTY?: boolean;

  constructor(isTTY?: boolean) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}
