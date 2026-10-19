// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { isOfficialPiCommand, PI_NPM_PACKAGE, piMaintenance } from "./maintenance.ts";

const PI = ProviderDriverKind.make("pi");
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Pi maintenance resolution should not spawn a process here"),
);
const noHttp = HttpClient.make(() => Effect.die("Pi maintenance should not fetch from npm here"));

const scopedTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-maintenance-" });
  return NodeFS.realpathSync(directory);
});

function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
}

function link(target: string, path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.symlinkSync(target, path);
  return path;
}

const resolve = (binaryPath: string) =>
  resolveProviderMaintenanceCapabilitiesEffect(piMaintenance, {
    binaryPath,
    env: { PATH: "" },
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

const installedPi = (version: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make("aside-code"),
  driver: PI,
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-19T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

it.layer(NodeServices.layer)("piMaintenance", (it) => {
  it("recognizes the official CLI by name or by its npm package", () => {
    const official = (resolvedCommandPath: string, realCommandPath = resolvedCommandPath) =>
      isOfficialPiCommand({ resolvedCommandPath, realCommandPath });
    assert.isTrue(official("/Users/me/.local/bin/pi"));
    assert.isTrue(official("C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd"));
    assert.isTrue(official("C:\\Users\\me\\.pi\\bin\\pi.exe"));
    assert.isTrue(
      official(
        "/opt/homebrew/bin/pi-agent",
        `/opt/homebrew/lib/node_modules/${PI_NPM_PACKAGE}/dist/cli.js`,
      ),
    );
    assert.isFalse(official("/Users/me/.local/bin/aside-code"));
    assert.isFalse(official("/Users/me/pi/bin/aside", "/Users/me/pi/bin/aside"));
    assert.isFalse(official("/usr/local/bin/pip"));
    assert.isFalse(
      official(
        "/usr/local/bin/aside-code",
        "/usr/local/lib/node_modules/@aside/coding-agent/dist/cli.js",
      ),
    );
  });

  it.effect.skipIf(windowsHost || !symlinksSupported)(
    "reports no package, latest version, or update for a custom binary",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* scopedTempDir;
        const fork = NodePath.join(tempDir, "Dev", "Aside", "aside-code", "bin", "aside-code");
        writeExecutable(fork);
        const binaryPath = link(fork, NodePath.join(tempDir, ".local", "bin", "aside-code"));

        const capabilities = yield* resolve(binaryPath);
        assert.deepEqual(capabilities, { provider: PI, packageName: null, update: null });

        // Pi's own release must never be compared against the fork's version.
        const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
          installedPi("0.87.1"),
          capabilities,
          { enableProviderUpdateChecks: true },
        ).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([[PI_NPM_PACKAGE, "1.2.0"]]),
          ),
          Effect.provideService(HttpClient.HttpClient, noHttp),
        );
        assert.include(enriched.versionAdvisory, {
          status: "unknown",
          currentVersion: "0.87.1",
          latestVersion: null,
          updateCommand: null,
          canUpdate: false,
          canInstallVersion: false,
          message: null,
        });
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost || !symlinksSupported)(
    "treats a fork installed from its own npm package as custom",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* scopedTempDir;
        const cli = NodePath.join(
          tempDir,
          "lib",
          "node_modules",
          "@aside",
          "coding-agent",
          "cli.js",
        );
        writeExecutable(cli);
        const capabilities = yield* resolve(link(cli, NodePath.join(tempDir, "bin", "aside-code")));
        assert.deepEqual(capabilities, { provider: PI, packageName: null, update: null });
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("keeps the official pi binary's self-update", () =>
    Effect.gen(function* () {
      const tempDir = yield* scopedTempDir;
      const binaryPath = NodePath.join(tempDir, ".pi", "bin", "pi");
      writeExecutable(binaryPath);

      const capabilities = yield* resolve(binaryPath);
      assert.equal(capabilities.packageName, PI_NPM_PACKAGE);
      assert.deepEqual(capabilities.update, {
        command: `${binaryPath} update --self`,
        executable: binaryPath,
        args: ["update", "--self"],
        lockKey: "pi-native",
      });

      const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
        installedPi("0.87.1"),
        capabilities,
        { enableProviderUpdateChecks: true },
      ).pipe(
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([[PI_NPM_PACKAGE, "1.2.0"]]),
        ),
        Effect.provideService(HttpClient.HttpClient, noHttp),
      );
      assert.include(enriched.versionAdvisory, {
        status: "behind_latest",
        latestVersion: "1.2.0",
        updateCommand: `${binaryPath} update --self`,
        canUpdate: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost || !symlinksSupported)(
    "keeps npm ownership for a renamed link into the official package",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* scopedTempDir;
        const cli = NodePath.join(
          tempDir,
          "lib",
          "node_modules",
          ...PI_NPM_PACKAGE.split("/"),
          "dist",
          "cli.js",
        );
        writeExecutable(cli);
        const capabilities = yield* resolve(link(cli, NodePath.join(tempDir, "bin", "pi-agent")));
        assert.equal(capabilities.packageName, PI_NPM_PACKAGE);
        assert.equal(capabilities.update?.executable, "npm");
        assert.include(capabilities.update?.args ?? [], `${PI_NPM_PACKAGE}@latest`);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the npm package when the binary cannot be resolved", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolve("definitely-not-on-path-pi-fork");
      assert.deepEqual(capabilities, { provider: PI, packageName: PI_NPM_PACKAGE, update: null });
    }),
  );
});
