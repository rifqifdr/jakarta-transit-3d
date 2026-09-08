import {defineConfig, loadEnv} from 'vite';

/**
 * Serves `*.bin.br` the way the CDNs are asked to, so dev, preview and
 * production take the same path through the artifact loader.
 *
 * Without this the loader's brotli request succeeds locally and hands back
 * raw compressed bytes, which are the wrong length, which trips its own guard
 * and quietly costs a second request on every file — working, twice as slow,
 * and different from production. Divergence between the two is worth more
 * than the twelve lines.
 */
function precompressedArtifacts() {
    const middleware = (req, res, next) => {
        if (req.url && req.url.split('?')[0].endsWith('.bin.br')) {
            res.setHeader('Content-Encoding', 'br');
            res.setHeader('Content-Type', 'application/octet-stream');
        }
        next();
    };

    return {
        name: 'precompressed-artifacts',
        // Block bodies, deliberately. `middlewares.use()` returns the connect
        // app, which is itself a function — and a function returned from
        // either of these hooks is treated as a post-hook and called with no
        // arguments, which crashes the server before it listens.
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        }
    };
}

// The project's .env predates this app and uses a bare MAPBOX_ACCESS_TOKEN
// rather than Vite's VITE_ prefix, so inject it explicitly instead of asking
// the user to rename their variable.
//
// `loadEnv` with an empty prefix reads the process environment as well as the
// .env file, which is how a build host supplies it — there is no .env on one.
// `process.env` is still consulted directly as a belt-and-braces fallback,
// because the failure is a build that dies before it starts.
export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), ''),
        token = env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_ACCESS_TOKEN;

    // Worth the paragraph: this message is the only thing a person sees in a
    // build log, and "missing from .env" sends them looking for a file that
    // is not supposed to exist on a build host.
    if (!token) {
        throw new Error([
            'MAPBOX_ACCESS_TOKEN is not set.',
            '  Locally:  copy .env.example to .env and put a token in it.',
            '  On a host: set it as a BUILD environment variable, not a',
            '            runtime one — on Cloudflare Pages those are two',
            '            different screens, and only the build one is visible',
            '            here. It must also exist before the build runs: the',
            '            deployment Cloudflare fires the moment a repository',
            '            is connected happens before you can add anything, so',
            '            retry that one after saving the variable.',
            '  The token is compiled into the bundle, so a deployed site wants',
            '  its own public token with a URL restriction, not the dev one.'
        ].join('\n'));
    }

    // A secret token in a browser bundle is a published secret: the bundle is
    // 2.4 MB of world-readable JavaScript on a CDN. Mapbox GL rejects `sk.`
    // tokens at runtime, but by then the token has already shipped — the error
    // in the console is the *second* thing that went wrong. Failing the build
    // is the only place this can still be caught.
    //
    // A token turns secret the moment any secret scope is ticked while
    // creating it (`tokens:write`, `uploads:write`, `styles:write`,
    // `downloads:read`). The public default scopes are what this needs.
    if (!token.startsWith('pk.')) {
        throw new Error([
            `MAPBOX_ACCESS_TOKEN starts with "${token.slice(0, 3)}", not "pk.".`,
            '  Mapbox GL needs a PUBLIC token. This one is compiled into a',
            '  browser bundle that anyone can download, so shipping a secret',
            '  token publishes it — revoke it rather than only replacing it.',
            '  Create a new token keeping the default public scopes only, and',
            '  give it a URL restriction for the deployed domain.'
        ].join('\n'));
    }

    return {
        plugins: [precompressedArtifacts()],
        define: {
            __MAPBOX_TOKEN__: JSON.stringify(token)
        },
        server: {port: 5173, open: true},
        build: {target: 'es2022', chunkSizeWarningLimit: 2000}
    };
});
