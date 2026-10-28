const base = { type: "животное" };
const pet = Object.create(base);
pet.name = "Барсик";

for (const key in pet) {
  console.log(key, Object.hasOwn(pet, key) ? "(собственное)" : "(унаследованное)");
}
