import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: { '@': path.resolve(__dirname, './src') },
        // одна копия React для всего графа (react-quill-new иначе тянет свою в dev-оптимайзере)
        dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
    },
    optimizeDeps: { include: ['react-quill-new', 'quill'] },
    server: { port: 5175, open: true },
});
