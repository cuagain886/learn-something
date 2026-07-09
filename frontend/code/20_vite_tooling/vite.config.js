import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 3000,
        open: true,  // 自动打开浏览器
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
});
