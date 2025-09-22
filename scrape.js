#!/usr/bin/env node

/**
 * Scrape Moe IPA site -> download IPAs via gdown -> generate repo.feather.json
 * Author: Slowie (rewritten)
 */

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE_URL = "https://moe.mohkg1017.pro/all-apps";
const IPAS_DIR = path.join(__dirname, "ipas");
const JSON_FILE = path.join(__dirname, "repo.feather.json");

// Ensure ipas directory exists
if (!fs.existsSync(IPAS_DIR)) {
  fs.mkdirSync(IPAS_DIR);
}

/**
 * Download a file from Google Drive using gdown
 */
function downloadFromGDrive(id, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`📥 Downloading with gdown: ${outputPath}`);
    const child = spawn("gdown", ["--id", id, "-O", outputPath]);

    child.stdout.on("data", (data) => process.stdout.write(data));
    child.stderr.on("data", (data) => process.stderr.write(data));

    child.on("exit", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        console.log(`✅ Downloaded ${outputPath}`);
        resolve();
      } else {
        reject(new Error(`gdown failed for ${id} (exit ${code})`));
      }
    });
  });
}

/**
 * Parse app list from Moe site
 */
async function fetchApps() {
  console.log("🌐 Fetching Moe IPA list...");
  const { data } = await axios.get(BASE_URL);
  const $ = cheerio.load(data);

  const apps = [];
  $(".uk-card").each((i, el) => {
    const name = $(el).find("h3").text().trim();
    const link = $(el).find("a[href*='drive.google.com']").attr("href");
    if (!link) return;

    // Extract Google Drive file ID
    const match = link.match(/[-\w]{25,}/);
    if (!match) return;

    const id = match[0];
    const fileName = name.replace(/\s+/g, "_") + ".ipa";
    apps.push({ name, id, fileName });
  });

  console.log(`📦 Found ${apps.length} apps`);
  return apps;
}

/**
 * Main
 */
(async () => {
  try {
    const apps = await fetchApps();
    const results = [];

    for (const app of apps) {
      const ipaPath = path.join(IPAS_DIR, app.fileName);

      try {
        if (!fs.existsSync(ipaPath)) {
          await downloadFromGDrive(app.id, ipaPath);
        } else {
          console.log(`⏩ Skipping ${app.fileName}, already exists`);
        }

        // Feather repo entry
        results.push({
          name: app.name,
          bundleIdentifier: "", // optional: can extract later if needed
          developerName: "Moe IPA",
          version: "",
          downloadURL: `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/latest/${app.fileName}`,
          iconURL: "", // can be added later if you want
        });
      } catch (err) {
        console.error(`❌ Failed ${app.name}: ${err.message}`);
      }
    }

    // Write Feather repo JSON
    fs.writeFileSync(JSON_FILE, JSON.stringify(results, null, 2));
    console.log(`📄 Wrote ${JSON_FILE} (${results.length} apps)`);
  } catch (err) {
    console.error("❌ Error scraping site:", err);
    process.exit(1);
  }
})();
