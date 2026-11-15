"""The all-pass evaluation, stopped with SIGINT while its second case is running.

The task for "beta" waits for a marker file that nothing creates, so the second case is always
in flight when the recording script sends SIGINT. The wait gives up after a minute, so a
recording that never sends the signal fails instead of hanging.
"""

import asyncio
import os
import time

from traceroot.eval import Dataset, Evaluation, scorer

MARKER = "release-second-case"

words = Dataset("words")
words.add("alpha", expected="ALPHA")
words.add("beta", expected="BETA")
words.add("gamma", expected="GAMMA")


async def to_upper(word):
    if word == "beta":
        deadline = time.monotonic() + 60
        while not os.path.exists(MARKER):
            if time.monotonic() > deadline:
                raise TimeoutError("the second case was never interrupted")
            await asyncio.sleep(0.05)
    return word.upper()


def exact_match(ctx):
    return ctx.output == ctx.expected


@scorer(name="not_empty", version="2")
def check_not_empty(ctx):
    return len(ctx.output) > 0


evaluation = Evaluation(
    name="uppercase",
    dataset=words,
    task=to_upper,
    scorers=[exact_match, check_not_empty],
)
