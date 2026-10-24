import asyncio

async def медленная_операция():
    await asyncio.sleep(1)

async def main():
    try:
        async with asyncio.timeout(0.01):
            await медленная_операция()
    except TimeoutError:
        print("TimeoutError перехвачен")

asyncio.run(main())
