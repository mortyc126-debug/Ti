import socket

class SocketManager:
    def __init__(self, host, port, timeout=5.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.socket = None

    def __enter__(self):
        self.socket = socket.create_connection((self.host, self.port), timeout=self.timeout)
        return self.socket

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.socket:
            self.socket.close()
            self.socket = None
        return False  # не подавлять исключение из блока with

try:
    with SocketManager("localhost", 8080) as sock:
        sock.sendall(b"Hello, server!")
except (ConnectionRefusedError, socket.timeout, OSError) as ошибка:
    print("Не удалось подключиться к серверу:", ошибка)

# В стандартной библиотеке socket.create_connection также поддерживает with.
# Если сервер доступен, можно использовать его напрямую:
# with socket.create_connection(("localhost", 8080), timeout=5) as sock:
#     sock.sendall(b"Hello, server!")
