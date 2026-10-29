let left = 10;
const countdownId = setInterval(() => {
  left--;
  document.querySelector('#counter').textContent = left;
  if (left <= 0) clearInterval(countdownId);
}, 1000);