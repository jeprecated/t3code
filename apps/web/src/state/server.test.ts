import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type KeybindingRule,
  type NewThreadPreset,
  type ServerConfig,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { createLocalEnvironmentIdAtom, primaryEnvironmentIdAtom } from "./primaryEnvironment";
import {
  createNewThreadPresetsAtom,
  createShortcutKeybindingsAtom,
  primaryRelayTracingAllowedAtom,
  serverEnvironment,
} from "./server";
import { environmentSession } from "./session";

const PRIMARY = EnvironmentId.make("primary");
const A = EnvironmentId.make("a");
const B = EnvironmentId.make("b");

// The reporter's swap: Cmd+N opens a local thread instead of a regular one.
const SWAPPED: KeybindingRule[] = [{ key: "mod+n", command: "chat.newLocal" }];
const STALE: KeybindingRule[] = [{ key: "mod+n", command: "chat.newWithoutProject" }];

function config(rules: readonly KeybindingRule[], relayTracingAllowed?: boolean) {
  return {
    keybindings: compileResolvedKeybindingsConfig(rules),
    providers: [],
    observability: { relayTracingAllowed },
  } as unknown as ServerConfig;
}

function environment(phase: EnvironmentConnectionPhase, serverConfig: ServerConfig | null) {
  return { connection: { phase, error: null, traceId: null }, serverConfig };
}

type Environment = ReturnType<typeof environment>;

