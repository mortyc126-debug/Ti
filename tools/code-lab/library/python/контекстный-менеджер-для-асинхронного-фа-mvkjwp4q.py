import aiofiles
import asyncio

async def async_file_operations(file_path, data):
    async with aiofiles.open(file_path, mode='w') as f:
        await f.write(data)
    async with aiofiles.open(file_path, mode='r') as f:
        content = await f.read()
    return content

# Пример использования
async def main():
    result = await async_file_operations('test_async.txt', 'Hello async file!')
    print(f'File content: {result}')

asyncio.run(main())