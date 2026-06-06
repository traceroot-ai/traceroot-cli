import { execSync } from "node:child_process";

export default function setup(): void {
  execSync("npm run build", { stdio: "inherit" });
}
