import asyncio

async def fetch_value(value):
    await asyncio.sleep(0.01)
    return value * 2

async def main():
    results = []
    async with asyncio.TaskGroup() as group:
        tasks = [group.create_task(fetch_value(v)) for v in (1, 2, 3)]
    results = [task.result() for task in tasks]
    print(results)

if __name__ == "__main__":
    asyncio.run(main())
