from configparser import ConfigParser

# Cerebras — классификация тональности новостей.
# Ключ хранится в settings.ini [NEWS] CEREBRAS_API_KEY (получить:
# https://cloud.cerebras.ai → API Keys), а не в отдельной переменной
# окружения — все остальные секреты бота тоже лежат в settings.ini.
_ini = ConfigParser()
_ini.read("settings.ini", encoding="utf-8")
CEREBRAS_API_KEY = _ini.get("NEWS", "CEREBRAS_API_KEY", fallback="")
if CEREBRAS_API_KEY == "YOUR_CEREBRAS_KEY":
    CEREBRAS_API_KEY = ""

# Провайдер LLM для анализа новостей: "yandex" (доступен из РФ) или "cerebras"
# (заблокирован Cloudflare для рос. IP — оставлен для запуска через VPN).
NEWS_LLM_PROVIDER = _ini.get("NEWS", "LLM_PROVIDER", fallback="yandex").strip().lower()

# YandexGPT (llm.api.cloud.yandex.net) — работает с рос. IP без VPN.
# API-ключ сервисного аккаунта с ролью ai.languageModels.user + folder_id.
YANDEX_API_KEY = _ini.get("NEWS", "YANDEX_API_KEY", fallback="").strip()
YANDEX_FOLDER_ID = _ini.get("NEWS", "YANDEX_FOLDER_ID", fallback="").strip()
# yandexgpt-lite дешевле и для классификации новостей достаточно; "yandexgpt"
# — умнее, но дороже. Меняется в settings.ini [NEWS] YANDEX_MODEL.
YANDEX_MODEL = _ini.get("NEWS", "YANDEX_MODEL", fallback="yandexgpt-lite").strip()

NEWS_FEEDS = [
    "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
    "https://www.interfax.ru/rss.asp",
]
NEWS_POLL_MINUTES = 10

# Ключевые слова для привязки новости к тикеру (нижний регистр).
TICKER_KEYWORDS = {
    "SBER": ["сбер", "сбербанк", "sber"],
    "GAZP": ["газпром", "gazprom"],
    "LKOH": ["лукойл", "lukoil"],
    "VTBR": ["втб", "vtb"],
    "SMLT": ["самолёт", "самолет", "smlt"],
    "YDEX": ["яндекс", "yandex", "ydex", "yndx"],
    "VKCO": ["вконтакте", "vkco", "вк групп", "vk group"],
    "RUAL": ["русал", "rusal", "rual"],
    "MGNT": ["магнит", "magnit", "mgnt"],
}

# Корпоративные раскрытия (e-disclosure.ru).
# RSS конкретной компании: страница на e-disclosure.ru → RSS.
DISCLOSURE_FEEDS = [
    # "https://www.e-disclosure.ru/rss/company.aspx?id=XXXXX",
]
