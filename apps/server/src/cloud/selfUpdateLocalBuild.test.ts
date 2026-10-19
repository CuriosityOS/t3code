import { expect, it } from "@effect/vitest";

import { isLocalBuildVersion, resolveServerSelfUpdateCapability } from "./selfUpdate.ts";

it("recognizes a locally patched build by its prerelease", () => {
  expect(isLocalBuildVersion("0.1.1-nightly.20261019.3348.local.1")).toBe(true);
  expect(isLocalBuildVersion("0.1.1-local")).toBe(true);
  expect(isLocalBuildVersion("0.1.1-nightly.20261019.3348")).toBe(false);
  expect(isLocalBuildVersion("0.1.1-nightly.20261019.3348+local")).toBe(false);
  expect(isLocalBuildVersion("0.1.1-localhost.1")).toBe(false);
  expect(isLocalBuildVersion("1.2.0")).toBe(false);
});

it("offers no self-update to a locally patched boot-service server", () => {
  expect(resolveServerSelfUpdateCapability({ desktopManaged: false, launcherManaged: true })).toBe(
    "boot-service",
  );
  expect(
    resolveServerSelfUpdateCapability({
      desktopManaged: false,
      launcherManaged: true,
      localBuild: true,
    }),
  ).toBeNull();
  expect(
    resolveServerSelfUpdateCapability({
      desktopManaged: true,
      launcherManaged: false,
      localBuild: true,
    }),
  ).toBe("desktop-managed");
});
