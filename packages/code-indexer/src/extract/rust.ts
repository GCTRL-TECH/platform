import type { LanguageExtractor } from './types.js';

// Stub — replaced by Task 5's real Rust extractor.
export const rustExtractor: LanguageExtractor = {
  lang: 'rust',
  extract: () => ({ symbols: [], imports: [], calls: [], inherits: [] }),
};
