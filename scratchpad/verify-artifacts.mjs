/**
 * Asks an origin whether it actually serves the artifacts compressed.
 *
 *   node scratchpad/verify-artifacts.mjs                          # wrangler dev
 *   node scratchpad/verify-artifacts.mjs https://site.example/    # a live host
 *
 * Every `.bin` in the manifest is fetched as its `.br` alias and measured
 * against the byte count the manifest promises. That is not an arbitrary
 * check: it is the loader's own fallback trigger, so this asks exactly the
 * question the browser asks, and a host that fails here is a host where every
 * visitor pays sixteen wasted round trips.
 *
 * Written for JAKAR-61, where Netlify honoured the `Content-Encoding` declared
 * in `public/_headers` and Cloudflare dropped it. Neither host announces which
 * it does; the only way to know is to ask, which is what this does.
 *
 * Two things it will not tell you, both learned the hard way:
 *
 * - **A correct header is not a correct body.** `Content-Encoding: br` over a
 *   double-compressed body decodes to noise and looks fine in a header dump.
 *   This inflates and measures instead, which is why it reports length rather
 *   than status.
 * - **Do not run it against a deploy that is still rolling out.** Immediately
 *   after a Workers deploy this reported all sixteen artifacts wrong, and
 *   minutes later reported all sixteen correct with nothing changed in
 *   between; requests in the two runs landed in different colos. Give a deploy
 *   a couple of minutes and re-run before believing a failure.
 */
const ORIGIN = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    manifest = await (await fetch(`${ORIGIN}/artifacts/manifest.json`)).json(),
    entries = [];

// The manifest nests per mode, so walk it rather than assuming a shape.
JSON.stringify(manifest, (key, value) => {
    if (value && typeof value === 'object' && typeof value.file === 'string' &&
            value.file.endsWith('.bin')) {
        entries.push(value);
    }
    return value;
});

let wire = 0,
    decoded = 0,
    bad = 0;

for (const entry of entries) {
    const response = await fetch(`${ORIGIN}/artifacts/${entry.file}.br`),
        encoding = response.headers.get('content-encoding'),
        // fetch() inflates transparently when the encoding is declared and
        // honoured, so what arrives here is the decoded length — the same
        // number the loader compares against the manifest.
        body = Buffer.from(await response.arrayBuffer());

    wire += entry.brotli;
    decoded += entry.bytes;

    if (encoding !== 'br' || body.byteLength !== entry.bytes) {
        bad++;
        console.log(`  MISMATCH ${entry.file}  encoding=${encoding} ` +
            `got=${body.byteLength} want=${entry.bytes}`);
    }
}

console.log(`origin                 : ${ORIGIN}`);
console.log(`.bin artifacts checked : ${entries.length}`);
console.log(`served brotli, correct : ${bad === 0 ? 'YES' : `NO — ${bad} of ${entries.length}`}`);
console.log(`on the wire            : ${(wire / 1024).toFixed(0)} KB`);
console.log(`decoded                : ${(decoded / 1024).toFixed(0)} KB`);
console.log(`saved per visit        : ${((decoded - wire) / 1024).toFixed(0)} KB`);

process.exit(bad === 0 ? 0 : 1);
