import unittest

class TestExample(unittest.TestCase):
    def setUp(self):
        self.items = [1, 2, 3]

    def tearDown(self):
        self.items = None

    def test_len(self):
        self.assertEqual(len(self.items), 3)

if __name__ == "__main__":
    unittest.main()
