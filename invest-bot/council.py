"""
council.py — Торговый консилиум агентов.

Перед размещением ордера запускается дебат двух ИИ-агентов:
  Наблюдатель «Альфа» строит тезис (торговать / нет),
  Скептик «Бета» оценивает и либо соглашается, либо опровергает.

Если согласие — решение принято. Если нет — Модератор выносит приговор.
Всё работает через Cerebras (llama-3.3-70b) — тот же ключ, что у NewsCollector.
Если ключ не задан — council отключён, торгуем без ИИ-совета (advisory only).

Уроки прошлых консилиумов хранятся в data/council_lessons.json и передаются
агентам как контекст — система самообучается на собственных решениях.

Интеграция с trade_analytics.py: перед консилиумом строим краткую сводку
по тикеру из data/archive.json и передаём агентам как «что мы знаем о нём».
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime

from news_config import CEREBRAS_API_KEY

logger = logging.getLogger(__name__)

LESSONS_FILE = "data/council_lessons.json"
MAX_LESSONS = 30          # храним последние N уроков в файле
MAX_LESSONS_TO_SHOW = 5  # показываем агентам только N последних

_TRUST_RULE = (
    "ПРАВИЛО РОССИЙСКОГО РЫНКА: не верь словам — верь действиям. "
    "Объёмы, реальные сделки крупных игроков, раскрытия — это информация. "
    "Заявления менеджмента, новости-слухи, плиты в стакане без исполнения — нет. "
    "Манипуляции стаканом здесь норма: большая плита может исчезнуть при подходе цены."
)

# Ключевые слова, по которым определяем «против сделки»
_NEG_KEYWORDS = [
    "не торговать", "пропустить", "воздержаться", "не рекомендую",
    "слабый сигнал", "риск высок", "не стоит", "опасно",
    "боковик", "неопределённость", "сомнительн",
]
_POS_KEYWORDS = [
    "торговать", "стоит войти", "хороший сетап", "сильный сигнал",
    "тренд подтверждён", "высокая вероятность", "рекомендую",
    "качественный", "чёткий сигнал",
]


# ── Cerebras вызов (синхронный, для run_in_executor) ──────────────────────────

def _cerebras_call(system: str, user: str, max_tokens: int = 400) -> str:
    try:
        from cerebras.cloud.sdk import Cerebras
        client = Cerebras(api_key=CEREBRAS_API_KEY)
        r = client.chat.completions.create(
            model="llama-3.3-70b",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=max_tokens,
        )
        return r.choices[0].message.content.strip()
    except Exception as e:
        logger.warning(f"council: cerebras error: {e}")
        return f"(недоступно: {type(e).__name__})"


# ── Уроки (память консилиума) ─────────────────────────────────────────────────

def _load_lessons() -> list[dict]:
    if not os.path.exists(LESSONS_FILE):
        return []
    try:
        with open(LESSONS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_lesson(lesson: dict) -> None:
    lessons = _load_lessons()
    lessons.append(lesson)
    lessons = lessons[-MAX_LESSONS:]
    os.makedirs("data", exist_ok=True)
    try:
        tmp = LESSONS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lessons, f, ensure_ascii=False, indent=2)
        os.replace(tmp, LESSONS_FILE)
    except Exception as e:
        logger.warning(f"council: сохранение урока: {e}")


def _format_lessons(lessons: list[dict], ticker: str) -> str:
    if not lessons:
        return "Уроков прошлых консилиумов пока нет."
    # приоритет урокам по тому же тикеру, остальные — общие
    by_ticker = [l for l in lessons if l.get("ticker") == ticker]
    others = [l for l in lessons if l.get("ticker") != ticker]
    shown = (by_ticker[-3:] + others[-2:])[-MAX_LESSONS_TO_SHOW:]
    lines = []
    for l in shown:
        date = l.get("ts", "?")[:10]
        t = l.get("ticker", "?")
        d = l.get("direction", "?")
        v = l.get("verdict", "?")
        text = l.get("lesson", "")[:200]
        lines.append(f"[{date}] {t} {d} → {v}: {text}")
    return "\n".join(lines)


# ── Системные промпты агентов ─────────────────────────────────────────────────

def _observer_system(lessons_text: str) -> str:
    return f"""Ты агент-наблюдатель «Альфа» на российском фондовом рынке.
