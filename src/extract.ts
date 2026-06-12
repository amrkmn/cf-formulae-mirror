import { $ } from "bun";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Progress } from "./progress";

const ARTIFACT_API =
    process.env.ARTIFACT_API_URL ??
    "https://api.github.com/repos/Homebrew/formulae.brew.sh/actions/artifacts?name=github-pages";

const RETRIES = 5;
const BASE_DELAY_MS = 2000;

const CACHE_DIR =
    process.env.CACHE_DIR ??
    join(
        process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        "formulae-mirror-artifacts",
    );

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? join(cwd(), "dist");

type Headers = Record<string, string>;

interface ArtifactMeta {
    id: number;
    archiveDownloadUrl: string;
    sizeInBytes: number;
}

type ArtifactUrlSource = "nightly.link" | "github";

interface ArtifactUrlResult {
    id: number;
    url: string;
    source: ArtifactUrlSource;
    sizeInBytes: number;
}

interface ArtifactUrlOptions {
    /** Prefer nightly.link over GitHub API (default: true). */
    preferNightly?: boolean;
    /** Fall back to GitHub API if nightly.link is unreachable (default: true). */
    fallback?: boolean;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

const isRetriableStatus = (status: number): boolean =>
    status === 429 || status >= 500;

const retryDelay = (attempt: number): number =>
    BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;

const fmtError = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return String(err ?? "unknown error");
};

const githubAuthHeaders = (): Headers => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is required");
    return {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        "User-Agent": "formulae-mirror",
    };
};

async function fetchJson(url: string, headers: Headers): Promise<unknown> {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        let res: Response;
        try {
            res = await fetch(url, { redirect: "follow", headers });
        } catch (err) {
            // network errors are always retried
            if (attempt >= RETRIES) {
                throw new Error(`fetch ${url}: ${fmtError(err)}`);
            }
            const delay = retryDelay(attempt);
            console.log(
                `  retry ${attempt}/${RETRIES} network error: ${fmtError(err)} ` +
                    `(wait ${Math.round(delay)}ms)`,
            );
            await sleep(delay);
            continue;
        }

        if (res.ok) return res.json();

        if (isRetriableStatus(res.status)) {
            if (attempt >= RETRIES) {
                throw new Error(
                    `fetch ${url}: ${res.status} (retries exhausted)`,
                );
            }
            const delay = retryDelay(attempt);
            console.log(
                `  retry ${attempt}/${RETRIES} ${res.status} for ${url} ` +
                    `(wait ${Math.round(delay)}ms)`,
            );
            await sleep(delay);
            continue;
        }

        // non-retriable HTTP error
        throw new Error(`fetch ${url}: ${res.status}`);
    }
    throw new Error(`fetch ${url}: failed after ${RETRIES} retries`);
}

