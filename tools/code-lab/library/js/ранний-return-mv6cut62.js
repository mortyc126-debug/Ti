function getDiscount(price) {
  if (price <= 0) {
    return 0;
  }

  return price * 0.1;
}

console.log(getDiscount(200));