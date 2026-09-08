import {defineConfig, loadEnv} from 'vite';

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

    return {
        define: {
            __MAPBOX_TOKEN__: JSON.stringify(token)
        },
        server: {port: 5173, open: true},
        build: {target: 'es2022', chunkSizeWarningLimit: 2000}
    };
});
