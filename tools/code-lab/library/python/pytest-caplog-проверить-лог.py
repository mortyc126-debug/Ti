import logging

def parse_amount(raw: str) -> float:
    try:
        return float(raw)
    except ValueError:
        logging.getLogger(__name__).warning("Некорректная сумма")
        raise

def test_invalid_amount_logs_warning(caplog):
    with caplog.at_level(logging.WARNING):
        try:
            parse_amount("abc")
        except ValueError:
            pass
    assert "Некорректная сумма" in caplog.text
