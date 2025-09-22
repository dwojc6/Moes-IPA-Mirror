const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const axios = require("axios");

// --- CONFIG ---
const BASE_URL = "https://moe.mohkg1017.pro/";
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";
const IPA_DIR = path.resolve(__dirname, "ipas");
const MAX_PARALLEL = 5; // concurrency
const FAILED_LOG = path.resolve(__dirname, "failedDownloads.json");

// --- UTILS ---
function sizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.trim().match(/([\d.]+)\s*(MB|GB|KB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  switch (unit) {
    case "GB": return Math.round(value * 1024 * 1024 * 1024);
    case "MB": return Math.round(value * 1024 * 1024);
    case "KB": return Math.round(value * 1024);
    default: return 0;
  }
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g, "&");
}

function googleDriveDirectLink(url) {
  if (!url) return url;
  url = decodeHtmlEntities(url);
  const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)|[?&]id=([a-zA-Z0-9_-]+)/);
  const fileId = fileIdMatch?.[1] || fileIdMatch?.[2];
  if (!fileId) return url;
  return `https://drive.google.com/uc?id=${fileId}`;
}

// --- GDOWN DOWNLOAD ---
async function downloadWithGdown(url, targetPath) {
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    console.log(`Skipping already downloaded: ${path.basename(targetPath)}`);
    return;
  }

  try {
    console.log(`Downloading ${path.basename(targetPath)} via gdown...`);
    await execFileAsync("npx", ["gdown", url, "-O", targetPath]);
    console.log(`✅ Downloaded ${path.basename(targetPath)}`);
  } catch (err) {
    console.warn(`❌ Failed to download ${path.basename(targetPath)}: ${err.message}`);
    throw err;
  }
}

// --- PARALLEL LIMIT ---
async function parallelLimit(items, limit, fn) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const p = fn(item).catch(err => ({ error: err, item }));
    results.push(p);
    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
      executing.splice(executing.findIndex(e => e === p), 1);
    }
  }

  return Promise.all(results);
}

// --- MAIN SCRAPER ---
async function scrape() {
  try {
    if (!fs.existsSync(IPA_DIR)) fs.mkdirSync(IPA_DIR, { recursive: true });
    let failedDownloads = [];

    // Fetch Moe site
    const { data: html } = await axios.get(BASE_URL);
    const $ = cheerio.load(html);

    // Fetch Feather repo lookup
    const { data: featherRepo } = await axios.get(LOOKUP_URL);
    const lookupMap = {};
    for (const app of featherRepo.apps) {
      lookupMap[app.name.toLowerCase()] = {
        bundleIdentifier: app.bundleIdentifier,
        iconURL: app.iconURL
      };
    }

    const appCards = $(".app-card").toArray();
    const appsToDownload = appCards.map(el => {
      const name = $(el).data("name")?.toString().trim() || "Unknown App";
      const versionDate = $(el).data("updated")?.toString().trim() || new Date().toISOString().split("T")[0];
      const metaSpans = $(el).find(".app-meta-row span");
      const version = metaSpans.eq(0).text().trim().replace(/^v/i, "") || "0.0.0";
      const sizeStr = metaSpans.eq(1).text().trim() || "";
      const size = sizeToBytes(sizeStr);

      let downloadURL = $(el).find(".app-actions a.app-action.primary").attr("href") || "";
      downloadURL = googleDriveDirectLink(downloadURL);

      const lookup = lookupMap[name.toLowerCase()] || {};
      const bundleIdentifier = lookup.bundleIdentifier || `com.moes.${name.toLowerCase().replace(/[^a-z0-9]/gi, "")}`;
      const iconURL = lookup.iconURL || `${BASE_URL}${$(el).find(".app-icon img").attr("src")?.replace(/^\//, "") || "placeholder.png"}`;
      const description = $(el).find(".app-description").text().trim() || "No description provided.";

      const safeName = name.replace(/[^a-z0-9\-_.]/gi, "_");
      const ipaPath = path.join(IPA_DIR, `${safeName}.ipa`);
      const ghDownloadURL = `https://github.com/dwojc6/Moes-IPA-Mirror/releases/download/latest/${safeName}.ipa`;

      return { name, bundleIdentifier, version, versionDate, iconURL, description, downloadURL, ipaPath, ghDownloadURL, size };
    });

    // Download all IPAs first
    await parallelLimit(appsToDownload, MAX_PARALLEL, async (app) => {
      try {
        await downloadWithGdown(app.downloadURL, app.ipaPath);
      } catch {
        failedDownloads.push({ name: app.name, url: app.downloadURL });
      }
    });

    // Generate JSON after downloads
    const apps = appsToDownload
      .filter(app => fs.existsSync(app.ipaPath))
      .map(app => ({
        name: app.name,
        bundleIdentifier: app.bundleIdentifier,
        developerName: "Unknown",
        version: app.version,
        versionDate: app.versionDate,
        localizedDescription: app.description,
        iconURL: app.iconURL,
        downloadURL: app.ghDownloadURL,
        size: app.size
      }));

    fs.writeFileSync("repo.feather.json", JSON.stringify({ name: "Moes IPA Mirror", identifier: "com.dwojc6.moesipamirror", apps }, null, 2));

    if (failedDownloads.length > 0) {
      fs.writeFileSync(FAILED_LOG, JSON.stringify(failedDownloads, null, 2));
      console.log(`⚠️ Some downloads failed. See ${FAILED_LOG}`);
    }

    console.log(`✅ repo.feather.json generated with ${apps.length} apps`);
  } catch (err) {
    console.error("❌ Error scraping site:", err);
    process.exit(1);
  }
}

scrape();
