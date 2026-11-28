"""Imports a sibling module that does not exist, so the file fails to import."""

from helpers import normalize
from traceroot.eval import Dataset, Evaluation

words = Dataset("words")
words.add("alpha", expected="ALPHA")


def to_upper(word):
    return normalize(word).upper()


def exact_match(ctx):
    return ctx.output == ctx.expected


evaluation = Evaluation(name="uppercase", dataset=words, task=to_upper, scorers=[exact_match])
