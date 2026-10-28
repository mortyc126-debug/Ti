const команда = {
  участники: ["Мира", "Лев", "Анна"],
  *[Symbol.iterator]() {
    for (const участник of this.участники) {
      yield участник;
    }
  },
};

for (const имя of команда) {
  console.log(имя);
}
