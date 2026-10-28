const navigation = { // вместо настоящего Navigation API
  navigate(url) { console.log("переход на", url); }
};
const url = "https://example.com/catalog";
if (navigation) navigation.navigate(url);
