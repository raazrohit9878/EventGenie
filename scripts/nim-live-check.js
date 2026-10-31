require('dotenv').config();
const { createNimCompletion, isNimConfigured } = require('../server/nvidia');

(async () => {
  if (!isNimConfigured()) {
    console.error('Live NVIDIA NIM check skipped: configure NVIDIA_API_KEY and NVIDIA_MODEL in the backend .env first.');
    process.exitCode = 2;
    return;
  }
  const model = process.env.NVIDIA_MODEL.trim();
  const result = await createNimCompletion({ messages: [{ role: 'user', content: 'Reply with exactly: NVIDIA NIM connection verified.' }] });
  if (!result.ok) {
    console.error(`NVIDIA NIM live check failed (${result.code}${result.upstreamStatus ? `, upstream HTTP ${result.upstreamStatus}` : ''}): ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`NVIDIA NIM live check succeeded. Configured model: ${model}. Response model: ${result.model}.`);
  console.log(result.content);
})().catch(err => {
  console.error(`NVIDIA NIM live check failed: ${err.message}`);
  process.exitCode = 1;
});
