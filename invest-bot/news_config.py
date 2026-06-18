from configparser import ConfigParser

# Cerebras — классификация тональности новостей.
# Ключ хранится в settings.ini [NEWS] CEREBRAS_API_KEY (получить:
# https://cloud.cerebras.ai → API Keys), а не в отдельной переменной
# окружения — все остальные секреты бота тоже лежат в settings.ini.
_ini = ConfigParser()
_ini.read("settings.ini")
CEREBRAS_API_KEY = _ini.get("NEWS", "CEREBRAS_API_KEY", fallback="")
if CEREBRAS_API_KEY == "YOUR_CEREBRAS_KEY":
    CEREBRAS_API_KEY = ""

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
}

# Корпоративные раскрытия (e-disclosure.ru).
# RSS конкретной компании: страница на e-disclosure.ru → RSS.
DISCLOSURE_FEEDS = [
    # "https://www.e-disclosure.ru/rss/company.aspx?id=XXXXX",
]
