const fetch = require('node-fetch');
const { convert } = require('html-to-text');
const fs = require('fs');
const path = require('path');
const sources = require('../config/sources');

const CACHE_PATH = path.join(__dirname, '..', 'knowledge', 'cache', 'website.txt');
const MAX_CHARS_PER_PAGE = 6000; // keep any one page from dominating the context

async function fetchAndCachePage(url) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const html = await res.text();

  const text = convert(html, {
    selectors: [
      { selector: 'nav', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'img', format: 'skip' },
    ],
    wordwrap: false,
  })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.slice(0, MAX_CHARS_PER_PAGE);
}

async function refreshWebsiteKnowledge() {
  const results = [];
  for (const url of sources) {
    try {
      const text = await fetchAndCachePage(url);
      results.push(`### Source: ${url}\n${text}`);
      console.log(`Fetched ${url} (${text.length} chars)`);
    } catch (err) {
      console.error(`Failed to fetch ${url}:`, err.message);
      // Don't let one broken page kill the whole refresh
    }
  }

  const combined = results.join('\n\n---\n\n');
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, combined, 'utf8');
  return combined;
}

function loadCachedWebsiteKnowledge() {
  try {
    return fs.readFileSync(CACHE_PATH, 'utf8');
  } catch {
    return ''; // no cache yet - fine, just means empty until first refresh
  }
}

module.exports = { refreshWebsiteKnowledge, loadCachedWebsiteKnowledge };
