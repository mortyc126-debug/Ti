const доступно = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();

console.log(доступно ? "Можно войти по биометрии" : "Используем пароль");