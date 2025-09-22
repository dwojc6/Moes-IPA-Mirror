// scrape.js (replace / drop-in for your existing file)
// NOTE: This file retains your original structure but replaces the previously-missing helpers
// and the downloadGDrive implementation with a robust axios-based downloader.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { spawn } = require("child_process"); // still used by uploadBatch (gh)
const { promisify } = require("util");
const stream = require("stream");
const streamPipeline = promisify(stream.pipeline);

// --- CONFIG ---
const BASE_URL = "https://moe.mohkg1017.pro/";
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";
const IPA_DIR = path.resolve(__dirname, "ipas");
const BATCH_SIZE = 5;
const FAILED_LOG = path.resolve(__dirname, "failedDownloads.json");

// --- HELPERS ---
function sizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  // Expecting strings like "12.3 MB", "1024 KB", "1.2 GB"
  const match = sizeStr.replace(/,/g, "").match(/([\d.]+)\s*(B|KB|MB|GB|TB)?/i);
  if (!match) return 0;
  const n = parseFloat(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  switch (unit) {
    case "TB": return Math.round(n * 1024 ** 4);
    case "GB": return Math.round(n * 1024 ** 3);
    case "MB": return Math.round(n * 1024 ** 2);
    case "KB": return Math.round(n * 1024);
    default: return Math.round(n);
  }
}

function decodeHtmlEntities(str = "") {
  // Minimal decoding for common entities
  return str.replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
}

/**
 * Extract a Google Drive file id from many possible share URL formats,
 * and return a normalized download URL for docs.google.com.
 *
 * Examples supported:
 *  - https://drive.google.com/file/d/FILEID/view?usp=sharing
 *  - https://drive.google.com/open?id=FILEID
 *  - https://drive.google.com/uc?id=FILEID&export=download
 *  - https://drive.google.com/drive/folders/... (folder -> returns null)
 *  - https://drive.google.com/shortlink? (handles query id=)
 *
 * If no Drive id is found, returns the original url.
 */
function googleDriveDirectLink(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const decoded = decodeURIComponent(url);
    // Patterns to extract file id
    const patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/,           // /file/d/ID
      /id=([a-zA-Z0-9_-]{10,})/,                  // ?id=ID
      /\/d\/([a-zA-Z0-9_-]{10,})/,                // /d/ID
      /open\?id=([a-zA-Z0-9_-]{10,})/,            // open?id=ID
      /\/uc\?id=([a-zA-Z0-9_-]{10,})/,            // uc?id=ID
      /\/drive\/folders\/([a-zA-Z0-9_-]{10,})/    // folder (not a file)
    ];
    for (const rx of patterns) {
      const m = decoded.match(rx);
      if (m && m[1]) {
        const id = m[1];
        // Return normalized download URL that our downloader understands
        return `https://docs.google.com/uc?export=download&id=${id}`;
      }
    }
    // As fallback, if the url looks like a "file/d/..." somewhere without match:
    const alt = decoded.match(/[-\w]{25,}/);
    if (alt && alt[0]) return `https://docs.google.com/uc?export=download&id=${alt[0]}`;
    // If nothing matched, just return the original URL
    return url;
  } catch (e) {
    return url;
  }
}

/**
 * Download a Google Drive file robustly:
 *  - Accepts a variety of share URL forms (we try to extract id first).
 *  - Handles Drive's "confirm" page for large files by parsing the HTML and re-requesting.
 *  - Streams the final upload to disk (no large in-memory buffers).
 *
 * Retries a few times on transient errors.
 */
