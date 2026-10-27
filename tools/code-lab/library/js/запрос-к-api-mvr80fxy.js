async function получитьДанные() {
  const ответ = await fetch("/api/профиль");
  if (!ответ.ok) throw new Error(`HTTP ${ответ.status}`);
  return ответ.json();
}