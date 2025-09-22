const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const https = require("https");

// Base URLs
const BASE_URL = "https://moe.mohkg1017.pro/";
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";

// Folder to download IPAs
const IPA_DIR = path.resolve(__dirname, "ipas");

// Max simultaneous downloads
const MAX_PARALLEL = 3;

// Max retries per download
const MAX_RETRIES = 3;

// Convert size string to bytes
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

// Decode HTML entities in URL
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g, "&");
}

// Extract Google Drive direct download link
function googleDriveDirectLink(url) {
  if (!url) return url;
  url = decodeHtmlEntities(url);

  // Handle /file/d/ID or ?id=ID formats
  const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)|[?&]id=([a-zA-Z0-9_-]+)/);
  const fileId = fileIdMatch?.[1] || fileIdMatch?.[2];
  if (!fileId) return url;

  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Download file with retries and Google Drive handling
async function downloadFile(url, targetPath) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(targetPath);

        https.get(url, (res) => {
          // Google Drive large file confirmation page
          if (res.statusCode === 200 && res.headers["content-type"]?.includes("text/html")) {
            let body = "";
            res.on("data", chunk => body += chunk.toString());
            res.on("end", () => {
              const confirmMatch = body.match(/confirm=([0-9A-Za-z_]+)&amp;id=/);
              if (confirmMatch) {
                const confirmToken = confirmMatch[1];
                const newUrl = url.replace("export=download", `export=download&confirm=${confirmToken}`);
                console.log("Detected Google Drive confirmation, retrying with confirm token...");
                resolve(downloadFile(newUrl, targetPath));
              } else if (body.includes("quota exceeded")) {
                reject(new Error("Google Drive requires manual confirmation or quota exceeded"));
              } else {
                reject(new Error(`Unexpected HTML response for ${url}`));
              }
            });
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          res.pipe(file);
          file.on("finish", () => {
            file.close(resolve);
          });
        }).on("error", (err) => {
          fs.unlink(targetPath, () => {});
          reject(err);
        });
      });

      return; // success
    } catch (err) {
      console.warn(`Retrying download for ${url} (${attempt}/${MAX_RETRIES})`);
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

// Utility to run promises in parallel with limit
async function parallelLimit(items, limit, fn) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const p = fn(item);
    results.push(p);

    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing).catch(() => {});
      executing.splice(executing.findIndex(e => e === p), 1);
    }
  }

  return Promise.all(results);
}

async function scrape() {
  try {
    if (!fs.existsSync(IPA_DIR)) fs.mkdirSync(IPA_DIR, { recursive: true });

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

      return {
        name, bundleIdentifier, version, versionDate,
        iconURL, description, downloadURL, ipaPath, ghDownloadURL, size
      };
    });

    const apps = [];
    const failedDownloads = [];

    await parallelLimit(appsToDownload, MAX_PARALLEL, async (app) => {
      try {
        console.log(`Downloading ${app.name}...`);
        await downloadFile(app.downloadURL, app.ipaPath);
        console.log(`✅ Downloaded ${app.name}`);

        apps.push({
          name: app.name,
          bundleIdentifier: app.bundleIdentifier,
          developerName: "Unknown",
          version: app.version,
          versionDate: app.versionDate,
          localizedDescription: app.description,
          iconURL: app.iconURL,
          downloadURL: app.ghDownloadURL,
          size: app.size
        });
      } catch (err) {
        console.warn(`❌ Failed to download ${app.name}: ${err.message}`);
        failedDownloads.push({ name: app.name, url: app.downloadURL });
      }
    });

    fs.writeFileSync("repo.feather.json", JSON.stringify({ name: "Moes IPA Mirror", identifier: "com.dwojc6.moesipamirror", apps }, null, 2));

    if (failedDownloads.length > 0) {
      fs.writeFileSync("failedDownloads.json", JSON.stringify(failedDownloads, null, 2));
      console.log(`⚠️ Some downloads failed. See failedDownloads.json`);
    }

    console.log(`✅ repo.feather.json generated with ${apps.length} apps`);
  } catch (err) {
    console.error("❌ Error scraping site:", err);
    process.exit(1);
  }
}

scrape();
