class HttpError extends Error {
  constructor(ответ) {
    super(`HTTP ${ответ.status}`);
    this.name = "HttpError";
    this.status = ответ.status;
  }
}

const fetchJson = async (адрес, параметры) => {
  const ответ = await fetch(адрес, параметры);
  if (!ответ.ok) throw new HttpError(ответ);
  return ответ.json();
};

console.log(await fetchJson("data:application/json,%7B%22ok%22%3Atrue%7D"));
