const location = { // вместо настоящего window.location
  reload() { console.log("страница перезагружена"); }
};
location.reload();
