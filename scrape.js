const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// Base URL for Moe's site
const BASE_URL = "https://moe.mohkg1017.pro/";

// Feather repo lookup URL
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";

// Folder to download IPAs to
const IPA_DIR = path.resolve(__dirname, "ipas");

// Max simultaneous downloads
const MAX_CONCURRENT = 3;

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

// Google Drive direct link (returns same URL for now)
function googleDriveDirectLink(url) {
  if (!url) return url;
  return decodeHtmlEntities(url);
}

// Download file with retries and Google Drive handling
async function downloadFile(url, targetPath, retries = 0) {
  try {
    const res = await axios.get(url, {
      responseType: "stream",
      maxRedirects: 5,
      validateStatus: null,
    });

    // Handle Google Drive large file warning
    if (res.status === 200 && res.headers["content-type"]?.includes("text/html")) {
      let body = "";
      for await (const chunk of res.data) body += chunk.toString();

      const confirmMatch = body.match(/confirm=([0-9A-Za-z_]+)&/);
      const idMatch = url.match(/id=([a-zA-Z0-9_-]+)/);
      if (confirmMatch && idMatch) {
        const confirmToken = confirmMatch[1];
        const fileId = idMatch[1];
        const newUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}`;
        return downloadFile(newUrl, targetPath, retries);
      }

      throw new Error("Google Drive requires manual confirmation or quota exceeded");
    }

    if (res.status !== 200) throw new Error(`Failed to download: HTTP ${res.status}`);

    const writer = fs.createWriteStream(targetPath);
    res.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

  } catch (err) {
    if (retries < 3) {
      console.warn(`Retrying download for ${url} (${retries + 1}/3)`);
      return downloadFile(url, targetPath, retries + 1);
    } else {
      throw err;
    }
  }
}

// Helper to run N promises concurrently
async function runConcurrent(tasks, concurrency = MAX_CONCURRENT) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const p = task().then(r => results.push(r)).catch(e => results.push(e));
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(executing.findIndex(e => e === p), 1);
    }
  }

  await Promise.all(executing);
  return results;
}

async function scrape() {
  try {
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
    const downloadTasks = [];

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

      const lookup = lookupMap[name.toLowerCase()] || {};
      const bundleIdentifier = lookup.bundleIdentifier || `com.moes.${name.toLowerCase().replace(/[^a-z0-9]/gi, "")}`;
      const iconURL = lookup.iconURL || `${BASE_URL}${$(el).find(".app-icon img").attr("src")?.replace(/^\//, "") || "placeholder.png"}`;
      const description = $(el).find(".app-description").text().trim() || "No description provided.";

      const safeName = name.replace(/[^a-z0-9\-_.]/gi, "_");
      const ipaPath = path.join(IPA_DIR, `${safeName}.ipa`);

      // Add download task
      downloadTasks.push(async () => {
        console.log(`Downloading ${name}...`);
        try {
          await downloadFile(downloadURL, ipaPath);
          console.log(`Downloaded ${name} to ${ipaPath}`);
        } catch (err) {
          console.warn(`Failed to download ${name}: ${err.message}`);
        }
      });

      const ghDownloadURL = `https://github.com/dwojc6/Moes-IPA-Mirror/releases/latest/download/${safeName}.ipa`;

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

    // Run downloads concurrently
    await runConcurrent(downloadTasks, MAX_CONCURRENT);

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
