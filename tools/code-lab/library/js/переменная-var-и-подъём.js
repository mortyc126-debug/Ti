function showScope() {
  console.log(total);

  var total = 10;
  if (total > 5) {
    var message = "много";
  }

  console.log(message);
}

showScope();
