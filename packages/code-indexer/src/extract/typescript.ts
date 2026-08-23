import type { LanguageExtractor } from './types.js';

// Stub — replaced by Task 4's real TypeScript/JavaScript extractor.
export const tsExtractor: LanguageExtractor = {
  lang: 'typescript',
  extract: () => ({ symbols: [], imports: [], calls: [], inherits: [] }),
};
