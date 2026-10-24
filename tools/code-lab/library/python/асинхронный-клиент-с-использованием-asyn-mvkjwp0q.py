import asyncio

async def обработать_клиента(reader, writer):
    данные = await reader.read(100)
    writer.write(данные)
    await writer.drain()
    writer.close()
    await writer.wait_closed()

async def async_client(host, port, message):
    reader, writer = await asyncio.open_connection(host, port)
    try:
        writer.write(message.encode("utf-8"))
        await writer.drain()
        data = await reader.read(100)
        return data.decode("utf-8")
    finally:
        writer.close()
        await writer.wait_closed()

async def main():
    # Локальный сервер делает пример самодостаточным: внешний сервер не нужен.
    server = await asyncio.start_server(обработать_клиента, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        response = await async_client("127.0.0.1", port, "Hello async!")
        print(f"Response: {response}")

asyncio.run(main())