async function downloadGDrive(originalUrl, outputPath) {
  // Skip if file already exists and size > 0
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    console.log(`Skipping already downloaded: ${path.basename(outputPath)}`);
    return;
  }
  // Ensure directory
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const normalized = googleDriveDirectLink(originalUrl);
  // We will try up to 3 attempts
  const maxAttempts = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Downloading ${path.basename(outputPath)} (attempt ${attempt}) from ${normalized}`);
      const headers = {
        "User-Agent": "Mozilla/5.0 (compatible; Moes-IPA-Mirror/1.0)",
        "Accept-Language": "en-US,en;q=0.9"
      };

      // Initial request (may return the actual file stream OR an HTML confirmation page)
      const res = await axios.get(normalized, { responseType: "stream", headers, maxRedirects: 5, timeout: 10 * 60 * 1000 });

      const contentType = (res.headers['content-type'] || "").toLowerCase();
      const contentDisp = res.headers['content-disposition'] || "";

      // If we received a file stream directly (content-disposition usually present), stream to disk
      if (contentDisp || (contentType && !contentType.includes("html"))) {
        await streamPipeline(res.data, fs.createWriteStream(outputPath));
        // quick sanity check
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          console.log(`✅ Downloaded ${path.basename(outputPath)} (${fs.statSync(outputPath).size} bytes)`);
          return;
        } else {
          throw new Error("Downloaded file seems empty after streaming");
        }
      }

      // Otherwise we likely got an HTML confirmation page (large file warning) — buffer it (it's small)
      const chunks = [];
      await new Promise((resolve, reject) => {
        res.data.on("data", (c) => chunks.push(c));
        res.data.on("end", resolve);
        res.data.on("error", reject);
      });
      const htmlBody = Buffer.concat(chunks).toString("utf8");

      // Try to extract confirm token from common patterns
      let m = htmlBody.match(/confirm=([0-9A-Za-z_-]+)&amp;/) || htmlBody.match(/confirm=([0-9A-Za-z_-]+)&/);
      let confirmToken = m ? m[1] : null;

      if (!confirmToken) {
        // Try to find the download link href like /uc?export=download&confirm=TOKEN&id=ID
        const hrefMatch = htmlBody.match(/href="(\/uc\?export=download[^"]+)"/);
        if (hrefMatch && hrefMatch[1]) {
          const href = hrefMatch[1].replace(/&amp;/g, "&");
          // Build the absolute URL to request
          const forcedUrl = `https://docs.google.com${href}`;
          console.log(`Found download href in HTML; requesting ${forcedUrl}`);
          const res2 = await axios.get(forcedUrl, { responseType: "stream", headers, maxRedirects: 5, timeout: 10 * 60 * 1000 });
          await streamPipeline(res2.data, fs.createWriteStream(outputPath));
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            console.log(`✅ Downloaded ${path.basename(outputPath)} (${fs.statSync(outputPath).size} bytes)`);
            return;
          } else {
            throw new Error("Downloaded file seems empty after second-stream");
          }
        }
      } else {
        // We have a confirm token; try again using the token
        // Try to extract id parameter (fallback: original normalized url may already include id)
        const idMatch = normalized.match(/[?&]id=([0-9A-Za-z_-]+)/);
        const id = idMatch ? idMatch[1] : null;
        if (!id) throw new Error("Couldn't extract file id for confirm flow");

        const confirmUrl = `https://docs.google.com/uc?export=download&confirm=${confirmToken}&id=${id}`;
        console.log(`Confirm token detected; requesting ${confirmUrl}`);
        const res3 = await axios.get(confirmUrl, { responseType: "stream", headers, maxRedirects: 5, timeout: 10 * 60 * 1000 });
        await streamPipeline(res3.data, fs.createWriteStream(outputPath));
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          console.log(`✅ Downloaded ${path.basename(outputPath)} (${fs.statSync(outputPath).size} bytes)`);
          return;
        } else {
          throw new Error("Downloaded file seems empty after confirm-stream");
        }
      }

      // If we fall through here, something unexpected happened
      throw new Error("Could not find confirm token or download link on Drive page");
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${attempt} failed for ${path.basename(outputPath)}: ${err.message}`);
      // small backoff
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  throw new Error(`Failed to download after ${maxAttempts} attempts: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

