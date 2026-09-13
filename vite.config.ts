import { defineConfig } from 'vite';

// GitHub Pages 把项目页部署在 https://<user>.github.io/<repo>/ 下，
// 所以 base 必须是 "/<repo>/"。CI 里 GITHUB_REPOSITORY 形如 "owner/repo"。
// 本地和线上用同一个 base，避免"本地好端端的、线上白屏"。
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'kws_custom_commands';

export default defineConfig({
  base: `/${repo}/`,
  build: {
    target: 'es2022',
    // 模型与 wasm 都是 public/ 下的静态资源，不参与打包，
    // 这里只调大告警阈值免得吓人。
    chunkSizeWarningLimit: 2048,
  },
  server: {
    port: 5173,
  },
});
