const змеиный = "user_first_name";
const верблюжий = змеиный.replace(/_([a-z])/g, (_, буква) => буква.toUpperCase());

console.log(верблюжий);
