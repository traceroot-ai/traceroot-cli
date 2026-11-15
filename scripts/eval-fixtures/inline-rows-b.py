"""The inline dataset from inline-rows-a with its second row replaced: same size, other rows."""

from traceroot.eval import Evaluation


def to_upper(word):
    return word.upper()


def exact_match(ctx):
    return ctx.output == ctx.expected


evaluation = Evaluation(
    name="uppercase",
    dataset=[
        {"input": "alpha", "expected": "ALPHA"},
        {"input": "delta", "expected": "DELTA"},
    ],
    task=to_upper,
    scorers=[exact_match],
)
