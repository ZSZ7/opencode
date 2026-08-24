#!/usr/bin/env bun

import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const names = ["schema", "codemode", "ai", "util", "protocol", "client", "plugin", "core", "simulation", "server", "sdk"]
const temporary = await mkdtemp(join(tmpdir(), "opencode-sdk-package-"))
const archives = new Map<string, string>()

try {
  for (const name of names) {
    const directory = join(root, "packages", name)
    await $`bun run build`.cwd(directory)
    const original = await Bun.file(join(directory, "package.json")).text()
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- package manifests are validated by their package builds.
    const pkg = JSON.parse(original) as {
      name: string
      dependencies?: Record<string, string>
      exports?: Record<string, string | { import: string; types: string }>
      imports?: Record<string, Record<string, string>>
    }
    const archive = join(temporary, `${name}.tgz`)

    if (pkg.dependencies) {
      pkg.dependencies = Object.fromEntries(
        Object.entries(pkg.dependencies).map(([dependency, version]) => {
          const local = archives.get(dependency)
          return [dependency, local ? `file:${local}` : version]
        }),
      )
    }
    if (pkg.exports) {
      pkg.exports = Object.fromEntries(
        Object.entries(pkg.exports).map(([key, value]) => {
          if (typeof value !== "string") return [key, value]
          return [key, { import: output(name, value), types: output(name, value, true) }]
        }),
      )
    }
    if (pkg.imports) {
      pkg.imports = Object.fromEntries(
        Object.entries(pkg.imports).map(([key, conditions]) => [
          key,
          Object.fromEntries(
            Object.entries(conditions).map(([condition, value]) => [condition, output(name, value, condition === "types")]),
          ),
        ]),
      )
    }

    await Bun.write(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
    try {
      await $`bun pm pack --filename ${archive} --ignore-scripts --quiet`.cwd(directory)
    } finally {
      await Bun.write(join(directory, "package.json"), original)
    }
    archives.set(pkg.name, archive)
  }

  const consumer = join(temporary, "consumer")
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({ name: "opencode-sdk-consumer", private: true, type: "module" }),
  )
  await Promise.all([
    Bun.write(
      join(consumer, "node-import.mjs"),
      'await import("@opencode-ai/sdk")\nawait import("@opencode-ai/simulation/backend")\n',
    ),
    Bun.write(
      join(consumer, "consumer.ts"),
      `import { OpenCode, Tool } from "@opencode-ai/sdk"
import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd"

OpenCode.create satisfies Function
OpenCodeWorkerd.create satisfies Function
Tool.Error satisfies Function
`,
    ),
    Bun.write(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          lib: ["ES2022", "DOM", "ESNext.Disposable"],
        },
        include: ["consumer.ts"],
      }),
    ),
    Bun.write(
      join(consumer, "worker.js"),
      `import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd"
import { Effect } from "effect"

export class OpenCodeDO {
  constructor(state) {
    this.state = state
  }

  fetch() {
    const storage = this.state.storage
    return Effect.runPromise(
      Effect.gen(function* () {
        const sdk = yield* OpenCodeWorkerd.create({
          storage,
          app: { version: "packed-workerd" },
          config: { content: "{}" },
        })
        return Response.json(yield* sdk.server.health.get())
      }).pipe(Effect.scoped),
    )
  }
}

export default {
  fetch(request, env) {
    return env.OPENCODE.get(env.OPENCODE.idFromName("packed-consumer")).fetch(request)
  },
}
`,
    ),
    Bun.write(
      join(consumer, "boot.mjs"),
      `import { Miniflare } from "miniflare"

const miniflare = new Miniflare({
  compatibilityDate: "2026-08-23",
  compatibilityFlags: ["nodejs_compat"],
  modules: true,
  scriptPath: new URL("./dist/worker.js", import.meta.url).pathname,
  durableObjects: { OPENCODE: { className: "OpenCodeDO", useSQLite: true } },
})

try {
  const response = await miniflare.dispatchFetch("http://opencode.local/health")
  if (response.status !== 200) throw new Error(
    "Packed workerd health returned " + response.status + ": " + await response.text(),
  )
  const body = await response.json()
  if (body.healthy !== true || body.version !== "packed-workerd") {
    throw new Error("Unexpected packed workerd health: " + JSON.stringify(body))
  }
} finally {
  await miniflare.dispose()
}
`,
    ),
  ])

  const sdk = archives.get("@opencode-ai/sdk")
  if (!sdk) throw new Error("Packed SDK archive was not created")
  await $`npm install --ignore-scripts --no-audit --no-fund --package-lock=false ${sdk} miniflare@4.20260708.1 typescript@5.8.2`.cwd(consumer)
  await $`node node-import.mjs`.cwd(consumer)
  await $`node_modules/.bin/tsc --noEmit`.cwd(consumer)

  const result = await Bun.build({
    entrypoints: [join(consumer, "worker.js")],
    conditions: ["workerd"],
    target: "browser",
    format: "esm",
    outdir: join(consumer, "dist"),
    sourcemap: "none",
    throw: false,
  })
  if (!result.success) throw new AggregateError(result.logs, "Failed to bundle packed SDK for workerd")

  const transpiler = new Bun.Transpiler({ loader: "js" })
  const leaked = (await Promise.all(result.outputs.map((artifact) => artifact.text())))
    .flatMap((source) => [
      ...transpiler.scanImports(source)
        .filter((imported) => imported.kind !== "dynamic-import")
        .map((imported) => imported.path),
      ...Array.from(source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g), (match) => match[1]),
    ])
    .filter((specifier) => specifier === "bun" || specifier.startsWith("bun:"))
  if (leaked.length > 0) throw new Error(`Packed workerd bundle statically imports Bun builtins: ${leaked.join(", ")}`)

  await $`node boot.mjs`.cwd(consumer)
  console.log("packed SDK consumer OK")
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function output(name: string, value: string, types = false) {
  const root = name === "core" && types ? "./dist/types/" : "./dist/"
  return value.replace("./src/", root).replace(/\.ts$/, types ? ".d.ts" : ".js")
}
