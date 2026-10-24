import asyncio

async def получить(значение, задержка):
    await asyncio.sleep(задержка)
    return значение

async def main():
    результаты = await asyncio.gather(получить("A", 0.02), получить("B", 0.01))
    print(результаты)

asyncio.run(main())
