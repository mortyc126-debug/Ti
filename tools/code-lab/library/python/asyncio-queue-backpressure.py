import asyncio

async def demo():
    queue = asyncio.Queue(maxsize=1)
    await queue.put("first")
    assert queue.full()
    item = await queue.get()
    queue.task_done()
    await queue.put("second")
    second = await queue.get()
    queue.task_done()
    await queue.join()
    print(item, second, queue.qsize())

asyncio.run(demo())
