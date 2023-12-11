#!/usr/bin/env node
const { run } = require('..');
(async () => {
  await run();
})().catch((err) => console.error(err));
