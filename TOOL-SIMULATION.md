# Tool simulation against a ShadowClan mod — what it found

A harness that drives **every agent tool through the real MCP registry** against a
generated NeoForge project (`shadowclan_arsenal`, ShadowClan Arsenal, MC 1.20.4).
Not the helper functions — the tool handlers, invoked the way the agent invokes
them, with the result read the way the model reads it.

The project is deliberately realistic. It contains a shipped feature that must
survive (the armour set, `ShadowArmour`), public config keys that must not be
renamed, code that is already correct for its version (`FeatureGlow`), and exactly
one genuinely stale call (`ClanBanner.getOrCreateTag()`). A simulation containing
only broken code cannot tell whether the tools leave working code alone.

## Bugs the simulation found

### 1. `check_update_jar` could pass a jar from the *old* version

The tool read the target from `gradle.properties` — the very value an unfinished
update has not changed yet. So a jar built before the bump declared 1.20.4, the
target was read as 1.20.4, and the check passed on the one question it exists to
answer.

Worse, it was inconsistent with `plan_update`: the plan could say "you must reach
1.21.1" and the check would then validate against 1.20.4.

**Fixed** by making the intended target authoritative. `check_update_jar` now
accepts `mcVersion`/`loader`, and remembers the target from the last
`plan_update` so the two tools cannot disagree about what "finished" means. The
memory is cleared once that target is reached, so it cannot haunt a later check.
The automode stopping rule in `engine.ts` uses the same remembered target.

### 2. `launch_game` reported a start for a process that had already died

Two separate defects on the same path, both of which produced *"Dev client
starting. First launch compiles and downloads assets…"* for a wrapper that had
already exited:

- **No `error` listener.** `spawn` does not throw when a binary cannot be run; it
  emits an `error` event. With no listener that is an unhandled exception; with
  no listener at all the tool simply returned success.
- **It returned before the failure could be observed.** Waiting for `spawn` only
  proves a pid exists. A gradle wrapper with no JAVA_HOME prints its complaint and
  exits in milliseconds — well inside that window.

**Fixed** in both `launcher.ts` (dev client) and `client.ts` (instance launch):
an `error` listener, a short grace period after `spawn`, and a fast non-zero exit
treated as a failed launch. The message now quotes the process's own output:

```
The dev client could not be started: ERROR: JAVA_HOME is not set and
no 'java' command could be found in your PATH. Please set the JAVA_HOME
variable in your environment to match the location of your Java installation.
```

That came from reading the output buffer in memory rather than the log file,
because `appendFile` is asynchronous — reading the file the instant the process
exits raced the write and returned nothing, which is how the first attempt at this
fix still reported "it exited immediately" with no cause.

### 3. A process-level trap in the test itself

The generated project ships a real `gradlew`, so the launch test was not testing
"no wrapper" — it was running the wrapper. That is what surfaced bug 2, and it is
worth recording: a test that stubs the failure would have missed both defects.

## What worked, unchanged

| Tool | Against the ShadowClan mod |
|---|---|
| `project_info` | read id, name and version from the real project |
| `plan_update` | found both `getOrCreateTag()` call sites at lines 11 and 16 — verified against the file, not trusted from the output |
| `plan_update` | listed **only** `ClanBanner.java` as editable; explicitly excluded the armour set and config |
| `plan_update` | reported "change the build file and metadata only" after the fix |
| `api_reference` | answered for 1.21.1 with `DataComponents` |
| `list_api_concepts` | plain lines, not an object dump |
| `decompile_api` | explained itself with no sources jar present, no stack trace |
| `search_reference` | answered with an empty-but-explained result |
| `recall_mistakes` | "no similar past mistake on record" |
| `recommend_shaders`, `env_report`, `read_log` | readable, actionable |
| `install`, `launch_game` (instance) | refused clearly with no instance configured |

## The preservation check

After the whole update ran, the harness asserts the armour set and config are
**byte-for-byte untouched**:

```js
assert.match(armour, /registerSimpleItem\("shadow_helmet"\)/)
assert.match(cfg, /helmetDurability = 320/)
assert.match(cfg, /enableGlow = true/)
```

That is the acceptance criterion from the brief — "priority on keeping all
features and functions intact" — expressed as an assertion rather than a promise.

## Reproducing

```
node scripts/test.mjs
```

`tests/tool-simulation.test.mjs`, 26 checks. It generates the project with the
app's own `generateProject()`, calls the tools through the SDK's registry, and
writes a jar with `adm-zip` to exercise the completion check in both failing and
passing states. No network, no gradle, no JVM — a test that needs forty seconds of
Maven Central is a test nobody runs.
