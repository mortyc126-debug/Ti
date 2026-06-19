"""
dashboard.py — браузерный дашборд для прогона виртуальных сделок
(бэктеста) по тикерам из settings.ini, без командной строки.

Логика бэктеста — та же, что в compare_take_stop.py (fixed take/stop vs
ATR-сетка через OICompositeStrategy.backtest_scan_signals/backtest_barriers),
просто доступна через веб-форму с галочками по тикерам.

Если прогон тикера падает с исключением — ошибка не валит всю страницу:
traceback ловится, прогон остальных тикеров продолжается, а к упавшему
тикеру через bug_council.analyze_bug() автоматически прикладывается
AI-диагноз (или просто traceback, если ключа Cerebras нет). Кнопка
«Спросить совет» позволяет так же вручную закинуть любой traceback/лог.

Запуск:  python dashboard.py [--port 8765]
Без внешних зависимостей — только stdlib (http.server) + сам invest-bot.
"""

import argparse
import json
import logging
import traceback
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from tinkoff.invest.exceptions import RequestError

import bug_council
from configuration.configuration import ProgramConfiguration
from invest_api.services.market_data_service import MarketDataService
from trade_system.strategies.strategy_factory import StrategyFactory

CONFIG_FILE = "settings.ini"

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

_config = ProgramConfiguration(CONFIG_FILE)
_market_data = MarketDataService(_config.tinkoff_token, _config.tinkoff_app_name)


def _strategy_settings_by_ticker() -> dict:
    return {s.ticker: s for s in _config.trade_strategy_settings}


def run_backtest(tickers: list[str], days: int, atr_take_ks: list[float], atr_stop_ks: list[float]) -> list[dict]:
    """
    Прогоняет бэктест по выбранным тикерам. Возвращает список строк-результатов
    (как в compare_take_stop.py: fixed + лучшая ATR-комбинация на тикер),
    либо строку с ошибкой и советом, если тикер упал.
    """
    by_ticker = _strategy_settings_by_ticker()
    rows: list[dict] = []

    for ticker in tickers:
        strategy_settings = by_ticker.get(ticker)
        if strategy_settings is None:
            rows.append({"ticker": ticker, "mode": "ошибка", "error": "нет в settings.ini"})
            continue

        try:
            strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
            if strategy is None or not hasattr(strategy, "backtest_barriers"):
                rows.append({"ticker": ticker, "mode": "пропуск",
                             "error": "стратегия не поддерживает backtest_barriers"})
                continue

            try:
                candles = _market_data.get_candles_history(strategy_settings.figi, days=days)
            except RequestError as ex:
                rows.append({"ticker": ticker, "mode": "ошибка API", "error": str(ex.details)})
                continue

            if not candles:
                rows.append({"ticker": ticker, "mode": "нет истории", "error": ""})
                continue

            s = strategy_settings.settings
            long_take = Decimal(s.get("LONG_TAKE", "1.015"))
            long_stop = Decimal(s.get("LONG_STOP", "0.985"))

            signals = strategy.backtest_scan_signals(candles)

            fixed = strategy.backtest_barriers(signals=signals, take_mult=long_take, stop_mult=long_stop)
            rows.append({"ticker": ticker, "mode": "fixed", **fixed})

            best = None
            for tk in atr_take_ks:
                for sk in atr_stop_ks:
                    res = strategy.backtest_barriers(signals=signals, atr_take_k=tk, atr_stop_k=sk)
                    if res["n_trades"] == 0:
                        continue
                    if best is None or res["expectancy_pct"] > best[1]["expectancy_pct"]:
                        best = ((tk, sk), res)

            if best:
                (tk, sk), res = best
                rows.append({"ticker": ticker, "mode": f"ATR k={tk}/{sk}", **res})

        except Exception:
            tb = traceback.format_exc()
            context = (f"dashboard run_backtest: ticker={ticker}, days={days}, "
                       f"atr_take={atr_take_ks}, atr_stop={atr_stop_ks}")
            advice = bug_council.analyze_bug(tb, context)
            logger.error(f"run_backtest {ticker}:\n{tb}")
            rows.append({"ticker": ticker, "mode": "ошибка", "error": tb.strip().splitlines()[-1],
                         "traceback": tb, "advice": advice})

    return rows


