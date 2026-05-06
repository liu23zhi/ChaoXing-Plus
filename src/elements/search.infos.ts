export class SearchInfosElement extends HTMLElement {
  infos: Array<{ name: string; homepage: string; results: Array<[string, string, Record<string, unknown>]>; error?: string }> = [];
  question = '';

  connectedCallback(): void {
    this.innerHTML = `
      <div class="search-info-title">${this.question || '无题目'}</div>
      ${this.infos.map((info) => `
        <details open>
          <summary><a href="${info.homepage}" target="_blank">${info.name}</a></summary>
          ${info.error ? `<div class="error">${info.error}</div>` : ''}
          ${(info.results || []).map((item) => `<div><strong>答案：</strong><code>${item[1]}</code></div>`).join('')}
        </details>
      `).join('')}
    `;
  }
}
