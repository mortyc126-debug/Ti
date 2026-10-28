const вызов = new Uint8Array(await (await fetch("/api/регистрация/вызов")).arrayBuffer());

const publicKey = {
  challenge: вызов,
  rp: { name: "Пример" },
  user: { id: new Uint8Array(16), name: "mira@example.com", displayName: "Мира" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { userVerification: "preferred" },
};

const учётка = await navigator.credentials.create({ publicKey });
console.log(учётка.id);
