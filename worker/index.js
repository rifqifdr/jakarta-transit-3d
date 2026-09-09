/**
 * Cloudflare Workers: put back the Content-Encoding the asset server strips.
 *
 * `npm run transform` writes a brotli `.br` beside every artifact and the
 * loader asks for those instead of the `.bin`, because no CDN will compress
 * `application/octet-stream` on its own — `shapes-bus` is 1,299 KB raw against
 * 248 KB brotli. Declaring the encoding in `public/_headers` is enough on
 * Netlify. Cloudflare's static asset server applies every other rule in that
 * same block and drops this one, so the artifacts went out raw: 2,120 KB a
 * visit against Netlify's 643 KB, for the same map (JAKAR-61).
 *
 * No header fixes it, because the runtime — not the `_headers` file — is what
 * re-encodes a body. `encodeBody: 'manual'` is the documented way to say
 * "these bytes are already encoded, pass them through", and it is only
 * reachable from a Worker script. Hence this file, and hence `main` in
 * `wrangler.jsonc`.
 *
 * `run_worker_first` scopes it to `/artifacts/*`, so that is the only kind of
 * request reaching JavaScript at all. The document, the Vite bundle and the
 * legacy `/data/` files are still served by the asset server with no Worker
 * invocation, exactly as when there was no script here.
 */
export default {

    async fetch(request, env) {
        // Straight to the asset server. This does not re-enter the Worker, so
        // there is no recursion to guard against.
        const response = await env.ASSETS.fetch(request);

        if (!isCompressedAlias(request, response)) {
            return response;
        }

        const headers = new Headers(response.headers);

        headers.set('Content-Encoding', 'br');
        headers.set('Content-Type', 'application/octet-stream');

        // Cloudflare concatenates the Cache-Control of every `_headers` rule
        // that matches, and two of them match a `.br` — its own rule and the
        // `shapes-*` prefix — so it arrives as the same directives twice over:
        // `max-age=31536000, immutable, max-age=31536000, immutable`. Harmless
        // to parse and alarming to read, and this is the one host that does
        // it, so it is normalised here rather than by contorting `_headers`
        // into rules that cannot overlap. Netlify never sees this file.
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');

        // `manual` is the whole point: without it the runtime treats the body
        // as plain and compresses it to match the header just set, shipping
        // brotli inside brotli, which decodes to noise.
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
            encodeBody: 'manual'
        });
    }
};

/**
 * The pre-compressed aliases, and only when there is a body to re-label. A 304
 * carries none, and re-encoding one answers a question nobody asked.
 *
 * Deliberately *not* also testing `Accept-Encoding` for `br`. The obvious
 * guard — only claim brotli if the client admits to taking it — cannot be
 * written here: the runtime rewrites the header to a constant `br, gzip`
 * before the Worker sees it, so the test passes for a client that sent `gzip`
 * alone and for one that sent nothing at all. Measured against `wrangler dev`,
 * not assumed. A check that cannot fail is worse than no check, because the
 * next person reads it as protection — traps 10 and 11 in CLAUDE.md are the
 * same shape.
 *
 * Nothing is riding on it. Brotli's floor (Chrome 50, Safari 11) is far below
 * the es2022 floor this bundle is built to, so anything that can run the app
 * can inflate the artifact — and if one somehow cannot, the loader's length
 * guard rejects the body and refetches the plain `.bin`, which is exactly what
 * every Cloudflare visitor does today.
 */
function isCompressedAlias(request, response) {
    return response.ok
        && response.body !== null
        && new URL(request.url).pathname.endsWith('.br');
}
