"""Builds its evaluation inside a function, so the runner finds none at module level."""

from traceroot.eval import Dataset, Evaluation


def to_upper(word):
    return word.upper()


def exact_match(ctx):
    return ctx.output == ctx.expected


def build_evaluation():
    words = Dataset("words")
    words.add("alpha", expected="ALPHA")
    return Evaluation(name="uppercase", dataset=words, task=to_upper, scorers=[exact_match])


if __name__ == "__main__":
    build_evaluation().run(local=True)
