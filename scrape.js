const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const https = require("https");

// --- CONFIG ---
const BASE_URL = "https://moe.mohkg1017.pro/";
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";
const IPA_DIR = path.resolve(__dirname, "ipas");
const MAX_PARALLEL = 5; // increased concurrency
const MAX_RETRIES = 3;
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
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// --- DOWNLOAD ---
const axiosRetry = require("axios-retry"); // optional, for automatic retries

axiosRetry(axios, { retries: MAX_RETRIES, retryDelay: axiosRetry.exponentialDelay });

async function downloadFile(url, targetPath) {
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    console.log(`Skipping already downloaded: ${path.basename(targetPath)}`);
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let finalUrl = url;
      while (true) {
        const response = await axios({
          method: "get",
          url: finalUrl,
          responseType: "stream",
          maxRedirects: 10,
          validateStatus: (status) => true, // we handle non-200 manually
        });

        // Handle Google Drive confirm token
        if (response.status === 200 && response.headers["content-type"]?.includes("text/html")) {
          let body = "";
          for await (const chunk of response.data) {
            body += chunk.toString();
          }

          const confirmMatch = body.match(/confirm=([0-9A-Za-z_]+)&amp;id=/);
          if (confirmMatch) {
            const confirmToken = confirmMatch[1];
            finalUrl = finalUrl.replace("export=download", `export=download&confirm=${confirmToken}`);
            console.log(`Detected Google Drive confirmation for ${path.basename(targetPath)}, retrying...`);
            continue;
          } else if (body.includes("quota exceeded")) {
            throw new Error("Google Drive quota exceeded");
          } else {
            throw new Error(`Unexpected HTML response for ${finalUrl}`);
          }
        }

        // Follow non-200 redirects (3xx)
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) throw new Error(`Redirect with no location`);
          finalUrl = redirectUrl;
          console.log(`Redirected to ${redirectUrl}`);
          continue;
        }

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }

        // Stream to file
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(targetPath);
          response.data.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => {
            fs.unlink(targetPath, () => {});
            reject(err);
          });
        });

        return; // success
      }
    } catch (err) {
      console.warn(`Retry ${attempt}/${MAX_RETRIES} failed for ${path.basename(targetPath)}: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
    }
  }
}

// --- PARALLEL LIMIT ---
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

      return {
        name, bundleIdentifier, version, versionDate,
        iconURL, description, downloadURL, ipaPath, ghDownloadURL, size
      };
    });

    const apps = [];

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
