import fs from 'fs';
import path from 'path';

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function safeNumber(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function listFiles(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs.readdirSync(dirPath)
        .map((name) => {
            const filePath = path.join(dirPath, name);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) return null;
                return {
                    name,
                    filePath,
                    stat,
                    mtimeMs: stat.mtimeMs,
                    size: stat.size
                };
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);
}

function pruneOldest(files, maxCount) {
    if (!Number.isFinite(maxCount) || maxCount <= 0 || files.length <= maxCount) {
        return [];
    }

    return files
        .slice()
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .slice(0, Math.max(0, files.length - maxCount));
}

function pruneByAge(files, maxAgeDays, nowMs) {
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
        return [];
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    return files.filter((file) => (nowMs - file.mtimeMs) > maxAgeMs);
}

function removeFiles(files) {
    let removed = 0;
    for (const file of files) {
        try {
            if (fs.existsSync(file.filePath)) {
                fs.rmSync(file.filePath, { force: true });
                removed += 1;
            }
        } catch (_) {
            // noop
        }
    }
    return removed;
}

export function sanitizeAuthStateDir(dirPath, options = {}) {
    ensureDir(dirPath);

    const nowMs = Date.now();
    const sessionMaxAgeDays = safeNumber(
        options.sessionMaxAgeDays ?? process.env.WA_SESSION_MAX_AGE_DAYS,
        14
    );
    const senderKeyMaxAgeDays = safeNumber(
        options.senderKeyMaxAgeDays ?? process.env.WA_SENDER_KEY_MAX_AGE_DAYS,
        14
    );
    const sessionMaxFiles = safeNumber(
        options.sessionMaxFiles ?? process.env.WA_SESSION_MAX_FILES,
        2500
    );
    const senderKeyMaxFiles = safeNumber(
        options.senderKeyMaxFiles ?? process.env.WA_SENDER_KEY_MAX_FILES,
        800
    );

    const files = listFiles(dirPath);
    const zeroByteFiles = files.filter((file) => file.size === 0);
    const sessionFiles = files.filter((file) => file.name.startsWith('session-'));
    const senderKeyFiles = files.filter((file) => file.name.startsWith('sender-key-'));

    const toRemove = new Map();
    for (const file of zeroByteFiles) toRemove.set(file.filePath, file);
    for (const file of pruneByAge(sessionFiles, sessionMaxAgeDays, nowMs)) toRemove.set(file.filePath, file);
    for (const file of pruneByAge(senderKeyFiles, senderKeyMaxAgeDays, nowMs)) toRemove.set(file.filePath, file);
    for (const file of pruneOldest(sessionFiles.filter((file) => !toRemove.has(file.filePath)), sessionMaxFiles)) toRemove.set(file.filePath, file);
    for (const file of pruneOldest(senderKeyFiles.filter((file) => !toRemove.has(file.filePath)), senderKeyMaxFiles)) toRemove.set(file.filePath, file);

    const removed = removeFiles(Array.from(toRemove.values()));

    return {
        dirPath,
        totalFiles: files.length,
        sessionFiles: sessionFiles.length,
        senderKeyFiles: senderKeyFiles.length,
        zeroByteFiles: zeroByteFiles.length,
        removedFiles: removed,
        remainingFiles: Math.max(0, files.length - removed),
        sessionMaxAgeDays,
        senderKeyMaxAgeDays,
        sessionMaxFiles,
        senderKeyMaxFiles
    };
}

export function removeBrokenSessionFiles(dirPath, sessionIds = []) {
    ensureDir(dirPath);

    const normalized = Array.from(new Set(
        sessionIds
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    ));

    let removed = 0;
    for (const sessionId of normalized) {
        const filePath = path.join(dirPath, `session-${sessionId}.json`);
        try {
            if (fs.existsSync(filePath)) {
                fs.rmSync(filePath, { force: true });
                removed += 1;
            }
        } catch (_) {
            // noop
        }
    }

    return {
        dirPath,
        removed,
        sessionIds: normalized
    };
}

export function refreshAuthBackup(authDirPath, backupDirPath, options = {}) {
    ensureDir(authDirPath);
    if (fs.existsSync(backupDirPath)) {
        fs.rmSync(backupDirPath, { recursive: true, force: true });
    }
    fs.cpSync(authDirPath, backupDirPath, { recursive: true });
    const hygiene = sanitizeAuthStateDir(backupDirPath, options);
    return {
        backupDirPath,
        ...hygiene
    };
}
