import { randomBytes } from 'crypto';
export function generateId(prefix = '') {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');
    return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function formatJPY(amount) {
    return `¥${amount.toLocaleString('ja-JP')}`;
}
export function formatDate(date) {
    return date.toISOString().split('T')[0];
}
export function formatDateTime(date) {
    return date.toISOString().replace('T', ' ').replace('Z', '');
}
export function parseDate(dateStr) {
    return new Date(dateStr);
}
export function daysBetween(date1, date2) {
    const diffTime = Math.abs(date2.getTime() - date1.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}
export function isToday(date) {
    const today = new Date();
    return formatDate(date) === formatDate(today);
}
export function getMonthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
export function retry(fn, maxAttempts = 3, delayMs = 1000, backoffMultiplier = 2) {
    return new Promise(async (resolve, reject) => {
        let lastError;
        let currentDelay = delayMs;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await fn();
                resolve(result);
                return;
            }
            catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    await sleep(currentDelay);
                    currentDelay *= backoffMultiplier;
                }
            }
        }
        reject(lastError);
    });
}
export function truncate(str, maxLength) {
    if (str.length <= maxLength)
        return str;
    return str.slice(0, maxLength - 3) + '...';
}
export function safeJsonParse(json, defaultValue) {
    try {
        return JSON.parse(json);
    }
    catch {
        return defaultValue;
    }
}
export function pick(obj, keys) {
    const result = {};
    for (const key of keys) {
        if (key in obj) {
            result[key] = obj[key];
        }
    }
    return result;
}
export function omit(obj, keys) {
    const result = { ...obj };
    for (const key of keys) {
        delete result[key];
    }
    return result;
}
export function debounce(fn, delayMs) {
    let timeoutId = null;
    return (...args) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            fn(...args);
            timeoutId = null;
        }, delayMs);
    };
}
export function throttle(fn, limitMs) {
    let lastCall = 0;
    return (...args) => {
        const now = Date.now();
        if (now - lastCall >= limitMs) {
            lastCall = now;
            fn(...args);
        }
    };
}
export function groupBy(items, keyFn) {
    const result = {};
    for (const item of items) {
        const key = keyFn(item);
        if (!result[key]) {
            result[key] = [];
        }
        result[key].push(item);
    }
    return result;
}
export function sum(numbers) {
    return numbers.reduce((acc, n) => acc + n, 0);
}
export function average(numbers) {
    if (numbers.length === 0)
        return 0;
    return sum(numbers) / numbers.length;
}
export function percentile(numbers, p) {
    if (numbers.length === 0)
        return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}
//# sourceMappingURL=utils.js.map