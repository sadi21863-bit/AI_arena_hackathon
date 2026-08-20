let count = 0;
const btn = document.getElementById('counter');
if (btn) {
  btn.addEventListener('click', () => {
    count++;
    btn.textContent = `Clicked ${count} times`;
  });
}
