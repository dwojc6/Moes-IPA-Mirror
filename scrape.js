const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

// Base URL for Moe's site
const BASE_URL = "https://moe.mohkg1017.pro/";

// Feather repo lookup URL
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";

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

// Convert Google Drive link to direct download
function googleDriveDirectLink(url) {
  if (!url) return url;
  const match = url.match(/id=([\w-]+)/);
  if (match) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return url;
}

async function scrape() {
  try {
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
    $(".app-card").each((_, el) => {
      const name = $(el).data("name")?.toString().trim() || "Unknown App";
      const versionDate = $(el).data("updated")?.toString().trim() || new Date().toISOString().split("T")[0];

      const metaSpans = $(el).find(".app-meta-row span");
      const version = metaSpans.eq(0).text().trim().replace(/^v/i, "") || "0.0.0";
      const sizeStr = metaSpans.eq(1).text().trim() || "";
      const size = sizeToBytes(sizeStr);

      let downloadURL = $(el).find(".app-actions a.app-action.primary").attr("href") || "";
      downloadURL = googleDriveDirectLink(downloadURL);

      // Lookup bundleIdentifier & iconURL from Feather repo
      const lookup = lookupMap[name.toLowerCase()] || {};
      const bundleIdentifier = lookup.bundleIdentifier || `com.moes.${name.toLowerCase().replace(/[^a-z0-9]/gi, "")}`;
      const iconURL = lookup.iconURL || `${BASE_URL}${$(el).find(".app-icon img").attr("src")?.replace(/^\//, "") || "placeholder.png"}`;

      const description = $(el).find(".app-description").text().trim() || "No description provided.";

      apps.push({
        name,
        bundleIdentifier,
        developerName: "Unknown",
        version,
        versionDate,
        localizedDescription: description,
        iconURL,
        downloadURL,
        size
      });
    });

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