async function downloadToFile(
    url: string,
    dest: string,
    expectedBytes: number,
    headers?: Headers,
): Promise<void> {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            // check existing state
            const existingBytes = existsSync(dest) ? Bun.file(dest).size : 0;
            if (existingBytes === expectedBytes) return;
            if (existingBytes > expectedBytes) unlinkSync(dest);

            const resumeBytes =
                existingBytes > expectedBytes ? 0 : existingBytes;

            // build request headers
            const reqHeaders: Headers = { ...(headers ?? {}) };
            if (resumeBytes > 0) {
                reqHeaders.Range = `bytes=${resumeBytes}-`;
            }

            const res = await fetch(url, {
                redirect: "follow",
                headers: reqHeaders,
            });

            // 416 with correct expectedBytes means download is already complete
            if (res.status === 416 && resumeBytes === expectedBytes) return;

            if (!res.ok) {
                if (isRetriableStatus(res.status)) {
                    const delay = retryDelay(attempt);
                    console.log(
                        `  download retry ${attempt}/${RETRIES} ${res.status} ` +
                            `(wait ${Math.round(delay)}ms)`,
                    );
                    await sleep(delay);
                    continue;
                }
                throw new Error(`download ${url}: ${res.status}`);
            }

            const appending = resumeBytes > 0 && res.status === 206;
            if (resumeBytes > 0 && !appending) unlinkSync(dest);

            const startBytes = appending ? resumeBytes : 0;
            const contentLen = Number(res.headers.get("content-length") ?? 0);
            const total = expectedBytes || startBytes + contentLen;

            const progress = new Progress("download", total, "bytes");
            progress.start(startBytes);

            if (!res.body)
                throw new Error(`download ${url}: empty response body`);

            const writer = createWriteStream(dest, {
                flags: appending ? "a" : "w",
                highWaterMark: 1024 * 1024,
            });
            const stream = Readable.fromWeb(res.body as ReadableStream);

            const timer = setInterval(() => {
                progress.update(Bun.file(dest).size);
            }, 200);

            try {
                await pipeline(stream, writer);
            } finally {
                clearInterval(timer);
            }

            const downloaded = Bun.file(dest).size;
            progress.update(downloaded);

            if (downloaded !== expectedBytes) {
                throw new Error(
                    `download incomplete: expected ${expectedBytes} bytes, got ${downloaded}`,
                );
            }
            return;
        } catch (err) {
            if (attempt >= RETRIES) throw err;
            const delay = retryDelay(attempt);
            console.log(
                `  download retry ${attempt}/${RETRIES}: ${fmtError(err)} ` +
                    `(wait ${Math.round(delay)}ms)`,
            );
            await sleep(delay);
        }
    }
    throw new Error(`download ${url}: failed after ${RETRIES} retries`);
}

function cleanStaleCache(keepArtifactId: number): void {
    try {
        for (const entry of readdirSync(CACHE_DIR)) {
            if (!entry.startsWith("artifact-")) continue;
            const id = parseInt(entry.slice("artifact-".length), 10);
            if (isNaN(id) || id === keepArtifactId) continue;
            const fullPath = join(CACHE_DIR, entry);
            rmSync(fullPath, { recursive: true, force: true });
        }
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") throw err;
    }
}

async function fetchLatestArtifact(): Promise<ArtifactMeta> {
    const headers = githubAuthHeaders();
    const data = (await fetchJson(ARTIFACT_API, headers)) as {
        artifacts: Array<{
            id: number;
            archive_download_url: string;
            size_in_bytes: number;
            workflow_run?: { head_branch?: string };
            expired: boolean;
        }>;
    };

    const latest = data.artifacts.find(
        (a) => a.workflow_run?.head_branch === "main" && !a.expired,
    );

    if (!latest) {
        throw new Error("No latest github-pages artifact found on main branch");
    }

    console.log("Fetching latest artifact from GitHub...");

    return {
        id: latest.id,
        archiveDownloadUrl: latest.archive_download_url,
        sizeInBytes: latest.size_in_bytes,
    };
}

async function isUrlReachable(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: "HEAD", redirect: "follow" });
        return res.ok || res.status === 302 || res.status === 301;
    } catch {
        return false;
    }
}

function nightlyUrl(artifactId: number): string {
    return `https://nightly.link/Homebrew/formulae.brew.sh/actions/artifacts/${artifactId}.zip`;
}

export async function getArtifactUrl(
    opts?: ArtifactUrlOptions,
): Promise<ArtifactUrlResult> {
    const preferNightly = opts?.preferNightly ?? true;
    const fallback = opts?.fallback ?? true;

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN is required (set in .env for local dev)");
    }

    const latest = await fetchLatestArtifact();
    const sizeMB = (latest.sizeInBytes / (1024 * 1024)).toFixed(2);
    console.log(`  latest artifact: #${latest.id} (${sizeMB} MB)`);

    if (preferNightly) {
        const url = nightlyUrl(latest.id);
        console.log(`  checking nightly.link...`);
        if (await isUrlReachable(url)) {
            console.log(`  url: ${url} (nightly.link)`);
            return {
                id: latest.id,
                url,
                source: "nightly.link",
                sizeInBytes: latest.sizeInBytes,
            };
        }
        console.log(`  nightly.link unreachable`);
        if (!fallback) {
            throw new Error(
                "nightly.link is unreachable and fallback is disabled",
            );
        }
    }

    console.log(`  url: ${latest.archiveDownloadUrl} (github)`);
    return {
        id: latest.id,
        url: latest.archiveDownloadUrl,
        source: "github",
        sizeInBytes: latest.sizeInBytes,
    };
}

