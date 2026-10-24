import tomllib
from pathlib import Path

config_text = """
[database]
timeout_seconds = 5
read_only = true
"""
config = tomllib.loads(config_text)
database = config["database"]
assert database["timeout_seconds"] == 5
assert database["read_only"] is True
print(database)
