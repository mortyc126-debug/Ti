function график(значения){
  const точки = значения
    .map((y, x) => (x * 20) + "," + (100 - y))
    .join(" ");
  return '<svg width="200" height="100">'
    + '<polyline points="' + точки + '" fill="none" stroke="#52F2C9"/>'
    + '</svg>';
}