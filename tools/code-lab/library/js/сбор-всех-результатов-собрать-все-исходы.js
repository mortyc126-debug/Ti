Promise.allSettled([Promise.resolve(5), Promise.reject(new Error("сбой"))])
  .then(results => console.log(results.map(x => x.status)));
