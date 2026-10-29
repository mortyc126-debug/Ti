document.querySelector('#stop').addEventListener('click', () => {
  clearInterval(intervalId);
  clearTimeout(timerId);
});