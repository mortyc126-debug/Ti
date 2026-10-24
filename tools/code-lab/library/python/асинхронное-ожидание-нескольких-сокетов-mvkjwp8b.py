import asyncio

async def обработать_клиента(reader, writer):
    данные = await reader.read(100)
    writer.write(данные)
    await writer.drain()
    writer.close()
    await writer.wait_closed()

async def клиент(port, сообщение):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(сообщение.encode("utf-8"))
    await writer.drain()
    ответ = await reader.read(100)
    writer.close()
    await writer.wait_closed()
    return ответ.decode("utf-8")

async def main():
    server = await asyncio.start_server(обработать_клиента, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        ответы = await asyncio.gather(клиент(port, "первый"), клиент(port, "второй"))
    print(ответы)

asyncio.run(main())
