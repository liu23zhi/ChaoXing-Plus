const homepage = 'https://www.chaoxing.com/';
const openButton = document.getElementById('open-chaoxing');

if (openButton) {
  openButton.addEventListener('click', () => {
    chrome.tabs.create({ url: homepage });
  });
}
