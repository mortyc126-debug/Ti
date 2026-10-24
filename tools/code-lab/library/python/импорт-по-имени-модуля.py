def normalize_name(value: str) -> str:
    return value.strip().casefold()

if __name__ == "__main__":
    print(normalize_name("  Python  "))
