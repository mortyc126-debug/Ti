import { createElement, useEffect, useState } from "react";

export default function UserCard({ userId }) {
  const [user, setUser] = useState(null);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/users/${userId}`, { signal: controller.signal })
      .then(response => response.json())
      .then(setUser)
      .catch(error => {
        if (error.name !== "AbortError") setErrorText(error.message);
      });

    return () => controller.abort();
  }, [userId]);

  if (errorText) return createElement("p", null, `Ошибка: ${errorText}`);
  if (!user) return createElement("p", null, "Загрузка…");
  return createElement("h2", null, user.name);
}
