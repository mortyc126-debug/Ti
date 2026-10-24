import cProfile
import pstats
from io import StringIO

def work():
    return sum(i * i for i in range(10_000))

profiler = cProfile.Profile()
profiler.enable()
work()
profiler.disable()
stream = StringIO()
pstats.Stats(profiler, stream=stream).sort_stats("cumulative").print_stats(3)
print(stream.getvalue())
