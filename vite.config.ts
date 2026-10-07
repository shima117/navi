import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const page = (name: string) => fileURLToPath(new URL(`./src/renderer/${name}.html`, import.meta.url));

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: page('index'),
        avatar: page('avatar'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
