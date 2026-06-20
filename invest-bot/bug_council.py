"""
bug_council.py — «совет» для багов: один AI-вызов (Cerebras), который
смотрит на traceback/лог и контекст запуска, и предлагает диагноз + правку.

В отличие от Observer (многоагентный консилиум Альфа/Бета/Модератор для
торговых решений), здесь совет не принимает торговых решений — только
разбирает ошибки бэктеста, найденные на дашборде (вручную или автоматически
при сбое прогона).

При отсутствии ключа/пакета/сетевой ошибке — без AI, просто traceback и
контекст (см. analyze_bug fallback).
"""

import json
import re
import logging

from news_config import CEREBRAS_API_KEY

logger = logging.getLogger(__name__)

COUNCIL_SYSTEM = """Ты опытный Python-разработчик, разбираешь баг в торговом
боте (Tinkoff Invest API, pandas/numpy, scipy). Тебе показывают traceback и
контекст запуска (что запускали, с какими параметрами). Не предлагай
переписывать архитектуру — только конкретную причину и минимальную правку."""


def analyze_bug(traceback_text: str, context: str = "") -> dict:
    """
    Возвращает dict: {diagnosis, likely_cause, suggested_fix, used_ai}.
    Если AI недоступен — used_ai=False, остальные поля пустые
    (дашборд в этом случае просто показывает traceback/контекст как есть).
    """
    result = {"diagnosis": "", "likely_cause": "", "suggested_fix": "", "used_ai": False}

    if not CEREBRAS_API_KEY:
        return result

    try:
        from cerebras.cloud.sdk import Cerebras

        client = Cerebras(api_key=CEREBRAS_API_KEY)
        prompt = f"""Контекст запуска:
{context or "(не указан)"}

Traceback/лог:
{traceback_text[:4000]}

Ответь СТРОГО в формате JSON (без markdown, без пояснений):
{{
  "diagnosis": "одна-две фразы на русском — что произошло",
  "likely_cause": "наиболее вероятная причина (файл/функция, если можно определить)",
  "suggested_fix": "конкретная минимальная правка кода или конфига"
}}"""

        response = client.chat.completions.create(
            model="llama-3.3-70b",
            messages=[
                {"role": "system", "content": COUNCIL_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            max_tokens=400,
            temperature=0.0,
        )
        raw_text = response.choices[0].message.content.strip()
        match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if not match:
            logger.warning(f"analyze_bug: JSON не найден в ответе: {raw_text[:150]}")
            return result

        parsed = json.loads(match.group())
        result["diagnosis"] = parsed.get("diagnosis", "")
        result["likely_cause"] = parsed.get("likely_cause", "")
        result["suggested_fix"] = parsed.get("suggested_fix", "")
        result["used_ai"] = True
        return result

    except Exception as e:
        logger.error(f"analyze_bug: {e}")
        return result
