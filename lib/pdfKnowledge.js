const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const PDF_DIR = path.join(__dirname, '..', 'knowledge', 'faqs'); // uploaded PDFs land here
const TEXT_CACHE_DIR = path.join(__dirname, '..', 'knowledge', 'cache', 'faqs');
const MAX_CHARS_PER_DOC = 8000;

// Parses one PDF buffer to text and caches it as .txt next to a matching name.
async function parseAndCachePdf(pdfBuffer, originalName) {
  const { text } = await pdfParse(pdfBuffer);
  const clean = text.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS_PER_DOC);

  fs.mkdirSync(TEXT_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(TEXT_CACHE_DIR, `${originalName}.txt`);
  fs.writeFileSync(cacheFile, clean, 'utf8');
  return clean;
}

// Loads every cached FAQ text file into one combined block.
function loadAllFaqKnowledge() {
  if (!fs.existsSync(TEXT_CACHE_DIR)) return '';
  const files = fs.readdirSync(TEXT_CACHE_DIR).filter((f) => f.endsWith('.txt'));
  return files
    .map((f) => {
      const content = fs.readFileSync(path.join(TEXT_CACHE_DIR, f), 'utf8');
      return `### FAQ document: ${f.replace('.txt', '')}\n${content}`;
    })
    .join('\n\n---\n\n');
}

// Re-parses every PDF currently sitting in knowledge/faqs/ (useful if you
// drop files in manually via FTP/SCP rather than the upload endpoint).
async function reparseAllPdfs() {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const files = fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(PDF_DIR, file));
    await parseAndCachePdf(buffer, file);
    console.log(`Parsed FAQ PDF: ${file}`);
  }
  return loadAllFaqKnowledge();
}

module.exports = { parseAndCachePdf, loadAllFaqKnowledge, reparseAllPdfs, PDF_DIR };