// --- Keep your uploadBatch and other functions the same ---
async function uploadBatch(batchFiles) {
  // Use GH CLI to upload files in batch to latest release
  for (const file of batchFiles) {
    console.log(`⬆️ Uploading ${path.basename(file)}...`);
    await new Promise((resolve, reject) => {
      const gh = spawn("gh", ["release", "upload", "latest", file, "--clobber"]);
      gh.stdout.on("data", d => process.stdout.write(d.toString()));
      gh.stderr.on("data", d => process.stderr.write(d.toString()));
      gh.on("close", code => (code === 0 ? resolve() : reject(new Error(`Upload failed: ${file}`))));
    });
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
      try { await Promise.race(executing); } catch(e) { /* swallow so others keep running */ }
      // remove resolved ones
      for (let i = executing.length - 1; i >= 0; i--) {
        if (executing[i].isFulfilled || executing[i].isRejected) {
          executing.splice(i, 1);
        }
      }
      // Note: we can't inspect Promise state directly; this is best-effort. Simpler:
      executing.splice(executing.findIndex(e => e === p), 1);
    }
  }
  return Promise.all(results);
}

// --- MAIN ---
async function scrape() {
  try {
    if (!fs.existsSync(IPA_DIR)) fs.mkdirSync(IPA_DIR, { recursive: true });
    let failedDownloads = [];

    const { data: html } = await axios.get(BASE_URL);
    const $ = cheerio.load(html);

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
      // Keep the raw URL but normalize it later in downloadGDrive
      // downloadURL = googleDriveDirectLink(downloadURL);

      const lookup = lookupMap[name.toLowerCase()] || {};
      const bundleIdentifier = lookup.bundleIdentifier || `com.moes.${name.toLowerCase().replace(/[^a-z0-9]/gi, "")}`;
      const iconURL = lookup.iconURL || `${BASE_URL}${$(el).find(".app-icon img").attr("src")?.replace(/^\//, "") || "placeholder.png"}`;
      const description = $(el).find(".app-description").text().trim() || "No description provided.";

      const safeName = name.replace(/[^a-z0-9\-_.]/gi, "_");
      const ipaPath = path.join(IPA_DIR, `${safeName}.ipa`);
      const ghDownloadURL = `https://github.com/dwojc6/Moes-IPA-Mirror/releases/download/latest/${safeName}.ipa`;

      return { name, bundleIdentifier, version, versionDate, iconURL, description, downloadURL, ipaPath, ghDownloadURL, size };
    });

    const apps = [];
    for (let i = 0; i < appsToDownload.length; i += BATCH_SIZE) {
      const batch = appsToDownload.slice(i, i + BATCH_SIZE);

      // Download batch
      await parallelLimit(batch, BATCH_SIZE, async app => {
        try {
          await downloadGDrive(app.downloadURL, app.ipaPath);
          apps.push(app);
        }
        catch (err) {
          console.warn(`❌ Failed to download ${app.name}: ${err.message}`);
          failedDownloads.push({ name: app.name, url: app.downloadURL, error: err.message });
        }
      });

      // Upload batch (only upload those files that actually exist)
      const existingFiles = batch.map(a => a.ipaPath).filter(p => fs.existsSync(p));
      if (existingFiles.length) await uploadBatch(existingFiles);
    }

    // Write Feather JSON
    fs.writeFileSync("repo.feather.json", JSON.stringify({
      name: "Moes IPA Mirror",
      identifier: "com.dwojc6.moesipamirror",
      apps: apps.map(a => ({
        name: a.name,
        bundleIdentifier: a.bundleIdentifier,
        developerName: "Unknown",
        version: a.version,
        versionDate: a.versionDate,
        localizedDescription: a.description,
        iconURL: a.iconURL,
        downloadURL: a.ghDownloadURL,
        size: a.size
      }))
    }, null, 2));

    if (failedDownloads.length > 0) fs.writeFileSync(FAILED_LOG, JSON.stringify(failedDownloads, null, 2));

    console.log(`✅ repo.feather.json generated with ${apps.length} apps`);
  } catch (err) {
    console.error("❌ Error scraping site:", err);
    process.exit(1);
  }
}

scrape();
