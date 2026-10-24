import asyncio

async def main():
    semaphore = asyncio.Semaphore(2)
    active = 0
    peak = 0

    async def task():
        nonlocal active, peak
        async with semaphore:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1

    await asyncio.gather(*(task() for _ in range(8)))
    assert peak <= 2
    print("peak active:", peak)

if __name__ == "__main__":
    asyncio.run(main())
