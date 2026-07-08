"""ssl_setup.py — единый CA-бандл (certifi) для всего HTTPS в процессе.

На Windows системное хранилище сертификатов часто не даёт Python найти issuer
(SSL: CERTIFICATE_VERIFY_FAILED, 'unable to get local issuer certificate') для
api.telegram.org / iss.moex.com / apim.moex.com. certifi несёт актуальный бандл.

Две задачи:
  1. Поставить certifi как ДЕФОЛТ процесса через переменные окружения ДО создания
     любых SSL-контекстов — так его подхватят aiohttp/aiogram (Telegram) и любой
     ssl.create_default_context() без явного cafile. Поэтому этот модуль надо
     импортировать ПЕРВЫМ в точках входа (main.py, dashboard.py).
  2. Дать общий ssl_context() для голых urllib.urlopen (mega_alerts/news/
     tradestats/db_api_client), которые раньше шли без CA и падали.

certifi может быть не установлен — тогда мягкий откат на системный контекст
(поведение как раньше, без падения импорта).
"""
import os
import ssl

_CTX: ssl.SSLContext | None = None


def _certifi_where() -> str | None:
    try:
        import certifi
        return certifi.where()
    except Exception:
        return None


# Дефолт процесса: OpenSSL читает SSL_CERT_FILE при create_default_context().
# setdefault — не затираем явную настройку пользователя, если он её задал.
_ca = _certifi_where()
if _ca:
    os.environ.setdefault("SSL_CERT_FILE", _ca)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _ca)


def ssl_context() -> ssl.SSLContext:
    """Общий SSL-контекст с certifi CA (fallback на системный)."""
    global _CTX
    if _CTX is None:
        ca = _certifi_where()
        _CTX = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    return _CTX
