import { start } from './runtime/index.js';
import { browserExtensionRuntime, usesBrowserAgreementGate } from './runtime/agreement-gate.js';
import { SearchInfosElement } from './elements/search.infos.js';
import { definedProjects } from './projects/index.js';

async function launch() {
  if (usesBrowserAgreementGate()) {
    const boot = (globalThis as { __CXPLUS_EXTENSION_BOOT__?: Promise<boolean> }).__CXPLUS_EXTENSION_BOOT__;
    if (!browserExtensionRuntime() || !boot || !(await boot)) return;
  } else if (!customElements.get('search-infos')) {
    customElements.define('search-infos', SearchInfosElement);
  }
  await start(definedProjects());
}

// Kept out of the disabled extension path; standalone native builds have no content-script bootstrap.
launch().catch((err) => {
  console.error('[chaoxing-plus] startup failed', err);
});
