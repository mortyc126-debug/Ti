(() => {
  const STORAGE_KEY = 'codeLab.mistralApiKey';
  const modal = document.getElementById('keyModal');
  const input = document.getElementById('mistralKeyInput');
  const status = document.getElementById('mistralKeyStatus');
  if (!modal || !input) return;
  const readKey = () => { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (_) { return ''; } };
  const open = () => { input.value = readKey(); status.textContent = input.value ? 'Ключ сохранён в этом браузере.' : 'Ключ не задан.'; modal.classList.add('open'); input.focus(); };
  const close = () => modal.classList.remove('open');
  document.getElementById('labSettingsBtn')?.addEventListener('click', open);
  document.getElementById('cancelMistralKey')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });
  document.getElementById('saveMistralKey')?.addEventListener('click', () => {
    const key = input.value.trim();
    try {
      if (key) localStorage.setItem(STORAGE_KEY, key); else localStorage.removeItem(STORAGE_KEY);
      status.textContent = key ? 'Ключ сохранён. Его можно заменить в любой момент.' : 'Ключ удалён.';
      setTimeout(close, 650);
    } catch (_) { status.textContent = 'Браузер не разрешил сохранить ключ. Проверьте настройки приватности.'; }
  });
  document.getElementById('clearMistralKey')?.addEventListener('click', () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    input.value = ''; status.textContent = 'Ключ удалён из локального хранилища браузера.';
  });
  // Доступен другим функциям лаборатории, но ключ не добавляется к обычным запросам.
  window.codeLabMistralKey = readKey;
})();
