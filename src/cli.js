#!/usr/bin/env node

const { searchByChannel } = require("./search");

function parseArgs(argv) {
  const args = {
    channel: "tiktok",
    keyword: "",
    limit: 100,
    headed: true,
    out: "",
    chromeProfileName: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--keyword" || arg === "-k") && argv[i + 1]) {
      args.keyword = argv[i + 1];
      i += 1;
    } else if ((arg === "--channel" || arg === "-c") && argv[i + 1]) {
      args.channel = String(argv[i + 1] || "").trim().toLowerCase() || "tiktok";
      i += 1;
    } else if (arg === "--chrome-profile" && argv[i + 1]) {
      args.chromeProfileName = String(argv[i + 1] || "").trim();
      i += 1;
    } else if ((arg === "--limit" || arg === "-n") && argv[i + 1]) {
      args.limit = Number(argv[i + 1]) === 10 ? 10 : 100;
      i += 1;
    } else if (arg === "--headless") {
      args.headed = false;
    } else if ((arg === "--out" || arg === "-o") && argv[i + 1]) {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Traffic intercept search CLI

Usage:
  npm run search -- --channel tiktok --keyword "pinjaman online indonesia" --limit 100

Options:
  -c, --channel   Search channel, supports tiktok or facebook, default tiktok
  -k, --keyword   Search keyword, required
  -n, --limit     Number of video results to extract, 10 or 100, default 100
  --chrome-profile Chrome profile name, label, or email to sync/use
  --headless      Run in headless mode, default is headed mode
  -o, --out       Output file prefix, optional
  -h, --help      Show this help
`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.keyword) {
    printHelp();
    process.exit(1);
  }

  const result = await searchByChannel(args);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  parseArgs,
  printHelp,
};

if (require.main === module) {
  run().catch(error => {
    console.error(JSON.stringify({
      ok: false,
      message: error.message,
    }, null, 2));
    process.exit(1);
  });
}
