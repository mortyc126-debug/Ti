class User {
  constructor(firstName, lastName) {
    this.firstName = firstName;
    this.lastName = lastName;
  }

  get fullName() {
    return `${this.firstName} ${this.lastName}`;
  }
}

const user = new User("Мира", "Иванова");
console.log(user.fullName);

user.lastName = "Петрова";
console.log(user.fullName);
