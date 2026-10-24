import subprocess
import sys

result = subprocess.run(
    [sys.executable, "-c", "print('child process')"],
    check=True,
    capture_output=True,
    text=True,
    timeout=5,
)
print(result.stdout.strip())