function makeHarness(input: {
  primaryEnvironmentId?: EnvironmentId | null;
  primaryConfig?: ServerConfig | null;
  environments?: ReadonlyArray<readonly [EnvironmentId, Environment]>;
}) {
  const primaryEnvironmentIdAtom = Atom.make(input.primaryEnvironmentId ?? null);
  const primaryConfigAtom = Atom.make(input.primaryConfig ?? null);
  const environmentsAtom = Atom.make<ReadonlyMap<EnvironmentId, Environment>>(
    new Map(input.environments ?? []),
  );
  const keybindingsAtom = createShortcutKeybindingsAtom({
    primaryEnvironmentIdAtom,
    primaryConfigAtom,
    environmentsAtom,
  });
  const registry = AtomRegistry.make();
  registries.push(registry);
  // Keep the atom mounted, like the shortcut handlers do.
  registry.subscribe(keybindingsAtom, () => {});
  return {
    registry,
    primaryEnvironmentIdAtom,
    primaryConfigAtom,
    environmentsAtom,
    keybindings: () => registry.get(keybindingsAtom),
    cmdN: () =>
      resolveShortcutCommand(
        { key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        registry.get(keybindingsAtom),
        { platform: "MacIntel" },
      ),
  };
}

const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe("createShortcutKeybindingsAtom", () => {
  it("updates shortcuts from the first connected, configured environment without a primary", () => {
    const harness = makeHarness({});
    const aConfig = config(STALE);
    const bConfig = config(SWAPPED);
    const edited = config([{ key: "mod+n", command: "sidebar.toggle" }]);
    expect(harness.cmdN()).toBe("chat.new");

    // One mounted consumer follows config loading, edits, disconnects and reconnects.
    for (const [a, b, command] of [
      [environment("offline", aConfig), environment("connected", bConfig), "chat.newLocal"],
      [environment("connected", null), environment("connected", bConfig), "chat.newLocal"],
      [
        environment("connected", aConfig),
        environment("connected", bConfig),
        "chat.newWithoutProject",
      ],
      [environment("connected", edited), environment("connected", bConfig), "sidebar.toggle"],
      [environment("offline", edited), environment("connected", bConfig), "chat.newLocal"],
      [environment("offline", edited), environment("offline", bConfig), "chat.new"],
      [environment("reconnecting", edited), environment("offline", bConfig), "chat.new"],
      [
        environment("connected", aConfig),
        environment("offline", bConfig),
        "chat.newWithoutProject",
      ],
    ] as const) {
      harness.registry.set(
        harness.environmentsAtom,
        new Map([
          [A, a],
          [B, b],
        ]),
      );
      expect(harness.cmdN()).toBe(command);
    }
  });

  it("uses the primary config or defaults until the primary is removed", () => {
    const harness = makeHarness({
      environments: [[B, environment("connected", config(SWAPPED))]],
    });
    expect(harness.cmdN()).toBe("chat.newLocal");

    harness.registry.set(harness.primaryEnvironmentIdAtom, PRIMARY);
    expect(harness.cmdN()).toBe("chat.new");

    harness.registry.set(harness.primaryConfigAtom, config(STALE));
    expect(harness.cmdN()).toBe("chat.newWithoutProject");

    harness.registry.set(harness.primaryConfigAtom, null);
    expect(harness.cmdN()).toBe("chat.new");

    harness.registry.set(harness.primaryEnvironmentIdAtom, null);
    expect(harness.cmdN()).toBe("chat.newLocal");
  });
});

it("clears relay tracing permission when the primary session ends", () => {
  const allowed = config([], true);
  const sessionConfig = Atom.make<ServerConfig | null>(allowed);
  using _session = vi
    .spyOn(environmentSession, "initialConfigValueAtom")
    .mockReturnValue(sessionConfig);
  // The previous session's config stream can retain its last live value across disconnect.
  const lastProjection = serverEnvironment.configProjection({ environmentId: PRIMARY, input: {} });
  const registry = AtomRegistry.make({
    initialValues: [
      [primaryEnvironmentIdAtom, PRIMARY],
      [
        lastProjection,
        AsyncResult.success({
          config: allowed,
          latestEvent: { type: "snapshot", config: allowed },
          source: "live",
        }),
      ],
    ],
  });
  registries.push(registry);
  const answers: Array<boolean | null> = [];
  registry.subscribe(primaryRelayTracingAllowedAtom, (answer) => answers.push(answer), {
    immediate: true,
  });

  registry.set(sessionConfig, null);
  registry.set(sessionConfig, config([], false));

  expect(answers).toEqual([true, null, false]);
});

describe("createNewThreadPresetsAtom", () => {
  const SERVICE = EnvironmentId.make("service");
  const preset = (id: string) =>
    ({
      id,
      name: id,
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      project: "none",
    }) as unknown as NewThreadPreset;
  const presetsConfig = (presets: ReadonlyArray<NewThreadPreset>) =>
    ({ settings: { newThreadPresets: presets } }) as unknown as ServerConfig;

  it("reads presets from this machine's service when the app has no primary", () => {
    const configAtoms = new Map([
      [PRIMARY, Atom.make<ServerConfig | null>(presetsConfig([preset("primary")]))],
      [SERVICE, Atom.make<ServerConfig | null>(presetsConfig([preset("service")]))],
      [A, Atom.make<ServerConfig | null>(presetsConfig([preset("remote")]))],
    ]);
    const primaryEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null);
    const catalogValueAtom = Atom.make<{ entries: ReadonlyMap<EnvironmentId, unknown> }>({
      entries: new Map([
        [A, null],
        [SERVICE, null],
      ]),
    });
    const presetsAtom = createNewThreadPresetsAtom({
      environmentIdAtom: createLocalEnvironmentIdAtom({
        primaryEnvironmentIdAtom,
        hostEnvironmentIdAtom: Atom.make<string | null>("service"),
        catalogValueAtom,
      }),
      configValueAtom: (environmentId) => configAtoms.get(environmentId) ?? Atom.make(null),
    });
    const registry = AtomRegistry.make();
    registries.push(registry);
    registry.subscribe(presetsAtom, () => {});
    const presetIds = () => registry.get(presetsAtom).map((candidate) => candidate.id);

    expect(presetIds()).toEqual(["service"]);

    registry.set(primaryEnvironmentIdAtom, PRIMARY);
    expect(presetIds()).toEqual(["primary"]);

    registry.set(primaryEnvironmentIdAtom, null);
    registry.set(catalogValueAtom, { entries: new Map([[A, null]]) });
    expect(presetIds()).toEqual([]);
  });
});
