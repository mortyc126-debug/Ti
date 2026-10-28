async function sha256Hex(текст) {
  const байты = new TextEncoder().encode(текст);
  const хеш = await crypto.subtle.digest("SHA-256", байты);
  return [...new Uint8Array(хеш)].map(число => число.toString(16).padStart(2, "0")).join("");
}

console.log(await sha256Hex("abc"));
