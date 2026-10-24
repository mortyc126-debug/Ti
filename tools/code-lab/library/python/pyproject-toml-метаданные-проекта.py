import tomllib

config_text = """[project]
name = "market-tools"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["requests>=2.31,<3"]
"""
config = tomllib.loads(config_text)
project = config["project"]
assert project["name"] == "market-tools"
assert project["requires-python"] == ">=3.11"
print(project["name"], project["version"])
