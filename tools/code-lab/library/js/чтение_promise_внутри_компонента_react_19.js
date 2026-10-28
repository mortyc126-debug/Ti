import { use, Suspense } from "react";

const обещание = fetch("/api/профиль").then(ответ => ответ.json());

function Профиль() {
  const профиль = use(обещание);
  return <p>{профиль.имя}</p>;
}

function Страница() {
  return (
    <Suspense fallback={<p>Загрузка…</p>}>
      <Профиль />
    </Suspense>
  );
}
