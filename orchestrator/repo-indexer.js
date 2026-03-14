/**
 * Repository Indexer — v5.0
 * 프로젝트를 스캔하여 파일 구조, export, import를 색인합니다.
 * RULE 4: Full Repository Context Awareness
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const IGNORE_DIRS   = new Set(['node_modules', '.git', '.agents', 'dist', 'build', '.next', 'coverage', '.agent-backup', 'tmp']);
const SUPPORTED_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.json', '.md']);

function indexRepository(projectRoot, opts = {}) {
  const timer = logger.stage('repo-indexer');
  const index = { root: projectRoot, ts: new Date().toISOString(), files: [], exports: {}, imports: {}, structure: {} };
  walkDir(projectRoot, projectRoot, index);
  if (opts.save !== false) {
    const out = path.join(projectRoot, '.agents', 'repo-index.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(index, null, 2), 'utf8');
  }
  timer.done({ data: { files: index.files.length } });
  return index;
}

function walkDir(rootDir, currentDir, index) {
  let entries;
  try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
  const relDir = path.relative(rootDir, currentDir) || '.';
  index.structure[relDir] = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(currentDir, entry.name);
    const relPath  = path.relative(rootDir, fullPath);
    if (entry.isDirectory()) { index.structure[relDir].push(`${entry.name}/`); walkDir(rootDir, fullPath, index); }
    else if (entry.isFile() && SUPPORTED_EXTS.has(path.extname(entry.name))) { index.structure[relDir].push(entry.name); indexFile(fullPath, relPath, index); }
  }
}

function indexFile(fullPath, relPath, index) {
  let content = '', size = 0;
  try { size = fs.statSync(fullPath).size; if (size > 500*1024) { index.files.push({ path: relPath, size, skipped: true }); return; } content = fs.readFileSync(fullPath, 'utf8'); } catch { return; }
  const ext  = path.extname(fullPath);
  const file = { path: relPath, size, ext };
  if (['.js','.ts','.jsx','.tsx'].includes(ext)) {
    file.exports = extractExports(content);
    file.imports = extractImports(content);
    file.preview = content.split('\n').slice(0, 5).join('\n');
    index.exports[relPath] = file.exports;
    index.imports[relPath] = file.imports;
  }
  index.files.push(file);
}

function extractExports(content) {
  const exps = [];
  for (const p of [/export\s+(?:default\s+)?(?:class|function|const|let|var|async function)\s+(\w+)/g, /exports\.(\w+)\s*=/g]) {
    let m; while ((m = p.exec(content)) !== null) { if (m[1] && !exps.includes(m[1])) exps.push(m[1]); }
  }
  return exps;
}

function extractImports(content) {
  const imps = [];
  for (const p of [/require\(['"]([^'"]+)['"]\)/g, /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g]) {
    let m; while ((m = p.exec(content)) !== null) { if (m[1] && !imps.includes(m[1])) imps.push(m[1]); }
  }
  return imps;
}

function loadIndex(projectRoot) {
  const p = path.join(projectRoot, '.agents', 'repo-index.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

module.exports = { indexRepository, loadIndex };
