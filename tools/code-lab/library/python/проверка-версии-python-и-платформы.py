import platform
import sys

minimum = (3, 11)
print("Python:", platform.python_version())
print("Платформа:", platform.platform())
if sys.version_info < minimum:
    raise RuntimeError(f"Требуется Python {minimum[0]}.{minimum[1]} или новее")
print("Версия подходит")