Тебе показывают сигнал торгового бота — надо честно оценить: СТОИТ ли входить.
Смотри на режим рынка, качество сигнала, статистику прошлых сделок по этому тикеру.
Ищи ПРИЧИНЫ НЕ ТОРГОВАТЬ — не надо поддерживать каждый сигнал.
Отвечай коротко: 3-5 предложений, только суть.

{_TRUST_RULE}

Уроки прошлых консилиумов:
{lessons_text}"""


def _skeptic_system(lessons_text: str) -> str:
    return f"""Ты агент-скептик «Бета» на российском фондовом рынке.
Критически оцениваешь решение коллеги-наблюдателя.
Ищи слабые места: что он мог упустить, какие риски не учёл.
Если гипотеза обоснована — честно согласись. Не спорь ради спора.
Начни ответ СТРОГО одним из: СОГЛАСЕН / ЧАСТИЧНО / НЕ СОГЛАСЕН — затем объяснение (2-4 предложения).

{_TRUST_RULE}

Уроки:
{lessons_text}"""


def _moderator_system() -> str:
    return """Ты модератор консилиума. Агенты не смогли договориться.
Оцени аргументы нейтрально. Вынеси решение: ТОРГОВАТЬ или ПРОПУСТИТЬ.
Начни ответ с: РЕШЕНИЕ: ТОРГОВАТЬ или РЕШЕНИЕ: ПРОПУСТИТЬ — затем 2-3 предложения объяснения.
Будь кратким. Твоё решение финальное."""


# ── Определение вердикта ──────────────────────────────────────────────────────

def _count_sentiment(text: str) -> tuple[int, int]:
    """(pos_hits, neg_hits) — сколько позитивных и негативных слов в тексте."""
    t = text.lower()
    pos = sum(1 for kw in _POS_KEYWORDS if kw in t)
    neg = sum(1 for kw in _NEG_KEYWORDS if kw in t)
    return pos, neg


def _parse_skeptic(response: str) -> str:
    """Парсит начало ответа скептика: agree / partial / disagree."""
    r = response.upper().strip()
    if r.startswith("СОГЛАСЕН"):
        return "agree"
    if r.startswith("ЧАСТИЧНО"):
        return "partial"
    return "disagree"


def _derive_verdict(obs_a: str, skeptic_b: str,
                    moderator: str | None = None) -> tuple[str, float, str]:
    """
    Возвращает (verdict, confidence, reason).
    verdict: "trade" | "skip"
    """
    if moderator:
        mod_upper = moderator.upper()
        if "РЕШЕНИЕ: ТОРГОВАТЬ" in mod_upper or "РЕШЕНИЕ:ТОРГОВАТЬ" in mod_upper:
            return "trade", 0.65, "Модератор: ТОРГОВАТЬ"
        if "РЕШЕНИЕ: ПРОПУСТИТЬ" in mod_upper or "РЕШЕНИЕ:ПРОПУСТИТЬ" in mod_upper:
            return "skip", 0.70, "Модератор: ПРОПУСТИТЬ"
        # Нет явного маркера — анализируем текст
        pos, neg = _count_sentiment(moderator)
        if neg > pos:
            return "skip", 0.60, f"Модератор склоняется к пропуску (neg={neg})"
        return "trade", 0.55, f"Модератор без чёткого решения → торгуем"

    agreement = _parse_skeptic(skeptic_b)

    if agreement == "agree":
        # Скептик согласен — но смотрим, что именно говорит Альфа
        obs_pos, obs_neg = _count_sentiment(obs_a)
        if obs_neg > obs_pos:
            # Альфа сам говорит «не торговать», скептик согласен с этим
            return "skip", 0.75, "Консенсус: оба против сделки"
        return "trade", 0.80, "Консенсус: оба за сделку"

    if agreement == "partial":
        # Частичное согласие — смотрим общий тон
        combined = obs_a + " " + skeptic_b
        pos, neg = _count_sentiment(combined)
        if neg >= pos:
            return "skip", 0.60, f"Частичное согласие с перевесом скептицизма"
        return "trade", 0.65, "Частичное согласие — торгуем осторожно"

    # Скептик не согласен
    obs_pos, obs_neg = _count_sentiment(obs_a)
    if obs_pos > obs_neg:
        return "trade", 0.55, "Скептик против, но Альфа уверена"
    return "skip", 0.70, "Скептик против, Альфа неубедительна"


# ── Главная функция ───────────────────────────────────────────────────────────

async def consult_signal(
    ticker: str,
    direction: str,          # "long" | "short"
    snapshot: dict,          # из strategy.last_snapshot()
    analytics_text: str = "",
    timeout: float = 30.0,
) -> dict:
    """
    Запускает консилиум.
    Возвращает dict: {verdict, confidence, reason, observer, skeptic}.
    verdict: "trade" | "skip"

    При недоступности Cerebras или таймауте — возвращает "trade" (advisory, не блокирует).
    """
    if not CEREBRAS_API_KEY:
        return _no_council("Cerebras не настроен")

    lessons = _load_lessons()
    lessons_text = _format_lessons(lessons, ticker)

    composite = snapshot.get("composite", 0.0)
    scores_str = json.dumps(
        {k: round(v, 3) for k, v in snapshot.get("scores", {}).items()},
        ensure_ascii=False
    )
    snapshot_text = (
        f"Тикер: {ticker}\n"
        f"Направление сигнала: {direction.upper()}\n"
        f"Режим рынка: {snapshot.get('regime', '?')}\n"
        f"Дневной режим: {snapshot.get('daily_regime', '?')}\n"
        f"Композит: {composite:.3f}\n"
        f"Волатильность (ATR%): {snapshot.get('atr_pct', 0):.3f}\n"
        f"Уверенность режима: {snapshot.get('regime_confidence', 0):.2f}\n"
        f"Качество стратегии: {snapshot.get('rolling_quality', 0):.3f}\n"
        f"Методы (scores): {scores_str}\n"
        f"Нарратив: {snapshot.get('narrative_state', '?')}\n"
    )
    if analytics_text:
        snapshot_text += f"\nСтатистика по тикеру из архива:\n{analytics_text}"

    loop = asyncio.get_event_loop()
    obs_a = skeptic_b = moderator = None

    try:
        async with asyncio.timeout(timeout):
            # Раунд 1: Альфа строит тезис
            obs_a = await loop.run_in_executor(
                None, _cerebras_call,
                _observer_system(lessons_text),
                snapshot_text,
                450,
            )

            # Раунд 1: Бета оценивает
            skeptic_prompt = (
                f"Данные сигнала:\n{snapshot_text}\n\n"
                f"Агент Альфа говорит:\n{obs_a}\n\n"
                "Твоя оценка?"
            )
            skeptic_b = await loop.run_in_executor(
                None, _cerebras_call,
                _skeptic_system(lessons_text),
                skeptic_prompt,
                300,
            )

            agreement = _parse_skeptic(skeptic_b)

            # Если спор — зовём модератора
            if agreement == "disagree":
                mod_prompt = (
                    f"Данные сигнала:\n{snapshot_text}\n\n"
                    f"Альфа: {obs_a}\n\n"
                    f"Бета: {skeptic_b}\n\n"
                    "Вынеси решение."
                )
                moderator = await loop.run_in_executor(
                    None, _cerebras_call,
                    _moderator_system(),
                    mod_prompt,
                    200,
                )

    except TimeoutError:
        logger.warning(f"council: timeout {timeout}s для {ticker} — торгуем без совета")
        return _no_council(f"таймаут {timeout}s")
    except Exception as e:
        logger.error(f"council: ошибка: {e}")
        return _no_council(str(e))

    # Вердикт
    verdict, confidence, reason = _derive_verdict(obs_a, skeptic_b, moderator)

    # Сохраняем урок
    lesson_entry = {
        "id": str(uuid.uuid4())[:8],
        "ts": datetime.now().isoformat(),
        "ticker": ticker,
        "direction": direction,
        "regime": snapshot.get("regime", "?"),
        "verdict": verdict,
        "lesson": (
            f"Альфа: {(obs_a or '')[:180]} | "
            f"Бета: {(skeptic_b or '')[:120]} → {verdict}"
        ),
    }
    if moderator:
        lesson_entry["lesson"] += f" | Модератор: {moderator[:100]}"

    _save_lesson(lesson_entry)

    logger.info(
        f"council [{ticker} {direction}]: {verdict} "
        f"conf={confidence:.2f} | {reason}"
    )

    return {
        "verdict": verdict,
        "confidence": confidence,
        "reason": reason,
        "observer": obs_a or "",
        "skeptic": skeptic_b or "",
        "moderator": moderator or "",
        "calls_used": 3 if moderator else 2,
    }


def _no_council(reason: str) -> dict:
    return {
        "verdict": "trade",
        "confidence": 0.5,
        "reason": reason,
        "observer": "",
        "skeptic": "",
        "moderator": "",
        "calls_used": 0,
    }
