const c = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const t = c.randomBytes(24).toString("hex");
const h = c.createHash("sha256").update(t).digest("hex");

fs.writeFileSync(".admin_token.txt", t);

const sqlPath = path.join(__dirname, ".admin_token_insert.sql");
fs.writeFileSync(
  sqlPath,
  `INSERT INTO admin_tokens (token_hash, label) VALUES ('${h}', 'week4-testing');\n`
);

const isWindows = process.platform === "win32";
try {
  execFileSync(
    isWindows ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", "arena-db", "--remote", "--file", sqlPath],
    { stdio: "inherit", shell: isWindows }
  );
  console.log("Done - token saved to .admin_token.txt");
} finally {
  fs.unlinkSync(sqlPath);
}
