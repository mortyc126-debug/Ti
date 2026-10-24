import asyncio
from contextvars import ContextVar

request_id = ContextVar("request_id", default="none")

async def handle(value):
    token = request_id.set(value)
    try:
        await asyncio.sleep(0)
        return request_id.get()
    finally:
        request_id.reset(token)

async def main():
    result = await asyncio.gather(handle("A"), handle("B"))
    assert result == ["A", "B"]
    print(result)

if __name__ == "__main__":
    asyncio.run(main())
