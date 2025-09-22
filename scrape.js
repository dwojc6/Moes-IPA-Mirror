const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { spawn } = require("child_process");

// --- CONFIG ---
const BASE_URL = "https://moe.mohkg1017.pro/";
const LOOKUP_URL = "https://aio.zxcvbn.fyi/r/repo.feather.json";
const IPA_DIR = path.resolve(__dirname, "ipas");
const BATCH_SIZE = 5;
const FAILED_LOG = path.resolve(__dirname, "failedDownloads.json");

// --- UTILS ---
function sizeToBytes(sizeStr) { /* same as before */ }
function decodeHtmlEntities(str) { /* same as before */ }
function googleDriveDirectLink(url) { /* same as before */ }

function downloadGDrive(url, outputPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      console.log(`Skipping already downloaded: ${path.basename(outputPath)}`);
      return resolve();
    }
    console.log(`Downloading ${path.basename(outputPath)} via gdown...`);
    const gdownProcess = spawn("python3", ["-m", "gdown", url, "-O", outputPath]);
    gdownProcess.stdout.on("data", (data) => process.stdout.write(data.toString()));
    gdownProcess.stderr.on("data", (data) => process.stderr.write(data.toString()));
    gdownProcess.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gdown exited with code ${code}`));
    });
  });
}

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
      await Promise.race(executing).catch(() => {});
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

    const apps = [];
    for (let i = 0; i < appsToDownload.length; i += BATCH_SIZE) {
      const batch = appsToDownload.slice(i, i + BATCH_SIZE);

      // Download batch
      await parallelLimit(batch, BATCH_SIZE, async app => {
        try { await downloadGDrive(app.downloadURL, app.ipaPath); apps.push(app); }
        catch (err) { console.warn(`❌ Failed to download ${app.name}: ${err.message}`); failedDownloads.push({ name: app.name, url: app.downloadURL }); }
      });

      // Upload batch
      await uploadBatch(batch.map(a => a.ipaPath));
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
