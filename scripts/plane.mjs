/**
 * Minimal Plane REST client for managing this project's tickets.
 *
 * The API token is read from .env and never printed. Plane's public API is
 * workspace-scoped, so every call needs the workspace slug.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Tolerant of the spacing people actually write in a .env by hand.
export function readEnv() {
    const env = {};

    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const eq = trimmed.indexOf('=');

        if (eq < 0) {
            continue;
        }
        env[trimmed.slice(0, eq).trim()] =
            trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
}

const env = readEnv(),
    TOKEN = env.PLANE_API_TOKEN || env.PLANE_API_KEY || env.PLAN_API_KEY,
    BASE = env.PLANE_API_BASE || 'https://api.plane.so/api/v1';

if (!TOKEN) {
    throw new Error('No Plane API token found in .env');
}

export async function plane(path, {method = 'GET', body} = {}) {
    const response = await fetch(`${BASE}${path}`, {
            method,
            headers: {
                'X-API-Key': TOKEN,
                ...(body ? {'Content-Type': 'application/json'} : {})
            },
            ...(body ? {body: JSON.stringify(body)} : {})
        }),
        text = await response.text();
    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = text.slice(0, 300);
    }
    return {status: response.status, ok: response.ok, data};
}

export {BASE};
