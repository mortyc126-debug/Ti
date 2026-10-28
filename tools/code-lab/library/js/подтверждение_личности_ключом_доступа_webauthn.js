const вызов = new Uint8Array(await (await fetch("/api/вход/вызов")).arrayBuffer());

const publicKey = {
  challenge: вызов,
  rpId: location.hostname,
  userVerification: "preferred",
  timeout: 60000,
};

const подтверждение = await navigator.credentials.get({ publicKey });
console.log(подтверждение.id);
