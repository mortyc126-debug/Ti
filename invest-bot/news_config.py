import os

# Cerebras — классификация тональности новостей.
# Получить ключ: https://cloud.cerebras.ai → API Keys
CEREBRAS_API_KEY = os.getenv("CEREBRAS_API_KEY", "")

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
