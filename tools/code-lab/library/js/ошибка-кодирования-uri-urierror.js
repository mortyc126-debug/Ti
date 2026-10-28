function decodeSlug(slug) {
  if (slug.includes("\u0000")) {
    throw new URIError("Нулевой символ в адресе недопустим");
  }
  return decodeURIComponent(slug);
}

console.log(decodeSlug("%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82"));

for (const slug of ["%E0%A4%A", "a\u0000b"]) {
  try {
    decodeSlug(slug);
  } catch (error) {
    console.log(error.name);
  }
}
