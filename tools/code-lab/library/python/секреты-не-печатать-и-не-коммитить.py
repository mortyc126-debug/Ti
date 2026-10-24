def mask_secret(value: str) -> str:
    if not value:
        return "<empty>"
    if len(value) <= 4:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - 4) + value[-2:]

assert mask_secret("") == "<empty>"
assert mask_secret("abcd") == "****"
print(mask_secret("sk-live-123456"))
