"""Module a."""
import os
from .b import helper, Base


class Thing(Base):
    """A thing."""

    def run(self, x):
        """Run it."""
        return helper(x) + self.twice(x)

    def twice(self, x):
        return x * 2


def top(y):
    t = Thing()
    return t.run(y)
