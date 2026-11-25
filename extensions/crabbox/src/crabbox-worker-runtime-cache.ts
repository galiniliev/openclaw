/** Lease-owned runtime cache preparation and post-activation cleanup; never state/workspaces. */
export const CRABBOX_NODE_RUNTIME_CACHE_SOURCE = `
  // Forks of a warm image load disk blocks lazily on first read, so a cold node start
  // spends ~30 s on serial reads. A boot-time parallel read of the current runtime
  // overlaps that with SSH readiness. Best effort: images without cron keep the cold start.
  // Only a Crabbox run on this lease edits the crontab; local executions (tests) never do.
  const installRuntimePrefetch = () => {
    if (!leaseId || process.platform !== "linux" || process.env.CRABBOX_LEASE_ID !== leaseId) return;
    try {
      const script = path.join(runtimeRoot, ".prefetch.sh");
      const nodeDir = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
      fs.writeFileSync(path.join(runtimeRoot, ".prefetch"), runtimeDir + "\\n" + nodeDir + "\\n");
      fs.writeFileSync(script, '#!/bin/sh\\ncd "$(dirname "$0")" || exit 0\\ndate +%s.%N > .prefetch.log\\nwhile IFS= read -r dir; do find "$dir" -type f -print0; done < .prefetch | xargs -0 -n 64 -P 64 cat > /dev/null 2>&1\\ndate +%s.%N >> .prefetch.log\\n', { mode: 0o700 });
      const current = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 10000 });
      const kept = (current.status === 0 ? current.stdout : "").split("\\n").filter((line) => line && !line.includes(script));
      spawnSync("crontab", ["-"], { input: [...kept, "@reboot /bin/sh " + script].join("\\n") + "\\n", timeout: 10000 });
    } catch { /* Prefetch is optional; failed setup keeps the ordinary cold-start path. */ }
  };
  const pruneNodeRuntimeCache = (previousRuntimeDir) => {
    if (process.platform !== "linux" || mode !== "resume" || !previousRuntimeDir || previousRuntimeDir === runtimeDir) return;
    const warn = (error) => console.error("Cloud worker runtime cache cleanup skipped (" + (error.code || "unknown") + ")");
    try {
      if (fs.realpathSync(runtimeRoot) !== runtimeRoot) throw new Error("Runtime cache root changed");
      const ownerUid = fs.statSync(runtimeRoot).uid;
      const keep = new Set([runtimeDir, previousRuntimeDir]);
      const leases = path.join(home, ".openclaw", "cloud-workers");
      for (const entry of fs.readdirSync(leases, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try { keep.add(fs.realpathSync(path.join(leases, entry.name, "runtime"))); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      // These private caches can also have a still-running predecessor while its pointer changes.
      for (const pid of fs.readdirSync("/proc")) {
        if (!/^[1-9][0-9]*$/.test(pid)) continue;
        try {
          if (fs.statSync(path.join("/proc", pid)).uid !== ownerUid) continue;
          try {
            const cwd = fs.realpathSync(path.join("/proc", pid, "cwd"));
            if (path.dirname(cwd) === runtimeRoot) keep.add(cwd);
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          // A CLI can keep its package in argv while running from a workspace; process.title
          // can instead rewrite argv, in which case the launch owner's cwd remains decisive.
          const args = fs.readFileSync(path.join("/proc", pid, "cmdline"), "utf8").split("\\0");
          for (const argument of args) {
            const relative = path.relative(runtimeRoot, argument);
            const digest = relative.split(path.sep)[0];
            if (path.isAbsolute(argument) && /^[a-f0-9]{64}$/.test(digest)) keep.add(path.join(runtimeRoot, digest));
          }
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
      }
      let removed = 0;
      for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory()) continue;
        const directory = path.join(runtimeRoot, entry.name);
        if (keep.has(directory)) continue;
        const packageRoot = path.join(directory, "node_modules", "openclaw");
        try {
          // Leave links, incomplete preparations, npm installs and unknown directory contents alone.
          if (fs.realpathSync(packageRoot) !== packageRoot || fs.statSync(directory).uid !== ownerUid) continue;
          if (!["package.json", "node-runtime.json", "node-runtime.manifest.json"].every((name) => fs.lstatSync(path.join(packageRoot, name)).isFile())) continue;
          const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
          const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "node-runtime.json"), "utf8"));
          if (manifest.name !== "openclaw" || typeof metadata.buildId !== "string" || !metadata.buildId || (metadata.install ?? "bundle") !== "bundle") continue;
          fs.rmSync(directory, { recursive: true });
          removed++;
        } catch (error) {
          if (error.code !== "ENOENT") warn(error);
        }
      }
      console.error("Cloud worker runtime cache cleanup: removed " + removed + " unused runtimes");
    } catch (error) { warn(error); }
  };
`;
