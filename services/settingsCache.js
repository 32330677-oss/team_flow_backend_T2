const db = require('../config/db'); // حسب مسار قاعدة البيانات عندك

// ---------------------------------------------------------------------------
// Current values (system_settings) — unchanged behavior.
// Phase 2 / D3: plus dated values (system_settings_history) so historical
// calculations use the value that applied on the record's date.
// ---------------------------------------------------------------------------

let cache = null;
let historyCache = null;
let isLoading = null;

// The start used for the "legacy" row written on the first versioned change:
// the value that was in effect before any dated history existed.
const LEGACY_START = '1000-01-01';

async function loadFromDb() {
    const [rows] = await db.execute(
        'SELECT setting_key, setting_value FROM system_settings'
    );
    const map = {};
    for (const row of rows) {
        map[row.setting_key] = row.setting_value;
    }

    let history = [];
    try {
        const [historyRows] = await db.execute(
            `SELECT setting_key, setting_value, effective_from, effective_to
             FROM system_settings_history
             ORDER BY setting_key, effective_from`
        );
        history = historyRows.map((r) => ({
            key: r.setting_key,
            value: r.setting_value,
            from: String(r.effective_from).slice(0, 10),
            to: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
        }));
    } catch (error) {
        // Table not migrated yet: behave exactly like before Phase 2.
        if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }
    return { map, history };
}

// جلب الإعداد (مع قيمة افتراضية احتياطية)
async function getSetting(key, fallback) {
    if (!cache) await refresh();
    return cache[key] !== undefined ? cache[key] : fallback;
}

/**
 * Value of a setting on a given business date (YYYY-MM-DD).
 * A dated history row covering the date wins; otherwise the current value
 * (pre-Phase-2 behavior); otherwise the fallback.
 */
async function getSettingForDate(key, date, fallback) {
    if (!cache) await refresh();
    const day = date ? String(date).slice(0, 10) : null;
    if (day && historyCache) {
        const row = historyCache.find((h) =>
            h.key === key && h.from <= day && (!h.to || h.to >= day));
        if (row) return row.value;
    }
    return cache[key] !== undefined ? cache[key] : fallback;
}

/**
 * D3 (final decision): the value of an EXPLICIT dated change covering the date,
 * or null. The automatic legacy row (effective_from = LEGACY_START, the value
 * that was current before dated history existed) is not explicit history.
 */
async function getExplicitSettingForDate(key, date) {
    if (!cache) await refresh();
    const day = date ? String(date).slice(0, 10) : null;
    if (!day || !historyCache) return null;
    const row = historyCache.find((h) =>
        h.key === key && h.from !== LEGACY_START && h.from <= day && (!h.to || h.to >= day));
    return row ? row.value : null;
}

// تحديث الـ Cache فوراً بعد أي تعديل من الأدمن
async function refresh() {
    if (isLoading) return isLoading;
    isLoading = loadFromDb().then(({ map, history }) => {
        cache = map;
        historyCache = history;
        isLoading = null;
        return map;
    }).catch((error) => {
        isLoading = null;
        throw error;
    });
    return isLoading;
}

/**
 * Writes a dated setting change inside the caller's transaction.
 * effectiveFrom is inclusive. A same-day second change updates that day's row.
 */
async function recordSettingChange(executor, { key, oldValue, newValue, effectiveFrom, reason, userId }) {
    const [openRows] = await executor.execute(
        `SELECT setting_history_id, effective_from
         FROM system_settings_history
         WHERE setting_key = ? AND effective_to IS NULL
         ORDER BY effective_from DESC LIMIT 1 FOR UPDATE`,
        [key]
    );

    const dayBefore = (d) => {
        const [y, m, dd] = d.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
    };

    if (openRows.length > 0) {
        const openFrom = String(openRows[0].effective_from).slice(0, 10);
        if (openFrom === effectiveFrom) {
            await executor.execute(
                `UPDATE system_settings_history
                 SET setting_value = ?, reason = ?, changed_by_user_id = ?
                 WHERE setting_history_id = ?`,
                [String(newValue), reason || null, userId || null, openRows[0].setting_history_id]
            );
            return;
        }
        if (effectiveFrom < openFrom) {
            const error = new Error(`effective_from must be on or after ${openFrom} for ${key}.`);
            error.isOperational = true;
            throw error;
        }
        await executor.execute(
            'UPDATE system_settings_history SET effective_to = ? WHERE setting_history_id = ?',
            [dayBefore(effectiveFrom), openRows[0].setting_history_id]
        );
    } else if (oldValue !== undefined && oldValue !== null && effectiveFrom > LEGACY_START) {
        await executor.execute(
            `INSERT INTO system_settings_history
               (setting_key, setting_value, effective_from, effective_to, reason, changed_by_user_id)
             VALUES (?, ?, ?, ?, 'Value in effect before dated history existed', ?)`,
            [key, String(oldValue), LEGACY_START, dayBefore(effectiveFrom), userId || null]
        );
    }

    await executor.execute(
        `INSERT INTO system_settings_history
           (setting_key, setting_value, effective_from, effective_to, reason, changed_by_user_id)
         VALUES (?, ?, ?, NULL, ?, ?)`,
        [key, String(newValue), effectiveFrom, reason || null, userId || null]
    );
}

module.exports = { getSetting, getSettingForDate, getExplicitSettingForDate, refresh, recordSettingChange, LEGACY_START };
