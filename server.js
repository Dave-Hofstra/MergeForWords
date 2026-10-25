// Merge for Words Player Sync Server
// A minimal HTTP server for cross-device player data sync
// Zero dependencies — uses only Node.js built-in http + fs
//
// Hardening (for 50+ players):
//  - ATOMIC WRITES: write to players.json.tmp then rename over the live file —
//    a crash mid-write can never leave a truncated players.json.
//  - CORRUPTION SAFETY: if the live file fails to parse, it is quarantined to
//    players.corrupt-<timestamp>.json (never silently treated as empty) and the
//    last known-good backup is loaded instead.
//  - BACKUPS: every successful write also updates players.backup.json
//    (last known-good copy) and a daily snapshot snapshots/players-YYYY-MM-DD.json
//    (newest 30 kept).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3014;
const DATA_DIR = '/app/data';
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const BACKUP_FILE = path.join(DATA_DIR, 'players.backup.json');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
const MAX_SNAPSHOTS = 30;

// Ensure data directory and file exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
if (!fs.existsSync(PLAYERS_FILE)) {
    fs.writeFileSync(PLAYERS_FILE, '{}', 'utf8');
}

function readPlayers() {
    try {
        return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    } catch (e) {
        // Corrupt! Quarantine the bad file (never overwrite it blindly) and try backup
        console.error('[sync] players.json corrupt or unreadable:', e.message);
        quarantineFile(PLAYERS_FILE);
        try {
            const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
            console.error('[sync] recovered from players.backup.json');
            return backup;
        } catch (e2) {
            console.error('[sync] backup also unreadable — starting fresh ({}). Quarantined corrupt files are in ' + DATA_DIR);
            return {};
        }
    }
}

function quarantineFile(file) {
    try {
        if (!fs.existsSync(file)) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(DATA_DIR, 'players.corrupt-' + stamp + '.json');
        fs.renameSync(file, dest);
        console.error('[sync] quarantined corrupt file to', dest);
    } catch (e) {
        console.error('[sync] could not quarantine corrupt file:', e.message);
    }
}

/** Atomic write: tmp file + rename on same filesystem. */
function writePlayers(data) {
    const tmpFile = PLAYERS_FILE + '.tmp';
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpFile, json, 'utf8');
    fs.renameSync(tmpFile, PLAYERS_FILE);
    // Best-effort backups: last known-good copy + daily snapshot
    try {
        fs.copyFileSync(PLAYERS_FILE, BACKUP_FILE);
        snapshot();
    } catch (e) {
        console.error('[sync] backup/snapshot failed:', e.message);
    }
}

/** Daily snapshot snapshots/players-YYYY-MM-DD.json, keep newest MAX_SNAPSHOTS. */
function snapshot() {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const dest = path.join(SNAPSHOT_DIR, 'players-' + day + '.json');
    if (fs.existsSync(dest)) return; // already have today's snapshot
    fs.copyFileSync(PLAYERS_FILE, dest);
    let files = [];
    try { files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.startsWith('players-')).sort(); } catch (e) { return; }
    while (files.length > MAX_SNAPSHOTS) {
        const oldest = files.shift();
        try { fs.unlinkSync(path.join(SNAPSHOT_DIR, oldest)); } catch (e) { /* ignore */ }
    }
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                resolve(null);
            }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, statusCode, data) {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(json);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        sendJSON(res, 200, {});
        return;
    }

    if (pathname === '/api/players') {
        if (req.method === 'GET') {
            // Return all players
            const players = readPlayers();
            sendJSON(res, 200, { players });
        } else if (req.method === 'POST') {
            // Save players (merge incoming with existing)
            const body = await parseBody(req);
            if (!body || !body.players) {
                sendJSON(res, 400, { error: 'No players data' });
                return;
            }
            const existing = readPlayers();
            const incoming = body.players;

            // Merge: incoming overwrites existing for each player
            const merged = { ...existing };
            for (const name of Object.keys(incoming)) {
                if (!merged[name]) {
                    merged[name] = incoming[name];
                } else {
                    // Merge properties, keep the highest wordIndex
                    const prevWordIndex = merged[name].wordIndex;
                    merged[name] = { ...merged[name], ...incoming[name] };
                    if (incoming[name].wordIndex != null && existing[name].wordIndex != null) {
                        merged[name].wordIndex = Math.max(
                            existing[name].wordIndex,
                            incoming[name].wordIndex
                        );
                    }
                    // Only keep wordState from incoming if it's at the same or newer wordIndex
                    if (incoming[name].wordState && merged[name].wordIndex > (prevWordIndex || 0)) {
                        merged[name].wordState = incoming[name].wordState;
                    } else if (incoming[name].wordState && prevWordIndex != null && incoming[name].wordIndex != null && incoming[name].wordIndex >= prevWordIndex) {
                        merged[name].wordState = incoming[name].wordState;
                    } else if (existing[name].wordState && (!incoming[name].wordState || (incoming[name].wordIndex != null && prevWordIndex != null && incoming[name].wordIndex < prevWordIndex))) {
                        // incoming is stale — keep the existing wordState
                        merged[name].wordState = existing[name].wordState;
                    }
                }
            }

            writePlayers(merged);
            sendJSON(res, 200, { success: true });
        } else {
            sendJSON(res, 405, { error: 'Method not allowed' });
        }
    } else {
        sendJSON(res, 404, { error: 'Not found' });
    }
});

// Take a snapshot at startup so today's file exists even before the first write
try { snapshot(); } catch (e) { /* ignore */ }

server.listen(PORT, '0.0.0.0', () => {
    console.log(`MergingGame sync server running on port ${PORT}`);
});
