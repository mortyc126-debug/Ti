import time

def retry(operation, attempts=3, base_delay=0.1, sleep=time.sleep):
    for attempt in range(attempts):
        try:
            return operation()
        except (TimeoutError, ConnectionError):
            if attempt == attempts - 1:
                raise
            sleep(base_delay * (2 ** attempt))

if __name__ == "__main__":
    calls = {"n": 0}
    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise TimeoutError("временный сбой")
        return "ok"
    print(retry(flaky, sleep=lambda _: None))
