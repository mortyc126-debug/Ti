function gradeName(score) {
  switch (true) {
    case score >= 90:
      return "отлично";
    case score >= 70:
      return "хорошо";
    case score >= 50:
      return "удовлетворительно";
    default:
      return "неудовлетворительно";
  }
}

console.log(gradeName(95), gradeName(72), gradeName(30));
