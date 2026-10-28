const первый = await Promise.any([Promise.reject("A"), Promise.resolve("B"), Promise.resolve("C")]);
console.log(первый);