export async function extractPages(outputDir: string): Promise<{
    filePaths: Set<string>;
    artifactId: number;
}> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN is required (set in .env for local dev)");
    }

    const headers = githubAuthHeaders();
    const latest = await fetchLatestArtifact();

    const artifactId = latest.id;
    const sizeMB = (latest.sizeInBytes / (1024 * 1024)).toFixed(2);
    const cachedZip = join(CACHE_DIR, `artifact-${artifactId}.zip`);

    mkdirSync(CACHE_DIR, { recursive: true });
    cleanStaleCache(artifactId);

    if (existsSync(cachedZip)) {
        console.log(`  using cached artifact #${artifactId} (${sizeMB} MB)`);
    } else {
        console.log(`  downloading artifact #${artifactId} (${sizeMB} MB)...`);
        const tmpZip = cachedZip + ".tmp";

        const nightlyUrl = `https://nightly.link/Homebrew/formulae.brew.sh/actions/artifacts/${artifactId}.zip`;

        // try nightly.link first (faster, no auth rate limits)
        try {
            await downloadToFile(nightlyUrl, tmpZip, latest.sizeInBytes);
            console.log("  downloaded via nightly.link");
        } catch (nightlyErr: unknown) {
            console.log(
                `  nightly.link failed (${fmtError(nightlyErr)}), ` +
                    "falling back to GitHub API...",
            );
            if (existsSync(tmpZip)) unlinkSync(tmpZip);
            await downloadToFile(
                latest.archiveDownloadUrl,
                tmpZip,
                latest.sizeInBytes,
                headers,
            );
            console.log("  downloaded via GitHub API");
        }

        // verify and finalize
        const actual = Bun.file(tmpZip).size;
        if (actual !== latest.sizeInBytes) {
            unlinkSync(tmpZip);
            throw new Error(
                `download incomplete: expected ${latest.sizeInBytes} bytes, got ${actual}`,
            );
        }
        renameSync(tmpZip, cachedZip);
        console.log("  cached artifact for future runs");
    }

    // ---- extract ----

    const tmpDir = mkdtempSync(join(CACHE_DIR, "tmp-"));
    try {
        const unzipDir = join(tmpDir, "unzip");
        mkdirSync(unzipDir, { recursive: true });

        console.log("  extracting zip...");
        await $`unzip -q ${cachedZip} -d ${unzipDir}`;

        const artifactTar = join(unzipDir, "artifact.tar");
        const tarExists = await Bun.file(artifactTar).exists();
        if (!tarExists) throw new Error("artifact.tar not found inside zip");

        console.log("  reading tar...");
        const archive = new Bun.Archive(await Bun.file(artifactTar).bytes());
        const entries = await archive.files();

        const filePaths = new Set<string>();
        const parseProgress = new Progress("extracting", entries.size, "count");
        let count = 0;

        for (const [path, file] of entries) {
            const normalized = path.replace(/^\.\/?/, "");
            if (normalized) {
                const outPath = join(outputDir, normalized);
                mkdirSync(join(outPath, ".."), { recursive: true });
                writeFileSync(
                    outPath,
                    new Uint8Array(await file.arrayBuffer()),
                );
                filePaths.add(normalized);
            }
            parseProgress.update(++count);
        }

        console.log(`  extracted ${filePaths.size} files to ${outputDir}`);
        return { filePaths, artifactId };
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ---- CLI entry point ----

async function main(): Promise<void> {
    console.log("Starting formulae.brew.sh mirror sync...");

    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const { filePaths, artifactId } = await extractPages(OUTPUT_DIR);

    writeFileSync(".version", String(artifactId));

    console.log(
        `Done! ${filePaths.size} files extracted (artifact #${artifactId}).`,
    );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
