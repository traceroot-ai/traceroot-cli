"""An inline dataset: a plain list of two rows, with no case ids."""

from traceroot.eval import Evaluation


def to_upper(word):
    return word.upper()


def exact_match(ctx):
    return ctx.output == ctx.expected


evaluation = Evaluation(
    name="uppercase",
    dataset=[
        {"input": "alpha", "expected": "ALPHA"},
        {"input": "beta", "expected": "BETA"},
    ],
    task=to_upper,
    scorers=[exact_match],
)
