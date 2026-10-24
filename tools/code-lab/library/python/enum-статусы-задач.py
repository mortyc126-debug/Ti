from enum import Enum, auto

class TaskStatus(Enum):
    PENDING = auto()
    RUNNING = auto()
    DONE = auto()

status = TaskStatus.DONE
assert status is TaskStatus.DONE
print(status.name)
