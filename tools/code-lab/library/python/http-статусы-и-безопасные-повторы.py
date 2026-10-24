RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


def should_retry(status: int, *, idempotent: bool, attempt: int, max_attempts: int) -> bool:
    if attempt >= max_attempts or not idempotent:
        return False
    return status in RETRYABLE_STATUS

assert should_retry(503, idempotent=True, attempt=1, max_attempts=3)
assert not should_retry(401, idempotent=True, attempt=1, max_attempts=3)
assert not should_retry(503, idempotent=False, attempt=1, max_attempts=3)
assert not should_retry(503, idempotent=True, attempt=3, max_attempts=3)
print("Проверки повторов пройдены")
