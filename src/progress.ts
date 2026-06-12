const IS_TTY: boolean = (() => {
    if (!process.stdout.isTTY) return false;
    if (process.env.TERM === "dumb") return false;
    if (process.env.CI === "true" || process.env.CI === "1") return false;
    const ciVars = [
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "CIRCLECI",
        "TRAVIS",
        "JENKINS_HOME",
        "BUILDKITE",
        "DRONE",
        "RENDER",
        "CF_PAGES",
        "VERCEL",
    ] as const;
    return ciVars.every((k) => !process.env[k]);
})();

const toMiB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

type ProgressMode = "bytes" | "count";

export class Progress {
    private startTime = 0;
    private startBytes = 0;
    private prev = 0;
    private lastRender = 0;
    private readonly milestones = new Set<number>();

    constructor(
        private readonly label: string,
        private readonly total: number,
        private readonly mode: ProgressMode,
    ) {}

    start(initialBytes = 0): void {
        this.startTime = Date.now();
        this.startBytes = initialBytes;
        this.prev = initialBytes;
        this.lastRender = 0;
        this.milestones.clear();
        if (!IS_TTY) console.log(`  ${this.fmt(initialBytes, 0)}`);
    }

    update(raw: number): void {
        const current = this.total > 0 ? Math.min(raw, this.total) : raw;
        const pct =
            this.total > 0 ? Math.floor((current / this.total) * 100) : 0;
        const done = this.total > 0 && raw >= this.total;
        const showSpeed = this.mode === "bytes";

        if (IS_TTY) {
            const withinStep = raw - this.prev < Math.max(1, this.total * 0.01);
            const tooSoon = Date.now() - this.lastRender < 1000;
            if (!done && withinStep && tooSoon) return;

            this.prev = raw;
            this.lastRender = Date.now();
            process.stdout.write(
                `\r\x1b[2K  ${this.fmt(current, pct, showSpeed)}`,
            );
            if (done) process.stdout.write("\n");
        } else if (done) {
            console.log(`  ${this.fmt(current, 100, showSpeed)}`);
        } else {
            const m = Math.floor(pct / 10) * 10;
            if (m > 0 && !this.milestones.has(m)) {
                this.milestones.add(m);
                console.log(`  ${this.fmt(current, m)}`);
            }
        }
    }

    private fmt(current: number, pct: number, showSpeed = false): string {
        if (this.mode === "count") {
            return `${this.label} ${current}/${this.total} (${pct}%)`;
        }

        const base = `${this.label} ${toMiB(current)}/${toMiB(this.total)} MiB (${pct}%)`;
        if (!showSpeed) return base;

        const elapsed = (Date.now() - this.startTime) / 1000;
        const done = Math.max(0, current - this.startBytes);
        const speed = elapsed > 0 ? toMiB(done / elapsed) : "0.0";
        return `${base} ${speed} MiB/s`;
    }
}
