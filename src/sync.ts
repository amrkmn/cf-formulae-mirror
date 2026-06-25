import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractPages } from "./extract";

const OUTPUT_DIR =
    process.env.OUTPUT_DIR ?? join(import.meta.dir, "..", "dist");

const B2_BUCKET = process.env.B2_BUCKET;
const B2_APPLICATION_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY;
const B2_ENDPOINT = process.env.B2_ENDPOINT;

function requireEnv(name: string, value: string | undefined): string {
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function validateEnv(): void {
    requireEnv("GITHUB_TOKEN", process.env.GITHUB_TOKEN);
    requireEnv("B2_BUCKET", B2_BUCKET);
    requireEnv("B2_APPLICATION_KEY_ID", B2_APPLICATION_KEY_ID);
    requireEnv("B2_APPLICATION_KEY", B2_APPLICATION_KEY);
}

function checkPrereqs(): void {
    const missing = ["rclone", "unzip"].filter((cmd) => !Bun.which(cmd));
    if (missing.length > 0) {
        throw new Error(
            `Missing required commands: ${missing.join(", ")}`,
        );
    }
}

function configureRclone(): void {
    process.env.RCLONE_CONFIG_B2_TYPE = "b2";
    process.env.RCLONE_CONFIG_B2_ACCOUNT = B2_APPLICATION_KEY_ID!;
    process.env.RCLONE_CONFIG_B2_KEY = B2_APPLICATION_KEY!;
    if (B2_ENDPOINT) {
        process.env.RCLONE_CONFIG_B2_ENDPOINT = B2_ENDPOINT;
    }
}

async function syncToB2(): Promise<void> {
    configureRclone();

    console.log(`  syncing ${OUTPUT_DIR} -> b2:${B2_BUCKET}/`);

    await $`rclone sync ${OUTPUT_DIR} b2:${B2_BUCKET} \
            --b2-hard-delete \
            --checksum \
            --fast-list \
            --transfers 64 \
            --checkers 64 \
            --order-by size,mixed,50 \
            --retries 5 \
            --low-level-retries 20 \
            --retries-sleep 10s \
            --log-level INFO \
            --progress \
            --stats 30s \
            --stats-one-line-date`.env(process.env);

    const sizeResult = await $`rclone size b2:${B2_BUCKET} --fast-list`
        .env(process.env)
        .quiet();

    const totalObjects =
        sizeResult.text().match(/Total objects:\s*(.+)/)?.[1] ?? "N/A";

    console.log(
        `  sync complete — bucket: ${B2_BUCKET}, files: ${totalObjects}`,
    );
}

async function cleanupHiddenVersions(): Promise<void> {
    configureRclone();

    const bucket = B2_BUCKET!.split("/")[0];
    const target = `b2:${bucket}`;

    console.log(`  cleaning hidden versions in ${target}...`);

    await $`rclone cleanup ${target} \
            --fast-list \
            --checkers 64 \
            --transfers 64 \
            --log-level INFO \
            --progress \
            --stats 30s \
            --stats-one-line-date`.env(process.env);

    console.log(`  cleanup complete — bucket: ${bucket}`);
}

async function main(): Promise<void> {
    checkPrereqs();
    validateEnv();

    // If --cleanup flag is passed, only run cleanup (no sync)
    if (process.argv.includes("--cleanup")) {
        console.log("Running B2 hidden version cleanup...");
        await cleanupHiddenVersions();
        return;
    }

    console.log("Starting cf-formulae-mirror sync...");

    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const { filePaths, artifactId } = await extractPages(OUTPUT_DIR);

    console.log(
        `Done! ${filePaths.size} files extracted (artifact #${artifactId}).`,
    );
    console.log(`  syncing to B2...`);

    await syncToB2();

    writeFileSync(join(import.meta.dir, "..", ".version"), String(artifactId));

    try {
        await cleanupHiddenVersions();
    } catch (err) {
        console.warn("Cleanup failed (non-fatal):", err);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
