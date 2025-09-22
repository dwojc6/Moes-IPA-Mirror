const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");
const pLimit = require("p-limit");

const BASE_URL = "https://moe.mohkg1017.pro/";
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";
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

// Convert Google Drive URL to direct download link if possible
function googleDriveDirectLink(url) {
  if (!url) return url;
  url = decodeHtmlEntities(url);
  const match = url.match(/(?:drive\.google\.com\/file\/d\/|id=)([\w-]+)/);
  if (match) {
    const fileId = match[1];
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  return url;
}

// Download file with retries and Google Drive confirmation handling
async function downloadFile(url, targetPath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(targetPath);
        https.get(url, (res) => {
          // Handle Google Drive large file confirmation
          if (res.headers["content-disposition"]?.includes("attachment")) {
            res.pipe(file);
          } else if (res.statusCode === 200) {
            // Might be the confirmation page
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", async () => {
              const confirmMatch = body.match(/confirm=([0-9A-Za-z_]+)&/);
              if (confirmMatch) {
                const confirmCode = confirmMatch[1];
                const u = new URL(url);
                u.searchParams.set("confirm", confirmCode);
                try {
                  await downloadFile(u.toString(), targetPath, 1); // recursive single retry
                  resolve();
                } catch (err) {
                  reject(err);
                }
              } else {
                reject(new Error("Unexpected response, not a file"));
              }
            });
            return;
          } else if (res.statusCode !== 200) {
            reject(new Error(`Failed with status ${res.statusCode}`));
            return;
          }

          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        }).on("error", (err) => {
          fs.unlink(targetPath, () => {});
          reject(err);
        });
      });

      return; // Success, exit retry loop
    } catch (err) {
      console.warn(`Attempt ${attempt} failed for ${url}: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
    }
  }
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
    const appCards = $(".app-card").toArray();

    const limit = pLimit(3); // Max 3 simultaneous downloads
    const downloadPromises = [];

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

      // Queue the download
      downloadPromises.push(limit(async () => {
        try {
          console.log(`Downloading ${name}...`);
          await downloadFile(downloadURL, ipaPath);
          console.log(`Downloaded ${name} to ${ipaPath}`);
        } catch (err) {
          console.warn(`Failed to download ${name}: ${err.message}`);
        }
      }));

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

    await Promise.all(downloadPromises); // Wait for all downloads

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
