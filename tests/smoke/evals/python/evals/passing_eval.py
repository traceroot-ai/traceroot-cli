"""Every case passes both scorers."""

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
    return len(ctx.output) > 0


evaluation = Evaluation(
    name="uppercase",
    dataset=words,
    task=to_upper,
    scorers=[exact_match, check_not_empty],
)
