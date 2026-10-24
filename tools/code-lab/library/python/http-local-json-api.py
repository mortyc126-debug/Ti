import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from urllib.request import urlopen

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        тело = json.dumps({"status": "ok", "items": 2}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(тело)))
        self.end_headers()
        self.wfile.write(тело)

    def log_message(self, format, *args):
        pass

сервер = HTTPServer(("127.0.0.1", 0), Handler)
поток = Thread(target=сервер.serve_forever, daemon=True)
поток.start()
try:
    with urlopen(f"http://127.0.0.1:{сервер.server_port}/", timeout=2) as ответ:
        if ответ.status != 200:
            raise RuntimeError(f"HTTP status: {ответ.status}")
        данные = json.load(ответ)
    print(данные)
finally:
    сервер.shutdown()
    сервер.server_close()
    поток.join(timeout=2)
