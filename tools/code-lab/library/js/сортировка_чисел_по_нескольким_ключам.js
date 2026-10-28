const записи = [{x:2,y:1},{x:1,y:4},{x:1,y:2}];
записи.sort((a,b) => (a.x-b.x) || (a.y-b.y));
console.log(записи);
