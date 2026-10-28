const location = { // вместо настоящего window.location
  replace(url) { console.log("переход без записи в историю:", url); }
};
const url = "https://example.com/новая-страница";
location.replace(url);
