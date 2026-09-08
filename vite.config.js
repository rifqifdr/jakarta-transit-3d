import {defineConfig, loadEnv} from 'vite';

// The project's .env predates this app and uses a bare MAPBOX_ACCESS_TOKEN
// rather than Vite's VITE_ prefix, so inject it explicitly instead of asking
// the user to rename their variable.
export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), '');

    if (!env.MAPBOX_ACCESS_TOKEN) {
        throw new Error('MAPBOX_ACCESS_TOKEN is missing from .env');
    }

    return {
        define: {
            __MAPBOX_TOKEN__: JSON.stringify(env.MAPBOX_ACCESS_TOKEN)
        },
        server: {port: 5173, open: true},
        build: {target: 'es2022', chunkSizeWarningLimit: 2000}
    };
});
