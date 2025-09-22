const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const https = require("https");

// Base URL for Moe's site
const BASE_URL = "https://moe.mohkg1017.pro/";

// Feather repo lookup URL
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";

// Folder to download IPAs to
const IPA_DIR = path.resolve(__dirname, "ipas");

// Convert size string like "250 MB" or "1.2 GB" to bytes
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

// Convert Google Drive link to download link (we still download manually)
function googleDriveDirectLink(url) {
  if (!url) return url;
  url = decodeHtmlEntities(url);
  return url;
}

// Download file from URL to target path
function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(targetPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
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
}

async function scrape() {
  try {
    // Ensure IPA directory exists
    if (!fs.existsSync(IPA_DIR)) fs.mkdirSync(IPA_DIR, { recursive: true });

    // 1️⃣ Fetch Moe site
    const { data: html } = await axios.get(BASE_URL);
    const $ = cheerio.load(html);

    // 2️⃣ Fetch Feather repo lookup
    const { data: featherRepo } = await axios.get(LOOKUP_URL);
    const lookupMap = {};
    for (const app of featherRepo.apps) {
      lookupMap[app.name.toLowerCase()] = {
        bundleIdentifier: app.bundleIdentifier,
        iconURL: app.iconURL
      };
    }

    const apps = [];

    // 3️⃣ Scrape Moe's apps
    const appCards = $(".app-card").toArray();

    for (const el of appCards) {
      const name = $(el).data("name")?.toString().trim() || "Unknown App";
      const versionDate = $(el).data("updated")?.toString().trim() || new Date().toISOString().split("T")[0];

      const metaSpans = $(el).find(".app-meta-row span");
      const version = metaSpans.eq(0).text().trim().replace(/^v/i, "") || "0.0.0";
      const sizeStr = metaSpans.eq(1).text().trim() || "";
      const size = sizeToBytes(sizeStr);

      let downloadURL = $(el).find(".app-actions a.app-action.primary").attr("href") || "";
      downloadURL = googleDriveDirectLink(downloadURL);

      // Lookup bundleIdentifier & iconURL
      const lookup = lookupMap[name.toLowerCase()] || {};
      const bundleIdentifier = lookup.bundleIdentifier || `com.moes.${name.toLowerCase().replace(/[^a-z0-9]/gi, "")}`;
      const iconURL = lookup.iconURL || `${BASE_URL}${$(el).find(".app-icon img").attr("src")?.replace(/^\//, "") || "placeholder.png"}`;

      const description = $(el).find(".app-description").text().trim() || "No description provided.";

      // Save IPA locally
      const safeName = name.replace(/[^a-z0-9\-_.]/gi, "_");
      const ipaPath = path.join(IPA_DIR, `${safeName}.ipa`);
      try {
        console.log(`Downloading ${name} from ${downloadURL}...`);
        await downloadFile(downloadURL, ipaPath);
        console.log(`Downloaded to ${ipaPath}`);
      } catch (err) {
        console.warn(`Failed to download ${name}: ${err.message}`);
      }

      // Set downloadURL for GitHub Releases (Action will upload)
      const ghDownloadURL = `https://github.com/<USERNAME>/<REPO>/releases/download/<TAG>/${safeName}.ipa`;

      apps.push({
        name,
        bundleIdentifier,
        developerName: "Unknown",
        version,
        versionDate,
        localizedDescription: description,
        iconURL,
        downloadURL: ghDownloadURL,
        size
      });
    }

    // 4️⃣ Write Feather JSON
    const repo = {
      name: "Moes IPA Mirror",
      identifier: "com.dwojc6.moesipamirror",
      apps
    };

    fs.writeFileSync("repo.feather.json", JSON.stringify(repo, null, 2));
    console.log(`✅ repo.feather.json generated with ${apps.length} apps`);
  } catch (err) {
    console.error("❌ Error scraping site:", err);
    process.exit(1);
  }
}

scrape();
