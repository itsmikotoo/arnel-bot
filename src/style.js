import { relevant } from './memory.js';
export class Style {
  constructor(store) { this.store = store; }
  count() { return (this.store.read('style_examples', { samples: [] }).samples || []).length; }
  examples(query, limit = 8) {
    const samples = this.store.read('style_examples', { samples: [] }).samples || [];
    const recent = samples.slice(-Math.ceil(limit / 2));
    const matched = relevant(samples.filter(x => !recent.includes(x)), query, Math.floor(limit / 2));
    return [...matched, ...recent].slice(-limit);
  }
}
