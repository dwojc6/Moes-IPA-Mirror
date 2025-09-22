// scrape.js (CommonJS)
const cheerio = require('cheerio');
const fs = require('fs/promises');

const BASE = 'https://moe.mohkg1017.pro';
const OUT_FILE = 'repo.feather.json';

function cleanHref(href) {
  if (!href) return '';
  // convert &amp; to &, unescape common HTML entities
  return href.replace(/&amp;/g, '&').trim();
}

async function fetchHTML(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'github-actions/moe-scraper' } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function scrape() {
  console.log('Fetching', BASE);
  const html = await fetchHTML(BASE);
  const $ = cheerio.load(html);

  const apps = [];

  $('.app-card').each((i, el) => {
    const $el = $(el);
    // prefer data-name if present
    const name = ($el.attr('data-name') || $el.find('h3').text() || '').trim();
    const description = ($el.find('.app-description').text() || '').trim();
    const versionText = ($el.find('.app-meta-row span').first().text() || '').trim();
    const version = versionText.replace(/^v/i, '').trim();
    let icon = $el.find('.app-icon img').attr('src') || '';
    if (icon && icon.startsWith('/')) icon = BASE + icon;
    const downloadAnchor = $el.find('a').filter((i, a) => $(a).text().toLowerCase().includes('download')).first();
    const downloadURL = cleanHref(downloadAnchor.attr('href') || '');

    // Ensure absolute URLs for Drive links and fix relative ones
    let finalDownload = downloadURL;
    if (finalDownload && finalDownload.startsWith('/')) finalDownload = BASE + finalDownload;

    if (name && finalDownload) {
      apps.push({
        name,
        description,
        version: version || '',
        icon: icon || '',
        downloadURL: finalDownload
      });
    }
  });

  // optional: dedupe by downloadURL
  const seen = new Set();
  const uniqueApps = apps.filter(a => {
    if (seen.has(a.downloadURL)) return false;
    seen.add(a.downloadURL);
    return true;
  });

  // sort by name
  uniqueApps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const repo = {
    name: "Moe Mirror Repo",
    updated: new Date().toISOString(),
    apps: uniqueApps
  };

  const out = JSON.stringify(repo, null, 2);
  await fs.writeFile(OUT_FILE, out, 'utf8');
  console.log(`Wrote ${OUT_FILE} with ${uniqueApps.length} apps`);
}

scrape().catch(err => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
