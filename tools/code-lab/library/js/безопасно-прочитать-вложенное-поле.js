const ответ = { data: { user: null } };
const имя = ответ.data?.user?.name ?? "неизвестно";
console.log(имя);
