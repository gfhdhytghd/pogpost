// flock owns the kernel lease. Parent death closes stdin, even after SIGKILL.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
process.stdout.write("locked\n");
