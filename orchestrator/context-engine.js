/**
 * Context Engine — TF-IDF 기반 레포지토리 검색 — v5.0
 * 순수 Node.js, 외부 벡터 DB 불필요
 * RULE 4: Workers must retrieve context before coding.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const { indexRepository, loadIndex } = require('./repo-indexer');

function searchContext(query, projectRoot, opts = {}) {
  const topN = opts.topN || 5;
  let index = loadIndex(projectRoot);
  if (!index || isStale(index)) index = indexRepository(projectRoot);

  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = scoreFiles(index, terms, projectRoot);
  logger.log({ stage: 'context-engine', data: { query: query.slice(0, 100), results: Math.min(topN, scored.length) } });
  return scored.slice(0, topN);
}

function buildContextString(query, projectRoot, maxChars = 2000) {
  const results = searchContext(query, projectRoot, { topN: 5 });
  if (results.length === 0) return '';
  const parts = results.map(r => `### ${r.path}\nexports: ${(r.exports||[]).join(', ')}\n${r.preview||''}`);
  return `## 관련 레포지토리 컨텍스트:\n${parts.join('\n\n')}`.slice(0, maxChars);
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

function scoreFiles(index, queryTerms, projectRoot) {
  const files  = index.files.filter(f => !f.skipped && ['.js','.ts','.jsx','.tsx','.md'].includes(f.ext));
  const scored = [];
  for (const file of files) {
    const text   = getFileText(file, projectRoot);
    const tokens = tokenize(text);
    const tf     = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const term of queryTerms) {
      score += (tf[term] || 0) / (tokens.length || 1);
      if (file.path.toLowerCase().includes(term)) score += 0.5;
      if ((index.exports[file.path]||[]).join(' ').toLowerCase().includes(term)) score += 0.3;
    }
    if (score > 0) scored.push({ path: file.path, score: Math.round(score * 1000) / 1000, exports: index.exports[file.path] || [], preview: file.preview || '' });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function getFileText(file, projectRoot) {
  if (file.preview) return file.preview;
  try { return fs.readFileSync(path.join(projectRoot, file.path), 'utf8').slice(0, 2000); } catch { return ''; }
}

function isStale(index) {
  if (!index?.ts) return true;
  return Date.now() - new Date(index.ts).getTime() > 30 * 60 * 1000;
}

module.exports = { searchContext, buildContextString };
