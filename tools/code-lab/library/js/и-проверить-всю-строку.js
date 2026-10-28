const код = /^ID-\d{3}$/;
console.log(код.test("ID-123"));
console.log(код.test("xID-123"));
