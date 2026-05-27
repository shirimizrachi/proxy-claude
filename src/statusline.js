#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
    try {
        const data = JSON.parse(input);
        const model = data.model?.display_name || '?';
        const dir = path.basename(data.workspace?.current_dir || data.cwd || '');
        const cost = data.cost?.total_cost_usd || 0;
        const pct = Math.floor(data.context_window?.used_percentage || 0);
        const durationMs = data.cost?.total_duration_ms || 0;
        const linesAdded = data.cost?.total_lines_added || 0;
        const linesRemoved = data.cost?.total_lines_removed || 0;

        // ANSI colors
        const CYAN = '\x1b[36m';
        const GREEN = '\x1b[32m';
        const YELLOW = '\x1b[33m';
        const RED = '\x1b[31m';
        const DIM = '\x1b[2m';
        const BOLD = '\x1b[1m';
        const RESET = '\x1b[0m';
        const MAGENTA = '\x1b[35m';

        // --- Git info with caching ---
        const CACHE_FILE = path.join(require('os').tmpdir(), 'claude-statusline-git-cache');
        const CACHE_MAX_AGE = 5; // seconds

        let branch = '', staged = 0, modified = 0, untracked = 0;

        const cacheIsStale = () => {
            if (!fs.existsSync(CACHE_FILE)) return true;
            return (Date.now() / 1000) - fs.statSync(CACHE_FILE).mtimeMs / 1000 > CACHE_MAX_AGE;
        };

        if (cacheIsStale()) {
            try {
                execSync('git rev-parse --git-dir', { stdio: 'ignore' });
                const b = execSync('git branch --show-current', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
                const s = execSync('git diff --cached --numstat', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
                const m = execSync('git diff --numstat', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
                const u = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

                const stagedCount = s ? s.split('\n').filter(Boolean).length : 0;
                const modCount = m ? m.split('\n').filter(Boolean).length : 0;
                const untrackedCount = u ? u.split('\n').filter(Boolean).length : 0;

                fs.writeFileSync(CACHE_FILE, JSON.stringify({ branch: b, staged: stagedCount, modified: modCount, untracked: untrackedCount }));
            } catch {
                fs.writeFileSync(CACHE_FILE, JSON.stringify({ branch: '', staged: 0, modified: 0, untracked: 0 }));
            }
        }

        try {
            const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            branch = cached.branch;
            staged = cached.staged;
            modified = cached.modified;
            untracked = cached.untracked;
        } catch { }

        // --- Format duration ---
        const totalSec = Math.floor(durationMs / 1000);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        const duration = hrs > 0
            ? `${hrs}h ${mins}m`
            : `${mins}m ${secs}s`;

        // --- Context bar with color thresholds ---
        const barColor = pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
        const barWidth = 15;
        const filled = Math.round(pct * barWidth / 100);
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

        // Context emoji
        const ctxEmoji = pct >= 90 ? '🔴' : pct >= 70 ? '🟡' : '🟢';

        // --- Git status string ---
        let gitStr = '';
        if (branch) {
            const parts = [];
            if (staged > 0) parts.push(`${GREEN}+${staged}${RESET}`);
            if (modified > 0) parts.push(`${YELLOW}~${modified}${RESET}`);
            if (untracked > 0) parts.push(`${DIM}?${untracked}${RESET}`);
            const statusParts = parts.length > 0 ? ` ${parts.join(' ')}` : '';
            gitStr = ` ${DIM}|${RESET} 🌿 ${CYAN}${branch}${RESET}${statusParts}`;
        }

        // --- Lines changed ---
        let linesStr = '';
        if (linesAdded > 0 || linesRemoved > 0) {
            linesStr = ` ${DIM}|${RESET} ${GREEN}+${linesAdded}${RESET}${RED}-${linesRemoved}${RESET}`;
        }

        // === LINE 1: Model + Directory + Git ===
        const line1 = `${BOLD}${MAGENTA}${model}${RESET} ${DIM}•${RESET} 📁 ${BOLD}${dir}${RESET}${gitStr}${linesStr}`;

        // === LINE 2: Context bar + Cost + Duration ===
        const line2 = `${ctxEmoji} ${barColor}${bar}${RESET} ${BOLD}${pct}%${RESET} ${DIM}|${RESET} 💰 ${YELLOW}$${cost.toFixed(2)}${RESET} ${DIM}|${RESET} ⏱️  ${DIM}${duration}${RESET}`;

        console.log(line1);
        console.log(line2);
    } catch (e) {
        // Fallback if anything goes wrong
        console.log(`⚠️ statusline error: ${e.message}`);
    }
});
