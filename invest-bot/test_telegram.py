"""
Разовый скрипт для проверки Telegram-уведомлений отдельно от торгового бота.
Запуск: python3 test_telegram.py
Берёт токен и chat_id из settings.ini, шлёт одно тестовое сообщение.
"""
import asyncio
from configparser import ConfigParser

from aiogram import Bot


async def main():
    config = ConfigParser()
    config.read("settings.ini")
    token = config["BLOG"]["TELEGRAM_BOT_TOKEN"]
    chat_id = config["BLOG"]["TELEGRAM_CHAT_ID"]
    print(f"token={token[:10]}... chat_id={chat_id}")

    bot = Bot(token=token)
    await bot.send_message(chat_id=chat_id, text="Тест: invest-bot настроен и может писать сюда.")
    print("Сообщение отправлено, проверь Telegram.")


if __name__ == "__main__":
    asyncio.run(main())
