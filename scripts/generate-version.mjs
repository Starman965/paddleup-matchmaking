import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function gitValue(command, fallback) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

const buildNumberPath = "public/build-number.txt";
const currentBuild = existsSync(buildNumberPath) ? Number.parseInt(readFileSync(buildNumberPath, "utf8").trim(), 10) : 1;
const nextBuild = Number.isFinite(currentBuild) && currentBuild > 0 ? currentBuild + 1 : 1;

const metadata = {
  appVersion: "1.0",
  build: String(nextBuild),
  version: new Date().toISOString(),
  commit: gitValue("git rev-parse --short HEAD", "local")
};

writeFileSync(buildNumberPath, `${nextBuild}\n`);
writeFileSync("public/version.json", `${JSON.stringify(metadata, null, 2)}\n`);
