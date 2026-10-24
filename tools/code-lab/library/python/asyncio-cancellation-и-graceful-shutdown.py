import asyncio

async def worker(cleaned):
    try:
        await asyncio.sleep(10)
    finally:
        cleaned.append("resource closed")

async def main():
    cleaned = []
    task = asyncio.create_task(worker(cleaned))
    await asyncio.sleep(0)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert cleaned == ["resource closed"]
    print("Отмена обработана, ресурс закрыт")

asyncio.run(main())
