/**
 * Says whether the Mapbox token will actually work, before a deploy rather
 * than after one.
 *
 * A token can fail in three ways that look identical from the browser — the
 * map simply never paints and the console says 401 — and each has a different
 * fix. Guessing between them costs a deploy cycle per guess, which is how this
 * script came to exist.
 *
 *   npm run check-token
 *   npm run check-token -- https://example.netlify.app https://x.workers.dev
 *
 * With origins given it also sends each one as a Referer, which is what a URL
 * restriction is checked against. A token that passes bare and fails from an
 * origin is restricted, not broken.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'),
    STYLE = 'https://api.mapbox.com/styles/v1/mapbox/standard?sdk=js-3.30.0';

function tokenFromEnv() {
    if (process.env.MAPBOX_ACCESS_TOKEN) {
        return process.env.MAPBOX_ACCESS_TOKEN;
    }

    try {
        for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
            const eq = line.indexOf('=');

            if (eq > 0 && line.slice(0, eq).trim() === 'MAPBOX_ACCESS_TOKEN') {
                return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            }
        }
    } catch {
        // No .env. On a build host there is not supposed to be one.
    }
    return '';
}

const token = tokenFromEnv(),
    origins = process.argv.slice(2);

// Nothing here ever prints the token. It is public by design — it ships in the
// bundle — but a token in a terminal transcript is a token in a screenshot.
if (!token) {
    console.log('FAIL  no MAPBOX_ACCESS_TOKEN in the environment or .env');
    process.exit(1);
}

if (!token.startsWith('pk.')) {
    console.log(`FAIL  token starts with "${token.slice(0, 3)}", not "pk."`);
    console.log('      Mapbox GL needs a public token; a secret one shipped in');
    console.log('      a browser bundle is a published secret. Revoke it.');
    process.exit(1);
}

// `/tokens/v2` is the only thing that distinguishes revoked from restricted:
// both answer 401 everywhere else, and the browser cannot tell them apart.
const status = await fetch(`https://api.mapbox.com/tokens/v2?access_token=${token}`),
    body = await status.json().catch(() => ({}));

console.log(`token   ${body.token?.usage ?? '?'}.…  user ${body.token?.user ?? '?'}`);
console.log(`status  ${body.code ?? status.status}`);

if (body.code !== 'TokenValid') {
    console.log('');
    console.log(body.code === 'TokenRevoked'
        ? 'FAIL  This token has been revoked. Create a new one — keeping the\n' +
          '      default public scopes — and set it on every host that builds.'
        : 'FAIL  Mapbox will not accept this token.');
    process.exit(1);
}

let failed = 0;

// A bare request and an origin request are different questions. The first asks
// whether the token exists; the second asks whether it is allowed to be used
// from where the site is actually served.
for (const origin of ['', ...origins]) {
    const response = await fetch(`${STYLE}&access_token=${token}`, {
            headers: origin ? {Referer: origin.endsWith('/') ? origin : `${origin}/`} : {}
        }),
        label = origin || '(no Referer)';

    console.log(`${response.ok ? 'ok  ' : 'FAIL'}  ${response.status}  ${label}`);
    if (!response.ok) {
        failed++;
    }
}

if (failed) {
    console.log('');
    console.log('A token that is valid but fails from an origin is URL-restricted.');
    console.log('Add that origin in the Mapbox token settings, or clear the');
    console.log('restriction to confirm that is what it is.');
}
process.exit(failed ? 1 : 0);
