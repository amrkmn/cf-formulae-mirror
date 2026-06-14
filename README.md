# cf-formulae-mirror

Mirrors [formulae.brew.sh](https://formulae.brew.sh) using **Backblaze B2 + Cloudflare CDN**.

No servers to maintain. Zero egress fees (Bandwidth Alliance). Updates automatically via Crow CI cron.

## Architecture

```
GitHub Actions artifact          Crow CI (cron)
  Homebrew/formulae.brew.sh ──▶  extract.ts ──▶ rclone sync ──▶ B2 bucket
                                                                   │
                                                              Cloudflare CDN
                                                                   │
                                                          formulae.yourdomain.com
```

- **extract.ts**: Downloads the latest `github-pages` artifact from the Homebrew repo, extracts all static files
- **rclone**: Syncs extracted files to a public Backblaze B2 bucket with checksums
- **Cloudflare**: Serves the bucket through CDN (CNAME + Transform Rules)

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- [rclone](https://rclone.org) ≥ 1.74
- A [Backblaze B2](https://www.backblaze.com/b2/cloud-storage.html) account
- A domain on [Cloudflare](https://dash.cloudflare.com/) (Free plan works)
- (Optional) A [Crow CI](https://crowci.dev) instance for automated syncs

## Quickstart (Local)

```bash
# 1. Clone the repo
git clone https://codeberg.org/YOU/cf-formulae-mirror.git
cd cf-formulae-mirror

# 2. Install deps
bun install

# 3. Configure environment
cp .env.example .env
# Edit .env with your GITHUB_TOKEN and B2 credentials

# 4. Run a sync
source .env && bun run sync
```

After the sync, your files land in `./dist/` and are uploaded to your B2 bucket.

You can also run just the extraction step without B2 sync:

```bash
source .env && bun run extract
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub PAT (no scopes needed for public repos) |
| `B2_APPLICATION_KEY_ID` | Yes | Backblaze B2 key ID |
| `B2_APPLICATION_KEY` | Yes | Backblaze B2 application key |
| `B2_BUCKET` | Yes | Bucket name (must be globally unique) |
| `B2_ENDPOINT` | No | B2 endpoint (auto-detected from key) |
| `ARTIFACT_API_URL` | No | Override GitHub artifact API URL |
| `OUTPUT_DIR` | No | Output directory (default: `./dist`) |
| `CACHE_DIR` | No | Artifact zip cache dir |

## Cloudflare Setup

See [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) for step-by-step instructions to:

1. Add a CNAME DNS record pointing to your B2 endpoint
2. Configure SSL/TLS to Full (Strict)
3. Create URL Rewrite Transform Rules (bucket scoping + root → index)
4. Set caching headers
5. Verify the setup

## Crow CI Setup

### 1. Instance Setup

Any Crow CI instance with the `clone` plugin works — no heavy deps needed since actual work runs on GitHub Actions.

### 2. Repository Secrets

Add these secrets in **Crow UI → Repository → Settings → Secrets**:

| Secret Name | Value |
|---|---|
| `github_token` | GitHub token with permission to dispatch workflows on the target repo |
| `github_repository` | GitHub repository in `owner/repo` format |
| `forgejo_ssh_key` | SSH private key (PEM format) with push access |
| `forgejo_remote` | SSH remote (e.g. `ssh://git@codeberg.org/ujol/cf-formulae-mirror.git`) |

### 3. Configure Cron Job

In **Crow UI → Repository → Settings → Cron Jobs**:

1. **Add cron job**
2. Name: `cleanup-hidden`
3. Schedule: `0 */2 * * *`
4. Branch: `main`

The pipeline in `.crow/cleanup-hidden.yml` listens for the `cleanup-hidden` cron event and dispatches the GitHub Actions workflow via `gh workflow run`.

### 4. Manual Trigger

You can also trigger the cleanup pipeline manually from **Crow UI → Pipelines → Run pipeline**.

## GitHub Actions Setup

### 1. Repository Secrets

Add these secrets in **GitHub repo → Settings → Secrets and variables → Actions**:

| Secret Name | Value |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT (no scopes needed for public repos) |
| `B2_APPLICATION_KEY_ID` | B2 key ID |
| `B2_APPLICATION_KEY` | B2 application key |
| `B2_BUCKET` | Your B2 bucket name |
| `B2_ENDPOINT` | (optional) Your B2 endpoint |

### 2. Workflow

`.github/workflows/sync.yml` runs on push to `main` (when `src/` changes) and on `workflow_dispatch`.

`.github/workflows/cleanup-hidden.yml` runs on `workflow_dispatch`, uses the same `B2_BUCKET`, `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, and optional `B2_ENDPOINT` env setup as `src/sync.ts`, then executes:

```bash
rclone backend cleanup-hidden "b2:${B2_BUCKET}" --fast-list --checkers 64 --transfers 64 --progress
```

### 3. Manual Trigger

From **GitHub → Actions** choose either workflow (`Sync formulae.brew.sh to B2` or `Cleanup hidden B2 versions`) and click **Run workflow**.

## rclone Configuration (Local Use)

For local runs outside CI, configure rclone:

```bash
rclone config create b2 b2 \
    account YOUR_KEY_ID \
    key YOUR_APPLICATION_KEY

# Verify
rclone ls b2:YOUR_BUCKET_NAME
```

Or copy `rclone.conf.template` to `~/.config/rclone/rclone.conf` and fill in your credentials.

## How It Works

1. **sync.ts** orchestrates the full pipeline: extract + upload
2. **extract.ts** queries the GitHub API for the latest `github-pages` artifact from `Homebrew/formulae.brew.sh` on the `main` branch
3. Downloads the zip (via `nightly.link` first, falls back to GitHub API)
4. Caches the zip locally to avoid re-downloading the same artifact
5. Extracts the inner `artifact.tar` using Bun's native archive support
6. Writes all files to `OUTPUT_DIR` (default: `./dist`)
7. **rclone sync** (via Bun shell) mirrors `OUTPUT_DIR` to the B2 bucket with checksum comparison
8. Cloudflare CDN serves the bucket at your configured domain

## License

Apache 2.0 — see [formulae-mirror](https://codeberg.org/amrkmn/formulae-mirror) for original.
