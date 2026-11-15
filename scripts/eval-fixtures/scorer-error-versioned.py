"""The all-pass evaluation, with the versioned scorer raising on "beta".

The scorer declares a name that differs from its function name, so the recording shows which of
the two a raising scorer is recorded under.
"""

from traceroot.eval import Dataset, Evaluation, scorer

words = Dataset("words")
words.add("alpha", expected="ALPHA")
words.add("beta", expected="BETA")
words.add("gamma", expected="GAMMA")


def to_upper(word):
    return word.upper()


def exact_match(ctx):
    return ctx.output == ctx.expected


@scorer(name="not_empty", version="2")
def check_not_empty(ctx):
    if ctx.input == "beta":
        raise ValueError(f"cannot check {ctx.input!r}")
    return len(ctx.output) > 0


evaluation = Evaluation(
    name="uppercase",
    dataset=words,
    task=to_upper,
    scorers=[exact_match, check_not_empty],
)
