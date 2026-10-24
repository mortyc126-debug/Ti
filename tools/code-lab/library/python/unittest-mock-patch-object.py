from unittest.mock import patch

class PriceService:
    def latest(self, symbol):
        raise RuntimeError("real service should not be called in this test")

service = PriceService()
with patch.object(service, "latest", return_value=123.4) as mocked:
    assert service.latest("SBER") == 123.4
    mocked.assert_called_once_with("SBER")
print("mock verified")
