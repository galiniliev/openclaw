import { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { resolveGatewayCommandPath } from "./gateway-run-argv.js";
import { hasJsonOutputFlag } from "./json-output-mode.js";
import { isCommanderParseExit, normalizeRootNoColorArgvForProgram } from "./run-main-options.js";
import { isGatewayRunFastPathArgv } from "./run-main-policy.js";
import type { createGatewayDispatchStartupTrace } from "./startup-trace.js";

export async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayDispatchStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    return false;
  }
  if (argv.some((arg) => arg === "--rolling-standby" || arg.startsWith("--rolling-standby="))) {
    if (argv.some((arg) => ["--force", "--reset", "--dev", "--update-canary"].includes(arg))) {
      throw new Error(
        "Gateway rolling standby cannot perform destructive startup or another lifecycle mode",
      );
    }
    const option = (name: string) => {
      const index = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
      if (index < 0) {
        return undefined;
      }
      const token = argv[index]!;
      return token === name ? argv[index + 1] : token.slice(name.length + 1);
    };
    const releaseId = option("--rolling-standby");
    const contractPath = option("--rolling-contract");
    const port = Number(option("--port") ?? process.env.OPENCLAW_GATEWAY_PORT ?? "18789");
    if (!releaseId || !contractPath) {
      throw new Error("Gateway rolling standby requires its release and private contract");
    }
    await (
      await import("./gateway-cli/rolling-candidate.js")
    ).runGatewayRollingCandidateCommand({ releaseId, contractPath, port });
    return true;
  }
  const [
    { Command },
    { addGatewayRunCommand, bootstrapGatewayRun },
    { VERSION },
    { emitCliBanner },
    { defaultRuntime },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run-command.js"),
      import("../version.js"),
      import("./banner.js"),
      import("../runtime.js"),
    ]),
  );
  const commandPath = resolveGatewayCommandPath(argv) ?? ["gateway"];
  const startupPolicy = resolveCliStartupPolicy({
    argv,
    commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
  });
  if (!startupPolicy.hideBanner) {
    emitCliBanner(VERSION, { argv });
  }
  const program = new Command();
  program.name("openclaw");
  program.enablePositionalOptions();
  program.option("--no-color", "Disable ANSI colors", false);
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const beforeRun = (opts: { force?: boolean; reset?: boolean }) =>
    bootstrapGatewayRun({
      opts,
      runtime: defaultRuntime,
      commandPath,
      startupPolicy,
      startupTrace,
    });
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
    { beforeRun },
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
    { beforeRun },
  );
  const parseArgv = normalizeRootNoColorArgvForProgram(argv, program);
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(parseArgv), {
      timeline: false,
    });
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}
