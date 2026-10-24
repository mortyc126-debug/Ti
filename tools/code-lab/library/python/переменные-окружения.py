import os

режим = os.getenv("APP_MODE", "development")
print(режим)
# Не записывайте пароли и токены непосредственно в исходный код.
