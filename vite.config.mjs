import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [tailwindcss()],
  build: {
    outDir: 'frontend-dist', emptyOutDir: true,
    lib: { entry: 'frontend/main.jsx', name: 'PicGenFrontend', formats: ['iife'], fileName: () => 'picgen-ui.js', cssFileName: 'picgen-ui' },
    sourcemap: false,
  },
});
