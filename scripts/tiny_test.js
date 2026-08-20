process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
const { chromium } = require('playwright');
const { spawn } = require('child_process');

(async () => {
  // Start static server
  const server = spawn('python3', ['-m', 'http.server', '8000', '--directory', 'public'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  // Wait a moment for server to start
  await new Promise((r) => setTimeout(r, 2000));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8000/tiny.html');
  const button = await page.$('button#counter');
  if (!button) {
    console.error('Button not found');
    process.exit(1);
  }
  const before = await button.textContent();
  await button.click();
  const after = await button.textContent();
  if (before === after) {
    console.error('Button click did not change text');
    process.exit(1);
  }
  console.log('Test passed');
  await browser.close();
  server.kill();
})();
