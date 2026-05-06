import { start } from './runtime/index.js';
import { SearchInfosElement } from './elements/search.infos.js';
import { definedProjects } from './projects/index.js';

if (!customElements.get('search-infos')) {
  customElements.define('search-infos', SearchInfosElement);
}

start(definedProjects()).catch((err) => {
  console.error('[chaoxing-plus] startup failed', err);
});
