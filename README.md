# cf-formulae-mirror

Mirrors [formulae.brew.sh](https://formulae.brew.sh) using **Backblaze B2 + Cloudflare CDN**.

No servers to maintain. Zero egress fees (Bandwidth Alliance). Updates automatically via Forgejo Actions + GitHub Actions.

## Architecture

```
Forgejo Actions (cron, every 20 min)        GitHub Actions (on push)
  Homebrew/formulae.brew.sh ──▶ .version ──▶  extract.ts ──▶ rclone sync ──▶ B2 bucket
                                                                                 │
                                                                            Cloudflare CDN
                                                                                 │
                                                                    formulae.yourdomain.com
```

A scheduled Forgejo workflow polls Homebrew's latest `github-pages` artifact and bumps `.version` when it changes. That push triggers the GitHub Actions workflow, which extracts and syncs the files to B2.

- **extract.ts**: Downloads the latest `github-pages` artifact from the Homebrew repo, extracts all static files
- **rclone**: Syncs extracted files to a public Backblaze B2 bucket with checksums
- **Cloudflare**: Serves the bucket through CDN (CNAME + Transform Rules)

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- [rclone](https://rclone.org) ≥ 1.74
- A [Backblaze B2](https://www.backblaze.com/b2/cloud-storage.html) account
- A domain on [Cloudflare](https://dash.cloudflare.com/) (Free plan works)
- (Optional) A [Forgejo](https://forgejo.org) instance with Actions enabled for scheduled checks

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
| `B2_BUCKET` | Yes | B2 target, e.g. `bucket` or `bucket/prefix` |
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

## Forgejo Actions Setup

A scheduled workflow on your Forgejo instance detects new artifacts and rolls `.version` forward. The resulting push triggers the actual B2 sync on GitHub Actions, so the Forgejo runner only needs to reach the GitHub API and push back to this repo.

### 1. Workflow

`.forgejo/workflows/check.yml` runs on a `*/20` minute cron (and `workflow_dispatch`). It queries the latest `github-pages` artifact from `Homebrew/formulae.brew.sh`, writes its ID to `.version` when changed, and commits + pushes.

### 2. Repository Secrets

Add these secrets in **Forgejo → Repo → Settings → Actions → Secrets**:

| Secret Name | Value |
|---|---|
| `GH_TOKEN` | GitHub PAT (no scopes needed for public repos) |
| `SSH_KEY` | SSH private key (PEM format) with push access to this repo |

### 3. Manual Trigger

Run the `Check formulae artifact` workflow from **Forgejo → Actions → Run workflow**.

## GitHub Actions Setup

### 1. Repository Secrets

Add these secrets in **GitHub repo → Settings → Secrets and variables → Actions**:

| Secret Name | Value |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT (no scopes needed for public repos) |
| `B2_APPLICATION_KEY_ID` | B2 key ID |
| `B2_APPLICATION_KEY` | B2 application key |
| `B2_BUCKET` | Your B2 target (`bucket` or `bucket/prefix`) |
| `B2_ENDPOINT` | (optional) Your B2 endpoint |

### 2. Workflow

.github/workflows/sync.yml` runs on push to `main` (when `src/` changes) and on `workflow_dispatch`. After each successful sync, it automatically runs `rclone cleanup` to purge hidden file versions from B2 — so no separate cleanup workflow is needed.

### 3. Manual Trigger

From **GitHub → Actions** choose the `Sync formulae.brew.sh to B2` workflow and click **Run workflow**.

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