PAGE_HTML = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>invest-bot — виртуальные сделки</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 24px; background: #0f1117; color: #e6e6e6; }}
h1 {{ font-size: 20px; }}
.box {{ background: #1a1d27; border-radius: 8px; padding: 16px; margin-bottom: 20px; }}
label {{ display: inline-block; margin: 4px 12px 4px 0; }}
input[type=text], input[type=number] {{ background: #0f1117; color: #e6e6e6; border: 1px solid #333; border-radius: 4px; padding: 4px 8px; }}
button {{ background: #3b6fd4; color: white; border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer; font-size: 14px; }}
button:hover {{ background: #4a7de0; }}
table {{ border-collapse: collapse; width: 100%; margin-top: 12px; }}
th, td {{ border-bottom: 1px solid #2a2d3a; padding: 6px 10px; text-align: right; font-size: 13px; }}
th:first-child, td:first-child {{ text-align: left; }}
.err {{ color: #ff6b6b; }}
.advice {{ background: #0f1117; border: 1px solid #333; border-radius: 4px; padding: 8px; margin-top: 4px; font-size: 12px; white-space: pre-wrap; }}
textarea {{ width: 100%; height: 140px; background: #0f1117; color: #e6e6e6; border: 1px solid #333; border-radius: 4px; }}
#status {{ font-size: 13px; color: #999; }}
</style>
</head>
<body>
<h1>invest-bot — прогон виртуальных сделок</h1>

<div class="box">
  <h3>Бэктест</h3>
  <div id="tickers">{ticker_checkboxes}</div>
  <label>Дней истории: <input type="number" id="days" value="30" min="1" max="90"></label>
  <label>ATR_TAKE_K: <input type="text" id="atr_take" value="2,3,4"></label>
  <label>ATR_STOP_K: <input type="text" id="atr_stop" value="1,1.5,2"></label>
  <br><br>
  <button onclick="runBacktest()">Запустить бэктест</button>
  <span id="status"></span>
  <table id="results"></table>
</div>

<div class="box">
  <h3>Спросить совет по багу</h3>
  <textarea id="bugtext" placeholder="Вставь traceback или лог..."></textarea><br><br>
  <button onclick="askCouncil()">Спросить совет</button>
  <div id="council_answer"></div>
</div>

<script>
function renderRows(rows) {{
  const table = document.getElementById('results');
  let html = '<tr><th>Тикер</th><th>Режим</th><th>Сделок</th><th>Win%</th><th>avg R</th><th>Exp%</th></tr>';
  for (const r of rows) {{
    if (r.error !== undefined && r.n_trades === undefined) {{
      html += `<tr><td>${{r.ticker}}</td><td colspan="5" class="err">${{r.mode}}: ${{r.error || ''}}</td></tr>`;
      if (r.advice && r.advice.used_ai) {{
        html += `<tr><td></td><td colspan="5"><div class="advice">
          <b>Диагноз:</b> ${{r.advice.diagnosis}}<br>
          <b>Вероятная причина:</b> ${{r.advice.likely_cause}}<br>
          <b>Предлагаемая правка:</b> ${{r.advice.suggested_fix}}</div></td></tr>`;
      }} else if (r.traceback) {{
        html += `<tr><td></td><td colspan="5"><div class="advice">${{r.traceback}}</div></td></tr>`;
      }}
      continue;
    }}
    const winPct = r.win_rate !== undefined ? (r.win_rate * 100).toFixed(1) + '%' : '';
    const exp = r.expectancy_pct !== undefined ? (r.expectancy_pct * 100).toFixed(2) + '%' : '';
    const avgR = r.avg_r !== undefined ? r.avg_r.toFixed(2) : '';
    html += `<tr><td>${{r.ticker}}</td><td>${{r.mode}}</td><td>${{r.n_trades ?? ''}}</td><td>${{winPct}}</td><td>${{avgR}}</td><td>${{exp}}</td></tr>`;
  }}
  table.innerHTML = html;
}}

async function runBacktest() {{
  const tickers = Array.from(document.querySelectorAll('.tk:checked')).map(c => c.value);
  if (tickers.length === 0) {{ alert('Выбери хотя бы один тикер'); return; }}
  document.getElementById('status').textContent = 'Считаю...';
  const body = {{
    tickers: tickers,
    days: parseInt(document.getElementById('days').value, 10),
    atr_take: document.getElementById('atr_take').value,
    atr_stop: document.getElementById('atr_stop').value,
  }};
  const resp = await fetch('/api/backtest', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify(body)}});
  const data = await resp.json();
  document.getElementById('status').textContent = '';
  renderRows(data.rows);
}}

async function askCouncil() {{
  const text = document.getElementById('bugtext').value;
  if (!text.trim()) return;
  const div = document.getElementById('council_answer');
  div.innerHTML = '<i>Спрашиваю...</i>';
  const resp = await fetch('/api/council', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{text: text}})}});
  const data = await resp.json();
  if (data.used_ai) {{
    div.innerHTML = `<div class="advice"><b>Диагноз:</b> ${{data.diagnosis}}<br><b>Вероятная причина:</b> ${{data.likely_cause}}<br><b>Предлагаемая правка:</b> ${{data.suggested_fix}}</div>`;
  }} else {{
    div.innerHTML = '<div class="advice">AI недоступен (нет CEREBRAS_API_KEY или ошибка вызова) — добавь ключ в settings.ini [NEWS].</div>';
  }}
}}
</script>
</body>
</html>
"""


def _render_page() -> bytes:
    tickers = sorted(_strategy_settings_by_ticker().keys())
    checkboxes = "".join(
        f'<label><input type="checkbox" class="tk" value="{t}" checked> {t}</label>'
        for t in tickers
    )
    return PAGE_HTML.format(ticker_checkboxes=checkboxes).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            body = _render_page()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "bad json"}, 400)
            return

        if self.path == "/api/backtest":
            tickers = payload.get("tickers", [])
            days = int(payload.get("days", 30))
            atr_take_ks = [float(x) for x in str(payload.get("atr_take", "2,3,4")).split(",") if x.strip()]
            atr_stop_ks = [float(x) for x in str(payload.get("atr_stop", "1,1.5,2")).split(",") if x.strip()]
            rows = run_backtest(tickers, days, atr_take_ks, atr_stop_ks)
            self._send_json({"rows": rows})
        elif self.path == "/api/council":
            text = payload.get("text", "")
            advice = bug_council.analyze_bug(text, context="ручной запрос через дашборд")
            self._send_json(advice)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Дашборд: http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
