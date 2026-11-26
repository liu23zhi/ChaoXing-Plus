// Static owned fixture under the manifest's target origin. Chrome resolves no
// remote hosts and CDP supplies only this local HTML; no website or API is used.
export const diagnosticPageURL = 'https://fixture.chaoxing.com/owned-diagnostic-page';
export const diagnosticBrowserArgs = [
  '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
];
export async function openDiagnosticPage(browser) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() === diagnosticPageURL && request.isNavigationRequest()) {
      void request.respond({
        status: 200, contentType: 'text/html',
        headers: { 'Content-Security-Policy': "default-src 'none'" },
        body: '<!doctype html><title>Owned diagnostic page</title><p>No third-party content.</p>',
      }).catch(() => {});
    } else {
      void request.abort().catch(() => {});
    }
  });
  await page.goto(diagnosticPageURL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  return page;
}
