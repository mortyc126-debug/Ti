# Выполнять в терминале из каталога проекта:
# python -m venv .venv
# Windows PowerShell: .venv\Scripts\python.exe -m pip install requests
# macOS/Linux: .venv/bin/python -m pip install requests
# Проверить выбранный интерпретатор:
# Windows: .venv\Scripts\python.exe -c "import sys; print(sys.executable)"
# macOS/Linux: .venv/bin/python -c "import sys; print(sys.executable)"

import sys
print("Текущий интерпретатор:", sys.executable)
