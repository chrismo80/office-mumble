import { defineConfig } from 'vite';

// Two pages, one build: the office, and the art sheet that shows the furniture and the eight figure styles
// side by side. The sheet is a tool, and a tool that only exists in dev is a tool nobody runs.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        office: 'index.html',
        sheet: 'sheet.html',
      },
    },
  },
});
